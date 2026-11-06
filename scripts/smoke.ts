// Kiểm thử SessionMon từ đầu đến cuối qua API thật của các agent đang chạy (mọi máy trong machines.json).
// Chạy: bun run scripts/smoke.ts            (mọi nhóm)
//       bun run scripts/smoke.ts security library   (chỉ vài nhóm)
// Mỗi nhóm có session Claude thật nên tốn một ít lượt dùng. Session thử nằm trong thư mục tạm, được đóng lại khi xong.
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Library, MachineInfo, ServerEvent, SessionSummary } from '../src/protocol.ts';

const ROOT = resolve(import.meta.dir, '..');
const cfg: { machines: MachineInfo[]; owner: string; port: number } = JSON.parse(readFileSync(join(ROOT, 'machines.json'), 'utf8'));
const LOCAL = `http://127.0.0.1:${cfg.port}`;
const only = new Set(process.argv.slice(2));
// Thư mục làm việc trên máy khác: phải tồn tại ở đó. Mặc định là chỗ đặt kho sessionmon.
const REMOTE_CWD = process.env.SESSIONMON_REMOTE_CWD ?? 'D:\\Projects\\sessionmon';

let failed = 0;
let passed = 0;
const results: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  ok ? passed++ : failed++;
  const line = `${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`;
  results.push(line);
  console.log(line);
}

async function http(base: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data: data as any };
}

// Nghe sự kiện WebSocket của một agent, chờ được sự kiện thoả điều kiện.
class Feed {
  events: ServerEvent[] = [];
  private ws: WebSocket;
  private waiters: { pred: (e: ServerEvent) => boolean; resolve: (e: ServerEvent) => void }[] = [];
  ready: Promise<void>;
  constructor(base: string) {
    this.ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
    this.ready = new Promise((r, j) => {
      this.ws.onopen = () => r();
      this.ws.onerror = () => j(new Error('ws lỗi ' + base));
    });
    this.ws.onmessage = (m) => {
      const e = JSON.parse(String(m.data)) as ServerEvent;
      this.events.push(e);
      for (const w of [...this.waiters]) if (w.pred(e)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(e);
      }
    };
  }
  wait<T extends ServerEvent>(pred: (e: ServerEvent) => boolean, ms = 120_000, since = 0): Promise<T> {
    const hit = this.events.slice(since).find(pred);
    if (hit) return Promise.resolve(hit as T);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve: resolve as (e: ServerEvent) => void };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error(`hết ${ms / 1000}s chờ sự kiện`));
        }
      }, ms);
    });
  }
  mark() {
    return this.events.length;
  }
  close() {
    this.ws.close();
  }
}

const textOf = (events: ServerEvent[], sid: string) =>
  events
    .filter((e) => e.type === 'message' && e.sessionId === sid && e.message.role === 'assistant')
    .flatMap((e) => (e as any).message.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text))
    .join('\n');

const isResult = (sid: string) => (e: ServerEvent) => e.type === 'result' && e.sessionId === sid;
const isAsk = (sid: string) => (e: ServerEvent) => e.type === 'permission' && e.ask.sessionId === sid;

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    check(name, false, (err as Error).message);
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------

const info = (await http(LOCAL, '/api/info')).data as { self: MachineInfo; machines: MachineInfo[] };
const remotes = info.machines.filter((m) => m.computer !== info.self.computer && m.url);
console.log(`Máy chạy test: ${info.self.name}; máy khác: ${remotes.map((m) => m.name).join(', ') || '(không có)'}\n`);

const workDir = join(tmpdir(), 'sessionmon-smoke');
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
const opened: { base: string; id: string }[] = [];

async function newSession(base: string, cwd: string, text: string, mode = 'default') {
  const r = await http(base, '/api/sessions', { cwd, text, mode });
  if (r.status !== 200) throw new Error(`tạo session: HTTP ${r.status} ${r.data.error ?? ''}`);
  opened.push({ base, id: r.data.id });
  return r.data.id as string;
}

