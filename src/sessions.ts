// Giữ các session Claude Code đang chạy trên máy này qua Agent SDK.
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { toBlocks, toChatMessage, toCommandInfo } from './normalize.ts';
import type {
  Attachment,
  ContextInfo,
  Effort,
  LiveState,
  PermissionAsk,
  ServerEvent,
  SessionMeta,
  SlashCommandInfo,
  UiPermissionMode,
} from './protocol.ts';

type Emit = (e: ServerEvent) => void;
type UserContent = SDKUserMessage['message']['content'];

// Tool ClaudeMon cấp cho mọi session: gửi ảnh, video, tệp cho người dùng xem ngay trong khung chat (kể cả trên
// điện thoại), thay cho SendUserFile vốn chỉ có trong app Claude. Giao diện vẽ tool này như SendUserFile
// (normalize.ts); agent chỉ phục vụ tệp có tên trong lịch sử session.
export const SEND_FILE_TOOL = 'mcp__claudemon__send_user_file';
export const CHECKLIST_TOOLS = ['mcp__claudemon__checklist_get', 'mcp__claudemon__checklist_report'];

// Checklist verify (vd trước khi release): agent.ts cắm vào để tool đọc và ghi lượt chạy trong library.
export interface ChecklistHooks {
  get(run: string): string;
  report(run: string, results: { item: string; result: 'pass' | 'fail' | 'skip'; note?: string }[], session: string): string;
}
let checklistHooks: ChecklistHooks | undefined;
export const setChecklistHooks = (h: ChecklistHooks) => (checklistHooks = h);

const textResult = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

function claudemonServer(cwd: string, sessionId: string) {
  return createSdkMcpServer({
    name: 'claudemon',
    version: '1.0.0',
    instructions:
      'Người dùng đang xem session qua ClaudeMon, thường từ điện thoại hoặc máy khác, nên không mở được tệp trên máy này. ' +
      'Khi cần cho người dùng xem ảnh (ảnh chụp màn hình, ảnh trước/sau, biểu đồ), video hay tệp, gọi send_user_file với ' +
      'đường dẫn tệp: tệp hiện ngay trong khung chat. Báo cáo HTML cũng gửi bằng send_user_file: người dùng xem ngay trong ' +
      'ClaudeMon hoặc mở bằng trình duyệt (ảnh, css, js để cùng thư mục hoặc thư mục con của tệp HTML, gọi bằng đường dẫn tương đối). ' +
      'Đừng mở tệp bằng chương trình trên máy thay cho việc này. ' +
      'Khi được nhờ verify một checklist của ClaudeMon (có mã lượt chạy), đọc các mục bằng checklist_get rồi kiểm xong mục nào ' +
      'báo ngay mục đó bằng checklist_report, để người dùng thấy tiến độ trong trang checklist.',
    tools: [
      tool(
        'send_user_file',
        'Gửi ảnh, video hoặc tệp trên máy này cho người dùng; ảnh và video hiện ngay trong khung chat, tệp HTML xem được ngay trong app, tệp khác thành link tải. ' +
          'Gửi nhiều tệp một lần thì truyền hết vào files, theo thứ tự muốn hiện.',
        {
          files: z.array(z.string()).min(1).describe('Đường dẫn tệp, tuyệt đối hoặc tương đối với thư mục làm việc'),
          caption: z.string().optional().describe('Chú thích ngắn hiện kèm'),
        },
        async ({ files }) => {
          const missing = files.filter((f) => {
            const p = isAbsolute(f) ? f : resolve(cwd, f);
            return !existsSync(p) || !statSync(p).isFile();
          });
          if (missing.length)
            return { content: [{ type: 'text', text: `Không thấy tệp: ${missing.join(', ')}` }], isError: missing.length === files.length };
          return { content: [{ type: 'text', text: `Đã gửi ${files.length} tệp cho người dùng.` }] };
        },
      ),
      tool(
        'checklist_get',
        'Đọc một lượt chạy checklist của ClaudeMon: tên, phiên bản, hướng dẫn và từng mục (id, nội dung, kết quả hiện có).',
        { run: z.string().describe('Mã lượt chạy checklist') },
        async ({ run }) => {
          if (!checklistHooks) return textResult('Agent ClaudeMon chưa sẵn sàng.', true);
          try {
            return textResult(checklistHooks.get(run));
          } catch (e) {
            return textResult((e as Error).message, true);
          }
        },
      ),
      tool(
        'checklist_report',
        'Ghi kết quả kiểm cho một hay nhiều mục của lượt chạy checklist. result: pass (đạt), fail (lỗi), skip (không tự kiểm được, ' +
          'cần người kiểm). note: bằng chứng ngắn (lệnh đã chạy, tệp:dòng, số liệu) hoặc lý do lỗi / bỏ qua.',
        {
          run: z.string().describe('Mã lượt chạy checklist'),
          results: z
            .array(z.object({ item: z.string().describe('id của mục'), result: z.enum(['pass', 'fail', 'skip']), note: z.string().optional() }))
            .min(1),
        },
        async ({ run, results }) => {
          if (!checklistHooks) return textResult('Agent ClaudeMon chưa sẵn sàng.', true);
          try {
            return textResult(checklistHooks.report(run, results, sessionId));
          } catch (e) {
            return textResult((e as Error).message, true);
          }
        },
      ),
    ],
  });
}

