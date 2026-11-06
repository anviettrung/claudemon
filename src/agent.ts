// claudemon-agent: phục vụ giao diện web và điều khiển các session Claude Code trên máy này.
import { getSessionMessages, listSessions, query, renameSession, type SDKSessionInfo, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import index from '../web/index.html';
import { filePath, getMedia, toChatMessage, toCommandInfo } from './normalize.ts';
import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  CHECK_RESULTS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Attachment,
  type CheckResult,
  type ChecklistItem,
  type TaskPriority,
  type TaskStatus,
  type ChatMessage,
  type DeleteResult,
  type Effort,
  type MachineInfo,
  type ModelOption,
  type ServerEvent,
  type SessionMeta,
  type SessionSummary,
  type SlashCommandInfo,
  type UiPermissionMode,
} from './protocol.ts';
import { LibraryStore, nextStamp } from './library.ts';
import { readTranscript, recycle, sessionFiles } from './transcript.ts';
import { CLAUDE_PATH, contextFromUsage, LiveSession, type Decision, setChecklistHooks } from './sessions.ts';
import { ClaudeWaker, type WakeConfig } from './wakeup.ts';
import { PushHub } from './push.ts';
import { accessMode, isAllowed, isLocal, isOriginAllowed, type AccessConfig } from './access.ts';

interface MachinesFile {
  owner: string;
  port: number;
  access?: AccessConfig;
  machines: MachineInfo[];
  wakeup?: { claude?: WakeConfig };
}

const ROOT = resolve(import.meta.dir, '..');
const config: MachinesFile = await Bun.file(resolve(ROOT, 'machines.json')).json();
const computer = (process.env.COMPUTERNAME ?? '').toUpperCase();
const self: MachineInfo = config.machines.find((m) => m.computer.toUpperCase() === computer) ?? {
  name: computer || 'local',
  computer,
};
const PORT = Number(process.env.CLAUDEMON_PORT ?? config.port);

const ACCESS = accessMode(config.access);

// Hậu tố MagicDNS của tailnet (vd tailxxxxxx.ts.net), lấy từ `tailscale status`.
async function tailnetSuffix(): Promise<string | null> {
  const exe = Bun.which('tailscale') ?? 'C:\\Program Files\\Tailscale\\tailscale.exe';
  try {
    const p = Bun.spawn([exe, 'status', '--json'], { stdout: 'pipe', stderr: 'ignore' });
    const status = JSON.parse(await new Response(p.stdout).text());
    return status.MagicDNSSuffix || null;
  } catch {
    return null;
  }
}
// Địa chỉ HTTPS của từng máy: `url` khai trong machines.json (Cloudflare Tunnel, proxy...), hoặc tự tính từ tailnet.
const suffix = ACCESS === 'tailscale' ? await tailnetSuffix() : null;
const machines: MachineInfo[] = config.machines.map((m) => ({
  ...m,
  url: m.url?.replace(/\/+$/, '') || (suffix && m.host ? `https://${m.host}.${suffix}` : undefined),
}));
if (ACCESS === 'local') for (const m of machines) m.url = undefined;
const me = machines.find((m) => m.computer === self.computer);
if (me) self.url = me.url;
// Tệp lịch sử được ghi trong khoảng này mà không phải do agent giữ thì coi như đang mở ở nơi khác.
const ELSEWHERE_MS = 3 * 60_000;
// Lần ghi trước khi agent này chạy có thể do chính agent trước đó (vừa khởi động lại) nên không tính.
const AGENT_START = Date.now();

const live = new Map<string, LiveSession>();
// Lúc agent nhả session; tệp sửa trước mốc này là do chính agent ghi, không phải nơi khác.
const released = new Map<string, number>();
const sockets = new Set<Bun.ServerWebSocket<unknown>>();

function broadcast(e: ServerEvent) {
  const data = JSON.stringify(e);
  for (const ws of sockets) ws.send(data);
  push?.onLocal(e);
}

const libraryEvent = (): ServerEvent => ({ type: 'library', library: library.lib, sync: library.sync, syncError: library.syncError });
const library = new LibraryStore(ROOT, self.name, resolve(ROOT, 'library.cache.json'), () =>
  broadcast(libraryEvent()),
);
await library.init();

// ---------- Checklist ----------

const shortId = () => crypto.randomUUID().slice(0, 8);

// Mục checklist từ client: giữ id cũ nếu hợp lệ và chưa trùng, không thì cấp id mới.
function cleanItems(raw: unknown): ChecklistItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ChecklistItem[] = [];
  for (const i of raw.slice(0, 300)) {
    const text = str((i as any)?.text, 500);
    if (!text) continue;
    let id = str((i as any)?.id, 16);
    if (!id || !/^[\w-]+$/.test(id) || seen.has(id)) id = shortId();
    seen.add(id);
    out.push((i as any)?.heading ? { id, text, heading: true } : { id, text });
  }
  return out;
}

function liveRun(run: string) {
  const r = library.lib.checklistRuns?.[run];
  if (!r || r.deleted) throw new Error(`Không có lượt chạy checklist ${run}`);
  return r;
}

// Ném lỗi nếu lượt chạy không có hoặc có id mục không thuộc lượt chạy (mục heading không kiểm được).
function checkItems(run: string, results: { item: string }[]) {
  const r = liveRun(run);
  const ids = new Set(r.items.filter((i) => !i.heading).map((i) => i.id));
  const bad = results.filter((x) => !ids.has(x.item)).map((x) => x.item);
  if (bad.length) throw new Error(`Lượt chạy không có mục: ${bad.join(', ')}. Gọi checklist_get để xem id các mục.`);
}

async function setCheckResults(
  run: string,
  results: { item: string; result: CheckResult; note?: string }[],
  by: 'claude' | 'user',
  session?: string,
) {
  checkItems(run, results);
  await library.update((lib) => {
    for (const x of results) {
      const key = `${run}:${x.item}`;
      const prev = lib.checkResults[key];
      lib.checkResults[key] = {
        run,
        item: x.item,
        result: x.result,
        note: x.note?.trim().slice(0, 2000) || undefined,
        by,
        session,
        updatedAt: nextStamp(prev?.updatedAt),
      };
    }
  });
  broadcast(libraryEvent());
}