// 1. Kết nối và danh sách -----------------------------------------------------------------------------
if (!only.size || only.has('basic')) {
  for (const m of [info.self, ...remotes]) {
    const base = m === info.self ? LOCAL : m.url!;
    await step(`[${m.name}] /api/info`, async () => {
      const r = await http(base, '/api/info');
      check(`[${m.name}] /api/info trả đúng máy`, r.status === 200 && r.data.self?.name === m.name, `self=${r.data.self?.name}`);
    });
    await step(`[${m.name}] danh sách session`, async () => {
      const r = await http(base, '/api/sessions');
      check(`[${m.name}] danh sách session`, r.status === 200 && Array.isArray(r.data) && r.data.length > 0, `${r.data.length} session`);
    });
  }
  // Session phiên Claude Code đang chạy bài test này (nếu có) phải bị đánh dấu "đang mở nơi khác".
  const list: SessionSummary[] = (await http(LOCAL, '/api/sessions')).data;
  // Agent bỏ qua các lần ghi trước khi nó khởi động, nên ngay sau khi khởi động lại chưa có session nào bị đánh dấu.
  const n = list.filter((s) => s.elsewhere).length;
  const fresh = Date.now() - ((info as any).startedAt ?? 0) < 3 * 60_000;
  if (n || !fresh) check('cảnh báo "đang mở nơi khác" có hoạt động', n > 0, `${n} session`);
  else console.log('– bỏ qua cảnh báo "đang mở nơi khác": agent vừa khởi động lại chưa tới 3 phút');
}

// 2. Bảo mật -------------------------------------------------------------------------------------------
if (!only.size || only.has('security')) {
  for (const m of [info.self, ...remotes]) {
    const base = m === info.self ? LOCAL : m.url!;
    const bad = await http(base, '/api/sessions', undefined, { 'tailscale-user-login': 'nguoi-la@example.com' });
    if (m === info.self) check(`[${m.name}] chặn tài khoản Tailscale lạ`, bad.status === 403, `HTTP ${bad.status}`);
    // Qua tailnet, `tailscale serve` bỏ header giả của client và gắn danh tính thật (chính chủ) nên được nhận.
    else check(`[${m.name}] tailscale serve ghi đè header danh tính giả`, bad.status === 200, `HTTP ${bad.status}`);
    const evil = await http(base, '/api/sessions', undefined, { origin: 'https://evil.example.com' });
    check(`[${m.name}] chặn Origin lạ`, evil.status === 403, `HTTP ${evil.status}`);
    const pre = await fetch(base + '/api/sessions/x/send', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'POST' },
    });
    check(`[${m.name}] preflight từ Origin lạ bị chặn`, pre.status === 403, `HTTP ${pre.status}`);
    const okOrigin = info.machines.find((x) => x.url && x !== m)?.url;
    if (okOrigin) {
      const r = await http(base, '/api/info', undefined, { origin: okOrigin });
      check(`[${m.name}] nhận Origin của máy trong danh sách`, r.status === 200, `HTTP ${r.status}`);
    }
  }
  const nf = await http(LOCAL, '/api/sessions', { cwd: 'Z:\\khong-co-thu-muc-nay', text: 'x' });
  check('từ chối thư mục không tồn tại', nf.status === 400, nf.data.error);
  const empty = await http(LOCAL, '/api/sessions', { cwd: workDir, text: '   ' });
  check('từ chối tin nhắn rỗng', empty.status === 400, empty.data.error);
}