// Dùng đúng bản `claude` đã cài (và đăng nhập) trên máy; không có thì để SDK dùng bản đi kèm.
export const CLAUDE_PATH = Bun.which('claude') ?? undefined;

// Ảnh Claude đọc được trực tiếp; định dạng khác lưu ra đĩa rồi báo đường dẫn để Claude tự mở.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Hàng đợi tin nhắn người dùng cho chế độ streaming input của SDK.
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(content: UserContent) {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    };
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: msg, done: false });
    } else this.items.push(msg);
  }

  close() {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

interface Pending {
  ask: PermissionAsk;
  suggestions?: PermissionUpdate[];
  resolve: (r: PermissionResult) => void;
}

export interface Decision {
  allow: boolean;
  always?: boolean;
  answers?: Record<string, string>;
  message?: string;
}

// Mức dùng context ước tính từ usage của một lượt trả lời (khi không hỏi được Claude Code).
export function contextFromUsage(usage: any, model?: string): ContextInfo | undefined {
  if (!usage) return undefined;
  const used =
    (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
  if (!used) return undefined;
  const max = guessContextWindow(model);
  return { used, max, percent: Math.min(100, Math.round((used / max) * 1000) / 10), estimated: true };
}

// Các dòng model hiện tại có cửa sổ 1M; model cũ hơn 200K. Chỉ dùng khi chưa hỏi được con số thật.
function guessContextWindow(model?: string) {
  return model && /(opus|sonnet|fable|mythos|haiku)-(5|4-[6-9])/.test(model) ? 1_000_000 : 200_000;
}

// Đưa văn bản + tệp đính kèm thành nội dung một tin người dùng.
function buildContent(sessionId: string, text: string, attachments: Attachment[]): UserContent {
  if (!attachments.length) return text;
  const blocks: any[] = [];
  const saved: string[] = [];
  for (const a of attachments) {
    if (IMAGE_TYPES.has(a.type)) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.type, data: a.data } });
    } else {
      const dir = join(tmpdir(), 'claudemon-uploads', sessionId);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${Date.now()}-${basename(a.name).replace(/[^\p{L}\p{N}._-]+/gu, '_')}`);
      Bun.write(path, Buffer.from(a.data, 'base64'));
      saved.push(path);
    }
  }
  const note = saved.length ? `\n\n[Tệp đính kèm, đã lưu trên máy này: ${saved.join(', ')}]` : '';
  if (text || note) blocks.push({ type: 'text', text: (text + note).trim() });
  return blocks;
}

export class LiveSession {
  state: LiveState = 'idle';
  live = true;
  model?: string;
  effort?: Effort;
  mode: UiPermissionMode;
  lastUsage?: any;
  // Lượt đang chạy bắt đầu lúc nào; hết lượt thì xoá.
  turnStartedAt?: number;
  // Claude Code có báo session_state_changed không (bật bằng CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).
  // Có thì đó là nguồn trạng thái duy nhất; không thì đoán theo số tin gửi và số result (kém chính xác).
  private stateEvents = false;
  // Chỉ dùng khi không có stateEvents: số tin đã gửi mà chưa có result.
  private queued = 0;
  private queue = new InputQueue();
  private q: Query;
  private pending = new Map<string, Pending>();
  private stderrTail: string[] = [];

  constructor(
    readonly id: string,
    readonly cwd: string,
    opts: { resume: boolean; mode: UiPermissionMode; model?: string; effort?: Effort },
    private emit: Emit,
    private onEnd: (s: LiveSession) => void,
  ) {
    this.model = opts.model;
    this.effort = opts.effort;
    this.mode = opts.mode;
    this.q = query({
      prompt: this.queue,
      options: {
        cwd,
        ...(opts.resume ? { resume: id } : { sessionId: id }),
        permissionMode: opts.mode,
        // Cho phép chọn Bypass permissions (lúc mở hoặc đổi giữa chừng); chỉ chủ tài khoản điều khiển được agent.
        allowDangerouslySkipPermissions: true,
        model: opts.model,
        effort: opts.effort,
        includePartialMessages: true,
        canUseTool: this.canUseTool,
        mcpServers: { claudemon: claudemonServer(cwd, id) },
        // Tool của ClaudeMon chỉ gửi tệp hay ghi kết quả checklist, không đụng máy: khỏi hỏi quyền.
        allowedTools: [SEND_FILE_TOOL, ...CHECKLIST_TOOLS],
        pathToClaudeCodeExecutable: CLAUDE_PATH,
        // Không bật thì Claude Code không báo session_state_changed. Thiếu nó, trạng thái chỉ đoán được qua result,
        // mà vài tin gửi lúc đang chạy bị gộp thành một lượt (một result) và lệnh chạy nền xong tự mở lượt mới
        // (không có tin gửi): giao diện báo đang chạy khi đã xong, hoặc báo đang mở khi đang chạy.
        env: { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
        stderr: (d) => {
          this.stderrTail.push(d);
          if (this.stderrTail.length > 20) this.stderrTail.shift();
        },
      },
    });
    void this.pump();
  }

  get pendingAsks(): PermissionAsk[] {
    return [...this.pending.values()].map((p) => p.ask);
  }

  meta(): SessionMeta {
    return { model: this.model, effort: this.effort, mode: this.mode, context: contextFromUsage(this.lastUsage, this.model) };
  }

  // clientId: id tin do trình duyệt gửi đặt sẵn, để chính trình duyệt đó bỏ qua bản phát lại.
  send(text: string, clientId?: string, attachments: Attachment[] = []) {
    const at = Date.now();
    this.queued++;
    if (!this.turnStartedAt) this.turnStartedAt = at;
    this.setState('running', true);
    const content = buildContent(this.id, text, attachments);
    this.queue.push(content);
    // Phát lại cho mọi thiết bị đang xem session này, không chỉ thiết bị vừa gửi.
    this.emit({
      type: 'message',
      sessionId: this.id,
      message: { id: clientId || crypto.randomUUID(), role: 'user', blocks: toBlocks(content, this.cwd), at },
    });
  }

  async interrupt() {
    await this.q.interrupt();
  }

  async setMode(mode: UiPermissionMode) {
    await this.q.setPermissionMode(mode);
    this.mode = mode;
    this.emitMeta();
  }

  async setModel(model: string) {
    await this.q.setModel(model);
    this.model = model;
    this.emitMeta();
  }

  async setEffort(effort: Effort) {
    await this.q.applyFlagSettings({ effortLevel: effort });
    this.effort = effort;
    this.emitMeta();
  }

  async commands(): Promise<SlashCommandInfo[]> {
    const list = await this.q.supportedCommands();
    return list.map(toCommandInfo);
  }

  // Bảng chi tiết như lệnh /context của Claude Code.
  async contextUsage(): Promise<ContextInfo | undefined> {
    try {
      const r = await this.q.getContextUsage({ detail: 'full' });
      return {
        used: r.totalTokens,
        max: r.maxTokens,
        percent: Math.round(r.percentage * 10) / 10,
        estimated: false,
        categories: r.categories.map((c) => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
      };
    } catch {
      return contextFromUsage(this.lastUsage, this.model);
    }
  }

  close() {
    for (const p of this.pending.values()) p.resolve({ behavior: 'deny', message: 'Session đã đóng' });
    this.pending.clear();
    this.queue.close();
    this.q.close();
  }

  answer(requestId: string, d: Decision): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    if (d.allow) {
      p.resolve({
        behavior: 'allow',
        updatedInput: d.answers ? { ...p.ask.input, answers: d.answers } : p.ask.input,
        updatedPermissions: d.always ? p.suggestions : undefined,
      });
    } else {
      p.resolve({ behavior: 'deny', message: d.message || 'Người dùng từ chối qua ClaudeMon' });
    }
    this.emit({ type: 'permission_done', sessionId: this.id, requestId });
    if (!this.pending.size && this.state === 'requires_action') this.setState('running');
    return true;
  }

  private canUseTool: CanUseTool = (toolName, input, opts) =>
    new Promise<PermissionResult>((resolve) => {
      const requestId = crypto.randomUUID();
      const ask: PermissionAsk = {
        requestId,
        sessionId: this.id,
        toolName,
        input,
        title: opts.title,
        description: opts.description ?? opts.decisionReason,
        canAlwaysAllow: !!opts.suggestions?.length && !opts.suppressAlwaysAllowRule,
      };
      this.pending.set(requestId, { ask, suggestions: opts.suggestions, resolve });
      opts.signal.addEventListener('abort', () => {
        if (this.pending.delete(requestId)) {
          resolve({ behavior: 'deny', message: 'Đã huỷ' });
          this.emit({ type: 'permission_done', sessionId: this.id, requestId });
        }
      });
      this.setState('requires_action');
      this.emit({ type: 'permission', ask });
    });

  private setState(state: LiveState, force = false) {
    if (this.state === state && !force) return;
    this.state = state;
    this.emit({ type: 'state', sessionId: this.id, state, live: this.live, turnStartedAt: this.turnStartedAt });
  }

  private emitMeta(meta: SessionMeta = this.meta()) {
    this.emit({ type: 'meta', sessionId: this.id, meta });
  }

  private async pump() {
    try {
      for await (const m of this.q) {
        switch (m.type) {
          case 'stream_event': {
            const ev: any = m.event;
            if (m.parent_tool_use_id === null && ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta')
              this.emit({ type: 'delta', sessionId: this.id, text: ev.delta.text });
            break;
          }
          case 'assistant': {
            if (m.parent_tool_use_id !== null) break;
            const msg = toChatMessage(m.uuid, m.message, this.cwd, Date.now());
            if (msg) this.emit({ type: 'message', sessionId: this.id, message: msg });
            const am: any = m.message;
            if (am?.model && am.model !== this.model) {
              this.model = am.model;
              this.emitMeta();
            }
            if (am?.usage) this.lastUsage = am.usage;
            break;
          }
          case 'user': {
            // Tin của chính người dùng đã được hiện lúc gửi; ở đây chỉ lấy kết quả chạy tool.
            if (m.parent_tool_use_id !== null) break;
            const blocks = toBlocks((m.message as any).content, this.cwd).filter((b) => b.type === 'tool_result');
            if (blocks.length)
              this.emit({
                type: 'message',
                sessionId: this.id,
                message: { id: (m as any).uuid ?? crypto.randomUUID(), role: 'user', blocks, at: Date.now() },
              });
            break;
          }
          case 'system':
            if (m.subtype === 'session_state_changed') {
              this.stateEvents = true;
              // 'idle' đến sau result cuối cùng: rảnh hẳn, không còn tin nào chờ (kể cả khi bị ngắt giữa chừng).
              if (m.state === 'idle') {
                this.queued = 0;
                this.turnStartedAt = undefined;
              } else if (!this.turnStartedAt) {
                // Lượt Claude Code tự mở, không qua send (vd lệnh chạy nền vừa xong).
                this.turnStartedAt = Date.now();
              }
              // Gửi kèm turnStartedAt mới khi chuyển sang chạy.
              this.setState(m.state, m.state === 'running');
            }
            if (m.subtype === 'init') {
              if ((m as any).model) this.model = (m as any).model;
              if ((m as any).permissionMode) this.mode = (m as any).permissionMode;
              this.emitMeta();
            }
            break;
          case 'result': {
            const now = Date.now();
            const durationMs = m.duration_ms || (this.turnStartedAt ? now - this.turnStartedAt : undefined);
            if (!this.stateEvents) {
              // Đoán: tin gửi thêm lúc đang chạy thành lượt kế tiếp, bắt đầu ngay sau lượt này.
              this.queued = Math.max(0, this.queued - 1);
              this.turnStartedAt = this.queued ? now : undefined;
            }
            this.emit({
              type: 'result',
              sessionId: this.id,
              ok: m.subtype === 'success' && !m.is_error,
              error: m.subtype === 'success' ? undefined : m.subtype,
              costUsd: m.total_cost_usd,
              durationMs,
            });
            // Có stateEvents thì chờ session_state_changed: sau result Claude Code còn có thể chạy tiếp.
            if (!this.stateEvents && !this.pending.size) this.setState(this.queued ? 'running' : 'idle', true);
            // Hết lượt: hỏi Claude Code số liệu context thật (nhẹ) để vòng tròn đúng.
            void this.q
              .getContextUsage({ detail: 'summary' })
              .then((r) => this.emitMeta({ ...this.meta(), context: { used: r.totalTokens, max: r.maxTokens, percent: Math.round(r.percentage * 10) / 10, estimated: false } }))
              .catch(() => this.emitMeta());
            break;
          }
        }
      }
    } catch (err) {
      const tail = this.stderrTail.join('').trim().split('\n').slice(-5).join('\n');
      this.emit({ type: 'error', sessionId: this.id, error: `${(err as Error).message}${tail ? '\n' + tail : ''}` });
    } finally {
      this.live = false;
      this.state = 'idle';
      this.turnStartedAt = undefined;
      this.emit({ type: 'state', sessionId: this.id, state: 'idle', live: false });
      this.onEnd(this);
    }
  }
}