const RESULT_LABEL: Record<CheckResult, string> = { pass: 'đạt', fail: 'lỗi', skip: 'bỏ qua', todo: 'chưa kiểm' };

setChecklistHooks({
  get(run) {
    const r = liveRun(run);
    const lines = [`Checklist: ${r.name}`, `Phiên bản: ${r.version || '(chưa ghi)'}`, `Lượt chạy: ${run}`];
    if (r.notes.trim()) lines.push('', 'Hướng dẫn:', r.notes.trim());
    lines.push('', 'Các mục ([id] nội dung — kết quả hiện có):');
    for (const i of r.items) {
      if (i.heading) {
        lines.push('', `## ${i.text}`);
        continue;
      }
      const res = library.lib.checkResults?.[`${run}:${i.id}`];
      const cur = res && res.result !== 'todo' ? ` — ${RESULT_LABEL[res.result]}${res.note ? `: ${res.note}` : ''}` : '';
      lines.push(`- [${i.id}] ${i.text}${cur}`);
    }
    return lines.join('\n');
  },
  report(run, results, sessionId) {
    // Ghi nền: tool trả lời ngay, library tự đẩy lên git sau.
    checkItems(run, results);
    void setCheckResults(run, results, 'claude', `${self.name}:${sessionId}`).catch((e) => console.error('checklist_report', e));
    const counts = results.reduce<Record<string, number>>((a, x) => ((a[x.result] = (a[x.result] ?? 0) + 1), a), {});
    return `Đã ghi ${results.length} mục (${Object.entries(counts).map(([k, n]) => `${n} ${RESULT_LABEL[k as CheckResult]}`).join(', ')}).`;
  },
});

// Tự đánh thức cửa sổ 5 giờ của Claude và theo dõi hạn mức (gộp từ ai-wake-up).
const waker = new ClaudeWaker(
  config.wakeup?.claude ?? {},
  resolve(ROOT, 'wakeup.state.json'),
  CLAUDE_PATH,
  () => sockets.size > 0,
  (usage) => broadcast({ type: 'usage', usage }),
);
await waker.init();

// Thông báo đẩy tới thiết bị đã bật (src/push.ts). Khoá VAPID và danh sách thiết bị là riêng của máy, không vào kho.
let push: PushHub | undefined;
push = new PushHub(
  resolve(ROOT, 'push.keys.json'),
  resolve(ROOT, 'push.subs.json'),
  self,
  // Agent nối thẳng sang agent máy khác chỉ khi qua Tailscale: Cloudflare Access hay proxy khác đòi đăng nhập trình duyệt.
  ACCESS === 'tailscale' ? machines.filter((m) => m.computer.toUpperCase() !== computer) : [],
  (machine, id, fallback) => library.lib.sessions[`${machine}:${id}`]?.title || fallback || 'Session',
  () => summaries(),
);

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);

// Tên rút gọn từ câu hỏi đầu: bỏ markdown và xuống dòng, lấy câu đầu, tối đa 50 ký tự cắt ở ranh giới từ.
// Dùng khi session chưa có tiêu đề (Claude Code chưa kịp sinh ai-title, hoặc phiên Claude desktop không có).
function shortTitle(text: string, max = 50): string {
  let t = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_#>\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentence = t.match(/^.{12,}?[.?!。](?=\s|$)/);
  if (sentence) t = sentence[0];
  t = t.replace(/[.。]$/, '');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, '') + '…';
}

// Session mới mở từ ClaudeMon: tên tạm từ tin đầu, dùng tới khi tệp lịch sử có tiêu đề.
const draftTitles = new Map<string, string>();

let listCache: { at: number; items: SDKSessionInfo[] } | null = null;
async function sessionInfos(fresh = false): Promise<SDKSessionInfo[]> {
  if (!fresh && listCache && Date.now() - listCache.at < 3000) return listCache.items;
  const items = await listSessions({ limit: 300 });
  listCache = { at: Date.now(), items };
  return items;
}

async function summaries(fresh = false): Promise<SessionSummary[]> {
  const infos = await sessionInfos(fresh);
  const now = Date.now();
  const out: SessionSummary[] = infos.map((i) => {
    const l = live.get(i.sessionId);
    return {
      id: i.sessionId,
      // summary trùng firstPrompt nghĩa là chưa có tiêu đề (tự đặt hay ai-title): rút gọn câu hỏi đầu.
      title:
        i.customTitle ||
        (i.summary && i.summary !== i.firstPrompt ? i.summary : '') ||
        draftTitles.get(i.sessionId) ||
        (i.firstPrompt ? shortTitle(i.firstPrompt) : '') ||
        '(chưa có tiêu đề)',
      cwd: i.cwd ?? '',
      gitBranch: i.gitBranch,
      lastModified: i.lastModified,
      createdAt: i.createdAt,
      live: !!l?.live,
      state: l?.state ?? 'idle',
      turnStartedAt: l?.turnStartedAt,
      elsewhere: !l && now - i.lastModified < ELSEWHERE_MS && i.lastModified > Math.max(released.get(i.sessionId) ?? 0, AGENT_START),
    };
  });
  // Session mới tạo có thể chưa kịp có tệp lịch sử.
  for (const l of live.values()) {
    if (!out.some((s) => s.id === l.id))
      out.unshift({ id: l.id, title: draftTitles.get(l.id) ?? '(session mới)', cwd: l.cwd, lastModified: now, live: true, state: l.state, turnStartedAt: l.turnStartedAt, elsewhere: false });
  }
  return out.sort((a, b) => b.lastModified - a.lastModified);
}

async function pushSessions() {
  broadcast({ type: 'sessions', sessions: await summaries(true) });
}

function startLive(id: string, cwd: string, resume: boolean, mode: UiPermissionMode, model?: string, effort?: Effort) {
  const emit = (e: ServerEvent) => {
    broadcast(e);
    // Hết một lượt thì tiêu đề và thời gian trong danh sách có thể đã đổi.
    if (e.type === 'result') void pushSessions();
  };
  const s = new LiveSession(id, cwd, { resume, mode, model, effort }, emit, (ended) => {
    if (live.get(ended.id) === ended) live.delete(ended.id);
    // Chừa vài giây cho lần ghi cuối của tiến trình vừa tắt.
    released.set(ended.id, Date.now() + 5000);
    void pushSessions();
  });
  live.set(id, s);
  return s;
}