// 3. Session trên máy này: duyệt quyền, câu hỏi, dừng, chế độ, đóng, chạy tiếp ---------------------------
if (!only.size || only.has('session')) {
  const feed = new Feed(LOCAL);
  await feed.ready;
  const fileA = join(workDir, 'a.txt');
  const sid = await step('tạo session', () =>
    newSession(LOCAL, workDir, `Dùng tool Write tạo tệp ${fileA} với nội dung đúng: alpha. Không làm gì khác. Nếu bị từ chối thì chỉ trả lời: BI_TU_CHOI`),
  );
  if (sid) {
    check('tạo session mới', true, sid.slice(0, 8));
    // Từ chối
    const ask1 = await step('nhận yêu cầu duyệt Write', () => feed.wait<Extract<ServerEvent, { type: 'permission' }>>(isAsk(sid)));
    if (ask1) {
      check('nhận yêu cầu duyệt Write', ask1.ask.toolName === 'Write', ask1.ask.toolName);
      const r = await http(LOCAL, `/api/permissions/${ask1.ask.requestId}`, { sessionId: sid, allow: false });
      check('từ chối qua API', r.status === 200);
      await step('kết thúc lượt sau khi từ chối', () => feed.wait(isResult(sid)));
      check('tệp KHÔNG được tạo khi từ chối', !existsSync(fileA));
      check('Claude nhận biết bị từ chối', /BI_TU_CHOI|từ chối|denied/i.test(textOf(feed.events, sid)), textOf(feed.events, sid).slice(0, 60));
    }
    // Cho phép; tin gửi đi phải được phát lại cho mọi thiết bị đang xem (kèm đúng clientId).
    let mark = feed.mark();
    const clientId = crypto.randomUUID();
    await http(LOCAL, `/api/sessions/${sid}/send`, { text: 'Giờ thử lại đúng việc đó.', clientId });
    const echo = await step('phát lại tin người dùng', () =>
      feed.wait((e) => e.type === 'message' && e.sessionId === sid && e.message.role === 'user' && e.message.id === clientId, 10_000, mark),
    );
    check('phát lại tin người dùng cho thiết bị khác', !!echo);
    const ask2 = await step('nhận yêu cầu duyệt lần 2', () => feed.wait<Extract<ServerEvent, { type: 'permission' }>>(isAsk(sid), 120_000, mark));
    if (ask2) {
      await http(LOCAL, `/api/permissions/${ask2.ask.requestId}`, { sessionId: sid, allow: true });
      await step('kết thúc lượt sau khi cho phép', () => feed.wait(isResult(sid), 120_000, mark));
      check('cho phép thì tệp được tạo', existsSync(fileA) && readFileSync(fileA, 'utf8').includes('alpha'));
      check('có luồng chữ (streaming delta)', feed.events.some((e) => e.type === 'delta' && e.sessionId === sid));
      check('có thẻ tool_result gắn với Write', feed.events.some((e) => e.type === 'message' && e.sessionId === sid && e.message.blocks.some((b) => b.type === 'tool_result')));
    }
    // Câu hỏi AskUserQuestion
    mark = feed.mark();
    await http(LOCAL, `/api/sessions/${sid}/send`, {
      text: 'Dùng tool AskUserQuestion hỏi tôi đúng một câu: "Chọn màu?" với hai lựa chọn "Đỏ" và "Xanh". Sau khi tôi trả lời, chỉ nhắc lại đúng màu tôi chọn.',
    });
    const q = await step('nhận thẻ câu hỏi', () => feed.wait<Extract<ServerEvent, { type: 'permission' }>>(isAsk(sid), 120_000, mark));
    if (q) {
      const questions = (q.ask.input as any).questions ?? [];
      check('thẻ câu hỏi AskUserQuestion', q.ask.toolName === 'AskUserQuestion' && questions.length > 0, `${q.ask.toolName}, ${questions.length} câu`);
      const answers = Object.fromEntries(questions.map((x: any) => [x.question, x.options.find((o: any) => /xanh/i.test(o.label))?.label ?? x.options[1].label]));
      await http(LOCAL, `/api/permissions/${q.ask.requestId}`, { sessionId: sid, allow: true, answers });
      await step('kết thúc lượt câu hỏi', () => feed.wait(isResult(sid), 120_000, mark));
      const after = textOf(feed.events.slice(mark), sid);
      check('Claude nhận đúng câu trả lời', /xanh/i.test(after), after.slice(0, 60));
    }
    // Chế độ acceptEdits: sửa tệp không cần hỏi
    mark = feed.mark();
    const fileB = join(workDir, 'b.txt');
    const mode = await http(LOCAL, `/api/sessions/${sid}/mode`, { mode: 'acceptEdits' });
    check('đổi chế độ quyền sang acceptEdits', mode.status === 200);
    await http(LOCAL, `/api/sessions/${sid}/send`, { text: `Dùng Write tạo ${fileB} nội dung: beta. Không làm gì khác.` });
    await step('kết thúc lượt acceptEdits', () => feed.wait(isResult(sid), 120_000, mark));
    check('acceptEdits: tạo tệp mà không hỏi', existsSync(fileB) && !feed.events.slice(mark).some(isAsk(sid)));
    // Dừng giữa chừng
    mark = feed.mark();
    await http(LOCAL, `/api/sessions/${sid}/send`, { text: 'Viết một bài luận rất dài, ít nhất 3000 chữ, về lịch sử sao Bắc Cực. Không dùng tool.' });
    await step('có chữ trước khi dừng', () => feed.wait((e) => e.type === 'delta' && e.sessionId === sid, 120_000, mark));
    const t0 = Date.now();
    const intr = await http(LOCAL, `/api/sessions/${sid}/interrupt`, {});
    const res = await step('dừng lượt đang chạy', () => feed.wait<Extract<ServerEvent, { type: 'result' }>>(isResult(sid), 30_000, mark));
    check('dừng lượt đang chạy', intr.status === 200 && !!res && Date.now() - t0 < 30_000, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
    // Đóng rồi chạy tiếp
    mark = feed.mark();
    await http(LOCAL, `/api/sessions/${sid}/close`, {});
    await step('đóng session', () => feed.wait((e) => e.type === 'state' && e.sessionId === sid && !e.live, 30_000, mark));
    const lst: SessionSummary[] = (await http(LOCAL, '/api/sessions')).data;
    const s = lst.find((x) => x.id === sid);
    check('đóng session: hết live, không báo "nơi khác"', !!s && !s.live && !s.elsewhere, s ? `live=${s.live} elsewhere=${s.elsewhere}` : 'không thấy');
    mark = feed.mark();
    await http(LOCAL, `/api/sessions/${sid}/send`, { text: 'Chỉ trả lời một từ: nội dung tệp a.txt là gì? Nhớ từ trước, không dùng tool.' });
    await step('chạy tiếp session đã đóng', () => feed.wait(isResult(sid), 120_000, mark));
    const resumed = textOf(feed.events.slice(mark), sid);
    check('chạy tiếp (resume) còn nhớ ngữ cảnh', /alpha/i.test(resumed), resumed.slice(0, 40));
    const msgs = await http(LOCAL, `/api/sessions/${sid}/messages`);
    check('đọc lại lịch sử từ transcript', msgs.status === 200 && msgs.data.messages.length >= 6, `${msgs.data.messages?.length} tin`);
    await http(LOCAL, `/api/sessions/${sid}/close`, {});
  }
  feed.close();
}

// 4. Session trên máy khác qua tailnet -------------------------------------------------------------
if (!only.size || only.has('remote')) {
  for (const m of remotes) {
    const feed = new Feed(m.url!);
    const ok = await step(`[${m.name}] WebSocket qua tailnet`, () => feed.ready.then(() => true));
    if (!ok) continue;
    check(`[${m.name}] WebSocket qua tailnet`, true);
    const sid = await step(`[${m.name}] tạo session`, () => newSession(m.url!, REMOTE_CWD, 'Chỉ trả lời đúng một từ: SESSIONMON_OK. Không dùng tool.', 'plan'));
    if (sid) {
      await step(`[${m.name}] nhận kết quả`, () => feed.wait(isResult(sid)));
      check(`[${m.name}] điều khiển session từ xa`, /SESSIONMON_OK/.test(textOf(feed.events, sid)), textOf(feed.events, sid).slice(0, 30));
      await http(m.url!, `/api/sessions/${sid}/close`, {});
    }
    feed.close();
  }
}

// 5. Sắp xếp và đồng bộ ----------------------------------------------------------------------------
if (!only.size || only.has('library')) {
  const list: SessionSummary[] = (await http(LOCAL, '/api/sessions')).data;
  const target = list[list.length - 1];
  const key = `${info.self.name}:${target.id}`;
  const before = (await http(LOCAL, '/api/library')).data.library as Library;
  const prev = before.sessions[key];

  const f = await http(LOCAL, '/api/library/folder', { name: 'smoke-test' });
  check('tạo thư mục', f.status === 200 && !!f.data.id);
  const folderId: string = f.data.id;
  const set = await http(LOCAL, '/api/library/session', { key, folder: folderId, tags: ['smoke', '#trùng', 'smoke'], pinned: true, title: 'Tên thử' });
  const e = set.data.library?.sessions?.[key];
  check('ghim + thư mục + nhãn + đổi tên', set.status === 200 && e?.pinned && e?.folder === folderId && e?.title === 'Tên thử', JSON.stringify(e?.tags));
  check('nhãn bỏ trùng, bỏ dấu #', JSON.stringify(e?.tags) === JSON.stringify(['smoke', 'trùng']), JSON.stringify(e?.tags));
  const badKey = await http(LOCAL, '/api/library/session', { key: 'không-hợp-lệ', pinned: true });
  check('từ chối khoá session sai', badKey.status === 400);
  const noName = await http(LOCAL, '/api/library/folder', {});
  check('từ chối thư mục không tên', noName.status === 400, `HTTP ${noName.status}`);

  for (const m of remotes) {
    const t0 = Date.now();
    let seen = false;
    while (Date.now() - t0 < 90_000) {
      const r = (await http(m.url!, '/api/library')).data;
      if (r.library?.sessions?.[key]?.folder === folderId && r.library.folders?.[folderId]?.name === 'smoke-test') {
        seen = true;
        break;
      }
      await Bun.sleep(3000);
    }
    check(`đồng bộ ${info.self.name} → ${m.name}`, seen, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
    // Chiều ngược lại: máy kia đổi tên thư mục.
    await http(m.url!, '/api/library/folder', { id: folderId, name: 'smoke-test-2' });
    const t1 = Date.now();
    let back = false;
    while (Date.now() - t1 < 90_000) {
      const r = (await http(LOCAL, '/api/library')).data;
      if (r.library?.folders?.[folderId]?.name === 'smoke-test-2') {
        back = true;
        break;
      }
      await Bun.sleep(3000);
    }
    check(`đồng bộ ${m.name} → ${info.self.name}`, back, `${((Date.now() - t1) / 1000).toFixed(0)}s`);
  }

  // Dọn: xoá thư mục, trả session về như cũ.
  await http(LOCAL, '/api/library/folder', { id: folderId, deleted: true });
  await http(LOCAL, '/api/library/session', { key, folder: prev?.folder ?? null, tags: prev?.tags ?? [], pinned: !!prev?.pinned, title: prev?.title ?? '' });
  const after = (await http(LOCAL, '/api/library')).data.library as Library;
  check('dọn dữ liệu thử', after.folders[folderId]?.deleted === true && !after.sessions[key]?.pinned === !prev?.pinned);
}

// 6. Tệp tĩnh và PWA -------------------------------------------------------------------------------
if (!only.size || only.has('pwa')) {
  const html = await (await fetch(LOCAL + '/')).text();
  check('trang chính có nội dung', html.includes('SessionMon') && html.length > 1000, `${html.length} byte`);
  const manifestHref = html.match(/rel="manifest" href="([^"]+)"/)?.[1];
  const manifestUrl = manifestHref ? new URL(manifestHref, LOCAL + '/').href : '';
  const mf = manifestUrl ? await fetch(manifestUrl) : null;
  const manifest = mf?.ok ? await mf.json() : null;
  check('manifest đọc được', !!manifest && manifest.display === 'standalone' && manifest.icons?.length >= 2, manifestUrl.replace(LOCAL, ''));
  for (const icon of manifest?.icons ?? []) {
    const r = await fetch(new URL(icon.src, LOCAL + '/'));
    check(`icon ${icon.sizes}${icon.purpose ? ' ' + icon.purpose : ''}`, r.ok && (r.headers.get('content-type') ?? '').includes('png'));
  }
  const sw = await fetch(LOCAL + '/sw.js');
  check('service worker', sw.ok && (sw.headers.get('content-type') ?? '').includes('javascript'));
  for (const m of [info.self, ...remotes].filter((x) => x.url)) {
    const r = await fetch(m.url! + '/', { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    check(`[${m.name}] HTTPS trong tailnet`, !!r?.ok, m.url!);
  }
}

// ---------------------------------------------------------------------------------------------------
for (const o of opened) await http(o.base, `/api/sessions/${o.id}/close`, {}).catch(() => {});
console.log(`\n${passed} đạt, ${failed} hỏng`);
process.exit(failed ? 1 : 0);