function parseMode(v: unknown): UiPermissionMode {
  return PERMISSION_MODES.includes(v as UiPermissionMode) ? (v as UiPermissionMode) : 'default';
}

const parseEffort = (v: unknown): Effort | undefined => (EFFORT_LEVELS.includes(v as Effort) ? (v as Effort) : undefined);
const parseModel = (v: unknown) => (typeof v === 'string' && /^[\w.\-\[\]:]{1,80}$/.test(v) ? v : undefined);

// Ảnh tối đa 5 MB mỗi tấm (giới hạn của API), tổng tối đa 40 MB mỗi tin.
function parseAttachments(v: unknown): Attachment[] {
  if (!Array.isArray(v)) return [];
  const out: Attachment[] = [];
  let total = 0;
  for (const a of v.slice(0, 10)) {
    if (typeof a?.data !== 'string' || typeof a?.name !== 'string') continue;
    const bytes = Math.floor((a.data.length * 3) / 4);
    total += bytes;
    if (total > 40 * 1024 * 1024) throw new Error('Tệp đính kèm quá lớn (tối đa 40 MB mỗi tin)');
    if (String(a.type).startsWith('image/') && bytes > 5 * 1024 * 1024) throw new Error(`Ảnh ${a.name} lớn quá 5 MB`);
    out.push({ name: a.name.slice(0, 120), type: String(a.type || 'application/octet-stream').slice(0, 80), data: a.data });
  }
  return out;
}

// Hỏi Claude Code trên máy này danh sách model và lệnh slash ở một thư mục: mở một query tạm
// (không gọi API, không lưu session) rồi đóng. Lệnh đổi theo thư mục (skill, lệnh riêng của dự án) nên lưu đệm theo cwd.
const PROBE_TTL = 10 * 60_000;
let modelsCache: { at: number; models: ModelOption[] } | null = null;
const commandsCache = new Map<string, { at: number; commands: SlashCommandInfo[] }>();
const probing = new Map<string, Promise<void>>();

function probe(cwd: string): Promise<void> {
  const key = cwd.toLowerCase();
  const running = probing.get(key);
  if (running) return running;
  const job = (async () => {
    const idle: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
    const q = query({ prompt: idle, options: { cwd, persistSession: false, pathToClaudeCodeExecutable: CLAUDE_PATH } });
    const timeout = Bun.sleep(30_000).then(() => Promise.reject(new Error('Claude Code không trả lời')));
    try {
      const [models, commands] = await Promise.race([Promise.all([q.supportedModels(), q.supportedCommands()]), timeout]);
      modelsCache = { at: Date.now(), models: models.map(toModelOption) };
      commandsCache.set(key, { at: Date.now(), commands: commands.map(toCommandInfo) });
    } finally {
      q.close();
    }
  })().finally(() => probing.delete(key));
  probing.set(key, job);
  return job;
}

function toModelOption(m: any): ModelOption {
  return {
    value: m.value,
    displayName: m.displayName,
    description: m.description,
    efforts: m.supportsEffort ? ((m.supportedEffortLevels ?? []) as Effort[]) : [],
  };
}


// Effort mặc định của Claude Code trên máy này: effortLevel trong ~/.claude/settings.json (không có thì theo model).
async function defaultEffort(): Promise<Effort | undefined> {
  try {
    const s = await Bun.file(resolve(homedir(), '.claude', 'settings.json')).json();
    return parseEffort(s?.effortLevel);
  } catch {
    return undefined;
  }
}

async function listModels(): Promise<ModelOption[]> {
  if (!modelsCache || Date.now() - modelsCache.at > 60 * 60_000) await probe(homedir());
  return modelsCache!.models;
}

async function listCommands(cwd: string): Promise<SlashCommandInfo[]> {
  const hit = commandsCache.get(cwd.toLowerCase());
  if (hit && Date.now() - hit.at < PROBE_TTL) return hit.commands;
  await probe(cwd);
  return commandsCache.get(cwd.toLowerCase())?.commands ?? [];
}

// Model và mức context của session chưa chạy: lấy từ lượt trả lời cuối trong lịch sử.
function metaFromTranscript(raw: { message: unknown }[]): SessionMeta {
  for (let i = raw.length - 1; i >= 0; i--) {
    const m: any = raw[i].message;
    if (m?.role === 'assistant' && m.usage && m.model && m.model !== '<synthetic>') return { model: m.model, context: contextFromUsage(m.usage, m.model) };
  }
  return {};
}

// Xoá session trên máy này: đóng tiến trình nếu đang giữ, rồi chuyển lịch sử vào Thùng rác.
async function deleteSessions(ids: string[]): Promise<DeleteResult> {
  const result: DeleteResult = { deleted: [], failed: [] };
  for (const id of ids) {
    const l = live.get(id);
    if (!l) continue;
    l.close();
    // Chờ tiến trình tắt hẳn để nó không ghi lại tệp vừa xoá.
    for (let i = 0; i < 50 && live.get(id) === l; i++) await Bun.sleep(100);
  }
  for (const id of ids) {
    try {
      const files = sessionFiles(id);
      if (!files.length) throw new Error('Không thấy tệp lịch sử trên máy này');
      await recycle(files);
      result.deleted.push(id);
    } catch (err) {
      result.failed.push({ id, error: (err as Error).message });
    }
  }
  listCache = null;
  await pushSessions();
  return result;
}

// Chỉ nhận request từ chính máy này, hoặc qua lớp chuyển tiếp (access.mode) từ đúng tài khoản chủ. Xem src/access.ts.
const allowed = (req: Request) => isAllowed(req, config.owner, config.access);
const originAllowed = (req: Request) => isOriginAllowed(req, machines.map((m) => m.url));

// Session tự do (không thuộc dự án): mỗi session một thư mục riêng ~/ClaudeMon/scratch-workspaces/scratch-<ngày giờ>,
// để tệp nó tạo ra (báo cáo, ảnh) không lẫn vào nhau. Giao diện nhận ra nhóm này qua đoạn "scratch-workspaces".
const SCRATCH_ROOT = resolve(homedir(), 'ClaudeMon', 'scratch-workspaces');
function newScratchDir(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  let dir = resolve(SCRATCH_ROOT, `scratch-${stamp}`);
  for (let i = 2; existsSync(dir); i++) dir = resolve(SCRATCH_ROOT, `scratch-${stamp}-${i}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Kiểu ảnh theo mấy byte đầu (ảnh task lưu trong git không kèm kiểu).
function imageType(b: Uint8Array): string {
  const hex = Buffer.from(b.subarray(0, 12)).toString('hex');
  if (hex.startsWith('89504e47')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return 'image/webp';
  return 'application/octet-stream';
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (error: string, status = 400) => json({ error }, status);

async function body(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

// Giao diện mở từ máy khác (hoặc từ localhost của máy khác) gọi sang agent này: cần CORS.
function withCors(req: Request, res: Response): Response {
  const origin = req.headers.get('origin');
  if (origin && originAllowed(req)) {
    res.headers.set('access-control-allow-origin', origin);
    res.headers.set('access-control-allow-credentials', 'true');
    res.headers.set('vary', 'origin');
  }
  return res;
}

type Handler = (req: Bun.BunRequest<any>) => Response | Promise<Response>;

function guard(handler: Handler): Handler {
  return async (req) => {
    if (!(await allowed(req)) || !originAllowed(req)) return fail('forbidden', 403);
    try {
      return withCors(req, await handler(req));
    } catch (err) {
      return withCors(req, fail((err as Error).message, 500));
    }
  };
}

// Route API: bọc từng method bằng guard và trả lời preflight OPTIONS.
function api(methods: { GET?: Handler; POST?: Handler }) {
  const out: Record<string, Handler> = {
    OPTIONS: (req) => {
      if (!originAllowed(req)) return new Response(null, { status: 403 });
      const res = new Response(null, { status: 204 });
      res.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.headers.set('access-control-allow-headers', 'content-type');
      res.headers.set('access-control-max-age', '600');
      return withCors(req, res);
    },
  };
  for (const [m, h] of Object.entries(methods)) if (h) out[m] = guard(h);
  return out;
}

// Tệp tĩnh cho PWA (manifest, service worker, icon) nằm ở web/public, phục vụ ở gốc.
function staticFiles(): Record<string, () => Response> {
  const dir = resolve(ROOT, 'web', 'public');
  const out: Record<string, () => Response> = {};
  for (const name of new Bun.Glob('*').scanSync(dir)) {
    const type = name.endsWith('.webmanifest') ? 'application/manifest+json' : undefined;
    out[`/${name}`] = () =>
      new Response(Bun.file(resolve(dir, name), type ? { type } : undefined), {
        headers: { 'cache-control': name === 'sw.js' ? 'no-cache' : 'public, max-age=3600' },
      });
  }
  return out;
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  // Bun mặc định cắt kết nối rảnh sau 10 giây; trình duyệt dùng lại kết nối đã cắt thì request treo.
  idleTimeout: 0,
  development: process.env.CLAUDEMON_DEV === '1',
  routes: {
    '/': index,
    ...staticFiles(),

    '/api/library': api({
      GET: () => json(libraryEvent()),
    }),

    // Sắp xếp session: { key: "<máy>:<id>" hoặc keys: [...], folder?, tags?, pinned?, title? }; null hoặc '' để xoá.
    '/api/library/session': api({
      POST: async (req) => {
        const b = await body(req);
        const keys = (Array.isArray(b.keys) ? b.keys.slice(0, 500) : [b.key]).map((k: unknown) => str(k));
        if (!keys.length || keys.some((k: string | undefined) => !k || !/^[^:]+:[0-9a-f-]{36}$/i.test(k))) return fail('Khoá session không hợp lệ');
        await library.update((lib) => {
          for (const key of keys as string[]) {
            const e = { ...(lib.sessions[key] ?? {}), updatedAt: nextStamp(lib.sessions[key]?.updatedAt) };
            if ('folder' in b) e.folder = str(b.folder) || null;
            if ('pinned' in b) e.pinned = !!b.pinned;
            if ('title' in b) e.title = str(b.title) || undefined;
            if ('tags' in b && Array.isArray(b.tags))
              e.tags = [...new Set(b.tags.map((t: unknown) => str(t, 40)?.replace(/^#+/, '').trim()).filter(Boolean) as string[])].slice(0, 20);
            lib.sessions[key] = e;
          }
        });
        return json(libraryEvent());
      },
    }),

    // Tạo / đổi tên / xoá thư mục: { id?, name?, order?, deleted? }
    '/api/library/folder': api({
      POST: async (req) => {
        const b = await body(req);
        const id = str(b.id) || crypto.randomUUID();
        if (!str(b.name, 80) && !library.lib.folders[id]) return fail('Thư mục cần có tên');
        await library.update((lib) => {
          const prev = lib.folders[id];
          const name = str(b.name, 80) || prev?.name;
          if (!name) throw new Error('Thư mục cần có tên');
          lib.folders[id] = {
            name,
            order: typeof b.order === 'number' ? b.order : (prev?.order ?? Object.keys(lib.folders).length),
            deleted: 'deleted' in b ? !!b.deleted : prev?.deleted,
            updatedAt: nextStamp(prev?.updatedAt),
          };
        });
        return json({ id, ...libraryEvent() });
      },
    }),

    // Đặt tên hiển thị cho một dự án (nhóm theo tên thư mục làm việc): { key, name }; name rỗng để về tên gốc.
    '/api/library/project': api({
      POST: async (req) => {
        const b = await body(req);
        const key = str(b.key, 200)?.toLowerCase();
        if (!key) return fail('Thiếu khoá dự án');
        await library.update((lib) => {
          lib.projects[key] = { name: str(b.name, 80) || undefined, updatedAt: nextStamp(lib.projects[key]?.updatedAt) };
        });
        return json(libraryEvent());
      },
    }),

    // Tạo / sửa / xoá dự án tự tạo: { id?, name?, code?, roots?: [{ machine, path }], order?, deleted? }
    '/api/library/projectdef': api({
      POST: async (req) => {
        const b = await body(req);
        const id = str(b.id, 64) || crypto.randomUUID();
        const prev = library.lib.projectDefs[id];
        const name = str(b.name, 80) || prev?.name;
        if (!name) return fail('Dự án cần có tên');
        let code = 'code' in b ? str(b.code, 12)?.toUpperCase().replace(/[^A-Z0-9]/g, '') : prev?.code;
        if (!code) code = name.normalize('NFD').replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'P';
        if (!/^[A-Z][A-Z0-9]{0,7}$/.test(code)) return fail('Mã dự án: 1–8 chữ cái hoặc số, bắt đầu bằng chữ');
        const clash = Object.entries(library.lib.projectDefs).find(([k, p]) => k !== id && !p.deleted && p.code === code);
        if (clash && !b.deleted) return fail(`Mã ${code} đã dùng cho dự án ${clash[1].name}`);
        let roots = prev?.roots ?? [];
        if (Array.isArray(b.roots)) {
          const names = new Set(config.machines.map((m) => m.name));
          roots = [];
          for (const r of b.roots.slice(0, 20)) {
            const machine = str(r?.machine, 40);
            const path = str(r?.path, 400)?.replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
            if (!machine || !path) continue;
            if (!names.has(machine)) return fail(`Không có máy ${machine}`);
            if (/[\x00-\x1f]/.test(path)) return fail('Đường dẫn có ký tự không hợp lệ');
            if (!roots.some((x) => x.machine === machine && x.path.toLowerCase() === path.toLowerCase())) roots.push({ machine, path });
          }
        }
        await library.update((lib) => {
          lib.projectDefs[id] = {
            name,
            code: code!,
            roots,
            order: typeof b.order === 'number' ? b.order : (prev?.order ?? Object.keys(lib.projectDefs).length),
            deleted: 'deleted' in b ? !!b.deleted : prev?.deleted,
            updatedAt: nextStamp(prev?.updatedAt),
          };
        });
        return json({ id, ...libraryEvent() });
      },
    }),

    // Tạo / sửa / xoá task: { id?, project?, title?, body?, images?, status?, priority?, version?, deleted? }. Task mới (hoặc chuyển dự án)
    // nhận số kế tiếp trong dự án: mã hiển thị <mã dự án>-<số>.
    '/api/library/task': api({
      POST: async (req) => {
        const b = await body(req);
        const id = str(b.id, 64) || crypto.randomUUID();
        const prev = library.lib.tasks[id];
        const project = str(b.project, 64) || prev?.project;
        if (!project || !library.lib.projectDefs[project] || library.lib.projectDefs[project].deleted) return fail('Không có dự án này');
        const title = 'title' in b ? (str(b.title, 200) ?? '') : (prev?.title ?? '');
        if (!title && !prev) return fail('Task cần có tiêu đề');
        let images = prev?.images ?? [];
        if (Array.isArray(b.images))
          images = b.images
            .slice(0, 30)
            .filter((i: any) => typeof i?.sha === 'string' && /^[0-9a-f]{40}$/.test(i.sha))
            .map((i: any) => ({ sha: i.sha, type: /^image\/[\w.+-]+$/.test(i.type) ? i.type : 'image/png', name: str(i.name, 120) }));
        const status = TASK_STATUSES.includes(b.status) ? (b.status as TaskStatus) : (prev?.status ?? 'todo');
        const priority = TASK_PRIORITIES.includes(b.priority) ? (b.priority as TaskPriority) : (prev?.priority ?? 'medium');
        const version = 'version' in b ? (str(b.version, 40) ?? '') : (prev?.version ?? '');
        await library.update((lib) => {
          const nextNum = () => 1 + Math.max(0, ...Object.values(lib.tasks).filter((t) => t.project === project).map((t) => t.num));
          lib.tasks[id] = {
            project,
            num: prev && prev.project === project ? prev.num : nextNum(),
            title: title || prev!.title,
            body: 'body' in b ? (typeof b.body === 'string' ? b.body.slice(0, 50_000) : '') : (prev?.body ?? ''),
            images,
            status,
            priority,
            version: version || undefined,
            createdAt: prev?.createdAt ?? Date.now(),
            deleted: 'deleted' in b ? !!b.deleted : prev?.deleted,
            updatedAt: nextStamp(prev?.updatedAt),
          };
        });
        return json({ id, ...libraryEvent() });
      },
    }),

    // Tạo / sửa / xoá checklist mẫu: { id?, project?, name?, notes?, items?, deleted? }.
    '/api/library/checklist': api({
      POST: async (req) => {
        const b = await body(req);
        const id = str(b.id, 64) || crypto.randomUUID();
        const prev = library.lib.checklists?.[id];
        const project = str(b.project, 64) || prev?.project;
        if (!project || !library.lib.projectDefs[project] || library.lib.projectDefs[project].deleted) return fail('Không có dự án này');
        const name = 'name' in b ? (str(b.name, 120) ?? '') : (prev?.name ?? '');
        if (!name) return fail('Checklist cần có tên');
        await library.update((lib) => {
          lib.checklists[id] = {
            project,
            name,
            notes: 'notes' in b ? (typeof b.notes === 'string' ? b.notes.slice(0, 10_000) : '') : (prev?.notes ?? ''),
            items: 'items' in b ? cleanItems(b.items) : (prev?.items ?? []),
            createdAt: prev?.createdAt ?? Date.now(),
            deleted: 'deleted' in b ? !!b.deleted : prev?.deleted,
            updatedAt: nextStamp(prev?.updatedAt),
          };
        });
        return json({ id, ...libraryEvent() });
      },
    }),

    // Lượt chạy checklist. Tạo: { checklist, version? } (chụp lại các mục của mẫu). Sửa: { id, version?, deleted? }.
    '/api/library/checklist-run': api({
      POST: async (req) => {
        const b = await body(req);
        const prevId = str(b.id, 64);
        const prev = prevId ? library.lib.checklistRuns?.[prevId] : undefined;
        if (prevId && !prev) return fail('Không có lượt chạy này');
        const id = prevId || crypto.randomUUID().slice(0, 13);
        let base = prev;
        if (!prev) {
          const c = library.lib.checklists?.[str(b.checklist, 64) ?? ''];
          if (!c || c.deleted) return fail('Không có checklist này');
          if (!c.items.some((i) => !i.heading)) return fail('Checklist chưa có mục nào');
          base = { project: c.project, checklist: str(b.checklist, 64)!, name: c.name, notes: c.notes, items: c.items, createdAt: Date.now(), updatedAt: 0 };
        }
        await library.update((lib) => {
          lib.checklistRuns[id] = {
            ...base!,
            version: 'version' in b ? str(b.version, 40) || undefined : base!.version,
            deleted: 'deleted' in b ? !!b.deleted : base!.deleted,
            updatedAt: nextStamp(prev?.updatedAt),
          };
        });
        return json({ id, ...libraryEvent() });
      },
    }),

    // Người dùng đánh dấu một mục: { run, item, result, note? }.
    '/api/library/check-result': api({
      POST: async (req) => {
        const b = await body(req);
        if (!CHECK_RESULTS.includes(b.result)) return fail('Kết quả không hợp lệ');
        try {
          await setCheckResults(str(b.run, 64) ?? '', [{ item: str(b.item, 16) ?? '', result: b.result, note: typeof b.note === 'string' ? b.note : undefined }], 'user');
        } catch (e) {
          return fail((e as Error).message);
        }
        return json(libraryEvent());
      },
    }),

    // Tải ảnh của task lên: { type, data (base64) } -> { sha, type }. Ảnh nằm trong nhánh claudemon-library nên máy nào cũng xem được.
    '/api/library/image': api({
      POST: async (req) => {
        const b = await body(req);
        const type = String(b.type ?? '');
        if (!/^image\/[\w.+-]+$/.test(type) || typeof b.data !== 'string') return fail('Chỉ nhận ảnh');
        const bytes = Buffer.from(b.data, 'base64');
        if (!bytes.length) return fail('Ảnh trống');
        if (bytes.length > 8 * 1024 * 1024) return fail('Ảnh lớn quá 8 MB');
        return json({ sha: await library.storeImage(new Uint8Array(bytes)), type });
      },
    }),
    '/api/library/image/:sha': api({
      GET: async (req) => {
        const data = await library.readImage(req.params.sha);
        if (!data) return fail('Không có ảnh này', 404);
        return new Response(data, { headers: { 'content-type': imageType(data), 'cache-control': 'private, max-age=31536000, immutable' } });
      },
    }),

    // Ảnh base64 nằm trong tin nhắn (đã gặp khi đọc transcript hoặc luồng trực tiếp).
    '/api/media/:id': api({
      GET: (req) => {
        const m = getMedia(req.params.id);
        if (!m) return fail('Ảnh không còn trong bộ nhớ, tải lại session', 404);
        return new Response(new Uint8Array(m.data), { headers: { 'content-type': m.type, 'cache-control': 'private, max-age=86400, immutable' } });
      },
    }),

    // Tệp Claude gửi bằng SendUserFile. Chỉ phục vụ tệp đã có tên trong transcript; hỗ trợ Range để tua video.
    // Tệp HTML (báo cáo) thì phục vụ thêm tài nguyên nằm cùng thư mục hoặc thư mục con của nó (ảnh, css, js
    // theo đường dẫn tương đối): /api/file/<token>/<đường dẫn tương đối>.
    '/api/file/:token/*': api({
      GET: (req) => {
        const sent = filePath(req.params.token);
        if (!sent) return fail('Không có tệp này', 404);
        let rest: string;
        try {
          rest = decodeURIComponent(new URL(req.url).pathname.split('/').slice(4).join('/'));
        } catch {
          return fail('Đường dẫn không hợp lệ');
        }
        let path = sent;
        if (rest !== basename(sent) && /\.html?$/i.test(sent)) {
          const dir = dirname(sent);
          const p = resolve(dir, rest);
          const rel = relative(dir, p);
          if (!rel || rel.startsWith('..') || rel.includes(':') || p.startsWith(sep + sep)) return fail('Không có tệp này', 404);
          path = p;
        }
        if (!existsSync(path) || !statSync(path).isFile()) return fail('Không có tệp này', 404);
        const file = Bun.file(path);
        const size = file.size;
        const headers: Record<string, string> = {
          'content-type': file.type || 'application/octet-stream',
          'accept-ranges': 'bytes',
          'cache-control': 'private, max-age=300',
        };
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
        if (range && size > 0) {
          let start = range[1] ? Number(range[1]) : size - Number(range[2]);
          let end = range[1] && range[2] ? Number(range[2]) : size - 1;
          start = Math.max(0, start);
          end = Math.min(size - 1, end);
          if (start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
          headers['content-range'] = `bytes ${start}-${end}/${size}`;
          return new Response(file.slice(start, end + 1), { status: 206, headers });
        }
        return new Response(file, { headers });
      },
    }),

    // Lưu / bỏ một thư mục làm việc tự thêm: { machine, path, deleted? }. Kiểm tồn tại do agent của máy đó lo.
    '/api/library/path': api({
      POST: async (req) => {
        const b = await body(req);
        const machine = str(b.machine, 40);
        const path = str(b.path, 400);
        if (!machine || !path) return fail('Thiếu máy hoặc đường dẫn');
        if (/[\x00-\x1f]/.test(path)) return fail('Đường dẫn có ký tự không hợp lệ');
        const key = `${machine}:${path.toLowerCase()}`;
        await library.update((lib) => {
          lib.paths[key] = { machine, path, deleted: !!b.deleted, updatedAt: nextStamp(lib.paths[key]?.updatedAt) };
        });
        return json(libraryEvent());
      },
    }),

    // Đường dẫn có phải thư mục trên máy này không: { path } -> { ok, path }
    // App desktop (cửa sổ Chrome/Edge --app ở 127.0.0.1) mở link bằng trình duyệt mặc định của máy.
    // Chỉ nhận từ chính máy này (không qua lớp chuyển tiếp nào) và chỉ link http(s)/mailto.
    '/api/open-url': api({
      POST: async (req) => {
        if (!isLocal(req)) return fail('chỉ dùng trên chính máy này', 403);
        const origin = req.headers.get('origin');
        if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return fail('forbidden', 403);
        const raw = str((await body(req)).url, 4000);
        let url: URL;
        try {
          url = new URL(raw ?? '');
        } catch {
          return fail('link không hợp lệ');
        }
        if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return fail('chỉ mở link http(s)/mailto');
        // FileProtocolHandler giao link cho trình duyệt mặc định, không qua shell nên không bị chèn lệnh.
        Bun.spawn(['rundll32.exe', 'url.dll,FileProtocolHandler', url.href], { stdout: 'ignore', stderr: 'ignore' });
        return json({ ok: true });
      },
    }),

    '/api/path-check': api({
      POST: async (req) => {
        const b = await body(req);
        const path = str(b.path, 400)?.replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
        const ok = !!path && existsSync(path) && statSync(path).isDirectory();
        return json({ ok, path: ok ? resolve(path!) : path });
      },
    }),

    '/api/usage': api({
      GET: () => json(waker.info()),
      // { action: 'refresh' | 'poke' }. refresh chỉ chạy khi cửa sổ đang mở (probe lúc cửa sổ hết sẽ mở cửa sổ mới).
      POST: async (req) => {
        const b = await body(req);
        if (!waker.enabled) return fail('Tự đánh thức Claude đang tắt trên máy này');
        if (b.action === 'poke') await waker.run('poke', 'bấm tay');
        else if (waker.isActive()) await waker.run('refresh');
        return json(waker.info());
      },
    }),

    // Thông báo đẩy: khoá công khai VAPID, đăng ký / huỷ, báo đang mở app (để khỏi đẩy trùng), gửi thử.
    '/api/push/key': api({
      GET: (req) => {
        const endpoint = new URL(req.url).searchParams.get('endpoint') ?? '';
        return json({ publicKey: push!.publicKey, subscribed: !!endpoint && push!.has(endpoint) });
      },
    }),
    '/api/push/subscribe': api({
      POST: async (req) => {
        const b = await body(req);
        push!.subscribe(b.subscription, str(b.device, 80) ?? '');
        return json({ ok: true });
      },
    }),
    '/api/push/unsubscribe': api({
      POST: async (req) => {
        push!.unsubscribe(str((await body(req)).endpoint, 2000) ?? '');
        return json({ ok: true });
      },
    }),
    '/api/push/presence': api({
      POST: async (req) => {
        const b = await body(req);
        push!.setPresence(str(b.endpoint, 2000) ?? '', !!b.visible);
        return json({ ok: true });
      },
    }),
    '/api/push/test': api({
      POST: async (req) => {
        await push!.test(str((await body(req)).endpoint, 2000) ?? '');
        return json({ ok: true });
      },
    }),

    // Khởi động lại agent (nút trong menu Hệ thống, chỉ trên máy tính): kéo code mới của kho claudemon (chỉ fast-forward),
    // cài lại gói nếu bun.lock đổi, đóng các session đang mở rồi thoát. Vòng lặp scripts/run-agent.ps1 bật lại agent
    // sau 5 giây với code mới. Lịch sử session còn nguyên, gửi tin là chạy tiếp.
    '/api/agent/restart': api({
      POST: () => {
        const repo = resolve(import.meta.dir, '..');
        const git = (...args: string[]) => {
          const r = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' });
          return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() };
        };
        const before = git('rev-parse', '--short', 'HEAD').out;
        // fetch + merge @{u} (chỉ tua nhanh), không dùng pull: pull đọc FETCH_HEAD, mà đồng bộ thư viện (library.ts)
        // fetch song song có thể ghi chồng vào đó -> "Cannot fast-forward to multiple branches".
        const fetched = git('fetch', '--quiet', 'origin');
        const pull = fetched.ok ? git('merge', '--ff-only', '--quiet', '@{u}') : fetched;
        const after = git('rev-parse', '--short', 'HEAD').out;
        if (before !== after && !git('diff', '--quiet', before, after, '--', 'bun.lock').ok)
          Bun.spawnSync([process.execPath, 'install'], { cwd: resolve(import.meta.dir, '..'), stdout: 'ignore', stderr: 'ignore' });
        // Ghi lại phiên bản đã chạy để install.ps1 lần sau không khởi động lại thêm lần nữa.
        const tree = git('rev-parse', 'HEAD^{tree}');
        if (tree.ok) {
          const dir = join(homedir(), '.claudemon');
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'claudemon-tree.txt'), tree.out + '\n');
        }
        console.log(`[claudemon] khởi động lại theo yêu cầu (${before} -> ${after})`);
        setTimeout(() => {
          for (const l of live.values()) l.close();
          setTimeout(() => process.exit(0), 800);
        }, 300);
        return json({ before, after, pulled: pull.ok, pullError: pull.ok ? undefined : pull.out.slice(0, 300) });
      },
    }),

    '/api/info': api({
      GET: () => json({ self, machines, modes: PERMISSION_MODES, startedAt: AGENT_START }),
    }),

    '/api/sessions': api({
      GET: async () => json(await summaries()),
      // Mở session mới: { cwd, text, mode?, model?, effort?, attachments? }; scratch: true = session tự do (bỏ qua cwd)
      POST: async (req) => {
        const b = await body(req);
        let cwd = typeof b.cwd === 'string' ? b.cwd.trim() : '';
        const text = typeof b.text === 'string' ? b.text.trim() : '';
        const attachments = parseAttachments(b.attachments);
        if (!text && !attachments.length) return fail('Chưa có nội dung tin nhắn');
        if (b.scratch === true) cwd = newScratchDir();
        else if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) return fail('Thư mục không tồn tại trên máy này');
        const id = crypto.randomUUID();
        draftTitles.set(id, shortTitle(text) || attachments[0]?.name || '(session mới)');
        startLive(id, cwd, false, parseMode(b.mode), parseModel(b.model), parseEffort(b.effort)).send(text, str(b.clientId, 64), attachments);
        void pushSessions();
        // Claude Code tự sinh ai-title vài giây sau tin đầu; làm mới danh sách để tên đó hiện sớm, không chờ hết lượt.
        for (const ms of [4000, 12_000, 30_000]) setTimeout(() => void pushSessions(), ms);
        setTimeout(() => draftTitles.delete(id), 10 * 60_000);
        return json({ id });
      },
    }),

    '/api/sessions/:id/messages': api({
      GET: async (req) => {
        const info = (await sessionInfos()).find((i) => i.sessionId === req.params.id);
        // Tự đọc .jsonl để có cả lịch sử trước các lần compact; không thấy tệp thì nhờ SDK.
        const raw =
          (await readTranscript(req.params.id)) ??
          (await getSessionMessages(req.params.id, { dir: info?.cwd })).filter((m) => m.parent_tool_use_id === null);
        const messages = raw.map((m) => toChatMessage(m.uuid, m.message, info?.cwd, (m as { at?: number }).at)).filter((m): m is ChatMessage => m !== null);
        const l = live.get(req.params.id);
        const meta = l ? { ...metaFromTranscript(raw), ...Object.fromEntries(Object.entries(l.meta()).filter(([, v]) => v !== undefined)) } : metaFromTranscript(raw);
        return json({ messages, pending: l?.pendingAsks ?? [], meta });
      },
    }),

    // Gửi tin vào session: chạy tiếp nếu chưa có tiến trình. { text, mode?, model?, effort?, attachments? }
    '/api/sessions/:id/send': api({
      POST: async (req) => {
        const b = await body(req);
        const text = typeof b.text === 'string' ? b.text.trim() : '';
        const attachments = parseAttachments(b.attachments);
        if (!text && !attachments.length) return fail('Chưa có nội dung tin nhắn');
        const model = parseModel(b.model);
        const effort = parseEffort(b.effort);
        let s = live.get(req.params.id);
        if (!s) {
          const info = (await sessionInfos(true)).find((i) => i.sessionId === req.params.id);
          if (!info?.cwd) return fail('Không tìm thấy session trên máy này', 404);
          s = startLive(info.sessionId, info.cwd, true, parseMode(b.mode), model, effort);
          void pushSessions();
        } else {
          if (model && model !== s.model) await s.setModel(model);
          if (effort && effort !== s.effort) await s.setEffort(effort);
        }
        s.send(text, str(b.clientId, 64), attachments);
        return json({ ok: true });
      },
    }),

    '/api/sessions/:id/interrupt': api({
      POST: async (req) => {
        await live.get(req.params.id)?.interrupt();
        return json({ ok: true });
      },
    }),

    '/api/sessions/:id/close': api({
      POST: (req) => {
        live.get(req.params.id)?.close();
        return json({ ok: true });
      },
    }),

    // Xoá session trên máy này (chuyển lịch sử vào Thùng rác): { ids: string[] } -> DeleteResult
    '/api/sessions/delete': api({
      POST: async (req) => {
        const b = await body(req);
        const ids = Array.isArray(b.ids) ? [...new Set(b.ids.filter((x: unknown) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)))] as string[] : [];
        if (!ids.length) return fail('Chưa chọn session hợp lệ');
        if (ids.length > 200) return fail('Xoá tối đa 200 session mỗi lần');
        return json(await deleteSessions(ids));
      },
    }),

    // Đổi model / effort của session đang chạy: { model?, effort? }. Session chưa chạy thì giao diện giữ lựa chọn và gửi kèm lúc gửi tin.
    '/api/sessions/:id/settings': api({
      POST: async (req) => {
        const b = await body(req);
        const s = live.get(req.params.id);
        if (!s) return json({ ok: true, live: false });
        const model = parseModel(b.model);
        const effort = parseEffort(b.effort);
        if (model) await s.setModel(model);
        if (effort) await s.setEffort(effort);
        return json({ ok: true, live: true, meta: s.meta() });
      },
    }),

    // Chi tiết context như lệnh /context: chính xác khi session đang chạy, ước tính khi chưa.
    '/api/sessions/:id/context': api({
      GET: async (req) => {
        const s = live.get(req.params.id);
        if (s) return json({ context: await s.contextUsage(), model: s.model });
        const raw = (await readTranscript(req.params.id)) ?? [];
        const meta = metaFromTranscript(raw);
        return json({ context: meta.context, model: meta.model });
      },
    }),

    // Lệnh slash dùng được trong một session (hoặc một thư mục, cho session mới): ?session=<id> hoặc ?cwd=<thư mục>
    '/api/commands': api({
      GET: async (req) => {
        const u = new URL(req.url);
        const sid = u.searchParams.get('session') ?? '';
        const s = live.get(sid);
        if (s) return json({ commands: await s.commands() });
        let cwd = u.searchParams.get('cwd') ?? '';
        if (sid) cwd = (await sessionInfos()).find((i) => i.sessionId === sid)?.cwd ?? cwd;
        if (!cwd || !existsSync(cwd)) cwd = homedir();
        return json({ commands: await listCommands(cwd) });
      },
    }),

    '/api/models': api({
      GET: async () => json({ models: await listModels(), defaultEffort: await defaultEffort() }),
    }),

    '/api/sessions/:id/mode': api({
      POST: async (req) => {
        const b = await body(req);
        await live.get(req.params.id)?.setMode(parseMode(b.mode));
        return json({ ok: true });
      },
    }),

    '/api/sessions/:id/rename': api({
      POST: async (req) => {
        const b = await body(req);
        const title = typeof b.title === 'string' ? b.title.trim() : '';
        if (!title) return fail('Tiêu đề trống');
        const info = (await sessionInfos()).find((i) => i.sessionId === req.params.id);
        await renameSession(req.params.id, title, { dir: info?.cwd });
        void pushSessions();
        return json({ ok: true });
      },
    }),

    // Trả lời yêu cầu duyệt quyền: { sessionId, allow, always?, answers?, message? }
    '/api/permissions/:requestId': api({
      POST: async (req) => {
        const b = await body(req);
        const s = live.get(b.sessionId);
        const d: Decision = { allow: !!b.allow, always: !!b.always, answers: b.answers, message: b.message };
        if (!s?.answer(req.params.requestId, d)) return fail('Yêu cầu không còn chờ', 404);
        return json({ ok: true });
      },
    }),
  },

  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (!(await allowed(req)) || !originAllowed(req)) return new Response('forbidden', { status: 403 });
      if (srv.upgrade(req)) return;
      return new Response('upgrade failed', { status: 400 });
    }
    return new Response('not found', { status: 404 });
  },

  websocket: {
    async open(ws) {
      sockets.add(ws);
      ws.send(JSON.stringify({ type: 'sessions', sessions: await summaries() } satisfies ServerEvent));
      ws.send(JSON.stringify(libraryEvent()));
      ws.send(JSON.stringify({ type: 'usage', usage: waker.info() } satisfies ServerEvent));
      for (const l of live.values()) for (const ask of l.pendingAsks) ws.send(JSON.stringify({ type: 'permission', ask } satisfies ServerEvent));
    },
    message() {},
    close(ws) {
      sockets.delete(ws);
    },
  },
});

// Nạp sẵn danh sách model (lần đầu mất ~10 giây vì phải mở Claude Code).
void listModels().catch(() => {});

console.log(`claudemon-agent ${self.name} (${self.computer}) tại http://${server.hostname}:${server.port}`);
