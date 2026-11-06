// Chạy giao diện SessionMon với dữ liệu giả để xem và chụp màn hình khi sửa giao diện, không cần agent thật,
// không gọi Claude, không đụng ~/.claude hay nhánh sessionmon-library.
//   bun run scripts/ui-preview.ts            -> http://127.0.0.1:7430
//   Mở session mẫu: http://127.0.0.1:7430/#A/s1   (s1 có thẻ duyệt quyền đang chờ)
// Chụp màn hình: scripts/ui-shots.ts.
import index from '../web/index.html';
import type { ChatMessage, Library, PermissionAsk, ServerEvent, SessionSummary, UsageInfo } from '../src/protocol.ts';

const port = Number(process.env.PREVIEW_PORT ?? 7430);
const now = Date.now();
const min = 60_000;

const sessions: SessionSummary[] = [
  { id: 's1', title: 'Sửa giao diện bảng SessionMon', cwd: 'D:\\Projects\\sessionmon', lastModified: now - 2 * min, createdAt: now - 90 * min, live: true, state: 'requires_action', elsewhere: false, turnStartedAt: now - 47_000 },
  { id: 's2', title: 'Tối ưu pathfinding cho map isometric', cwd: 'D:\\Projects\\tower-defense', lastModified: now - 5 * min, createdAt: now - 3 * 60 * min, live: true, state: 'running', elsewhere: false, turnStartedAt: now - 3 * min - 12_000 },
  { id: 's3', title: 'Viết patch notes 1.4.2', cwd: 'D:\\Projects\\tower-defense', lastModified: now - 50 * min, createdAt: now - 26 * 60 * min, live: true, state: 'idle', elsewhere: false },
  { id: 's4', title: 'Shader nước cho level biển', cwd: 'D:\\Projects\\tower-defense', lastModified: now - 26 * 60 * min, live: false, state: 'idle', elsewhere: true },
  { id: 's5', title: 'Dọn ổ đĩa D', cwd: 'C:\\Users\\dev', lastModified: now - 4 * 24 * 60 * min, live: false, state: 'idle', elsewhere: false },
  { id: 's6', title: 'Hỏi nhanh về thuế TNCN', cwd: 'C:\\Users\\dev\\SessionMon\\scratch-workspaces\\scratch-20261028-091500', lastModified: now - 30 * min, live: false, state: 'idle', elsewhere: false },
];

// Báo cáo HTML mẫu (session s1 gửi bằng send_user_file) để xem thẻ và trình xem HTML.
const reportHtml = `<!doctype html><html lang="vi"><meta charset="utf-8"><title>Báo cáo</title>
<style>body{font:15px/1.6 system-ui;margin:0;padding:32px;background:#fafaf7;color:#222}h1{margin-top:0}
.kpi{display:flex;gap:12px}.kpi div{flex:1;background:#fff;border:1px solid #ddd;border-radius:10px;padding:14px}</style>
<h1>Báo cáo hiệu năng tuần 43</h1><p>Trang mẫu của bản xem trước giao diện.</p>
<div class="kpi"><div><b>58 fps</b><br>Trung bình</div><div><b>-12%</b><br>Thời gian tải</div><div><b>3</b><br>Lỗi mới</div></div>
<script>document.body.insertAdjacentHTML('beforeend', '<p>Script trong báo cáo chạy được.</p>')</script></html>`;

const library: Library = {
  version: 1,
  folders: { f1: { name: 'Đang làm', order: 0, updatedAt: now } },
  sessions: {
    'A:s1': { pinned: true, updatedAt: now },
    'A:s3': { folder: 'f1', tags: ['release'], updatedAt: now },
  },
  paths: {},
  projects: {},
  projectDefs: {
    p1: { name: 'sessionmon', code: 'SM', roots: [{ machine: 'A', path: 'D:\\Projects\\sessionmon' }, { machine: 'B', path: 'D:\\Projects\\sessionmon' }], order: 0, updatedAt: now },
    p2: { name: 'Tower Defense', code: 'TD', roots: [{ machine: 'A', path: 'D:\\Projects\\tower-defense' }], order: 1, updatedAt: now },
  },
  tasks: {
    t1: { project: 'p1', num: 1, title: 'Trang task cho dự án', body: 'Mỗi task có **mã**, chữ và ảnh.\n\n- Dán ảnh vào ô mô tả\n- Bấm ảnh để xem cỡ lớn', images: [{ sha: 'a'.repeat(40), type: 'image/png', name: 'icon.png' }], status: 'doing', priority: 'high', version: '1.2.0', createdAt: now - 2 * 86_400_000, updatedAt: now },
    t2: { project: 'p1', num: 2, title: 'Dọn session cũ quá 30 ngày', body: '', images: [], status: 'todo', priority: 'urgent', version: '1.2.0', createdAt: now - 86_400_000, updatedAt: now },
    t4: { project: 'p1', num: 4, title: 'Đồng bộ task với tracker công ty', body: '', images: [], status: 'pending', priority: 'low', createdAt: now - 86_400_000, updatedAt: now },
    t3: { project: 'p1', num: 3, title: 'Chọn nhiều session để xoá', body: '', images: [], status: 'done', version: '1.1.0', createdAt: now - 3 * 86_400_000, updatedAt: now },
  },
  checklists: {
    c1: { project: 'p1', name: 'Verify trước khi release', notes: 'Build bằng `bun run build`. Không sửa code.', items: [
      { id: 'h1', text: 'Build', heading: true },
      { id: 'i1', text: 'Typecheck sạch (tsc --noEmit)' },
      { id: 'i2', text: 'Không còn console.log debug' },
      { id: 'h2', text: 'Giao diện', heading: true },
      { id: 'i3', text: 'Ảnh bấm phóng to được' },
      { id: 'i4', text: 'Chụp màn hình cả 3 theme, sáng và tối' },
    ], createdAt: now - 5 * 86_400_000, updatedAt: now },
  },
  checklistRuns: {
    r1: { project: 'p1', checklist: 'c1', name: 'Verify trước khi release', notes: 'Build bằng `bun run build`. Không sửa code.', version: '1.2.0', items: [
      { id: 'h1', text: 'Build', heading: true },
      { id: 'i1', text: 'Typecheck sạch (tsc --noEmit)' },
      { id: 'i2', text: 'Không còn console.log debug' },
      { id: 'h2', text: 'Giao diện', heading: true },
      { id: 'i3', text: 'Ảnh bấm phóng to được' },
      { id: 'i4', text: 'Chụp màn hình cả 3 theme, sáng và tối' },
    ], createdAt: now - 3 * 3_600_000, updatedAt: now },
  },
  checkResults: {
    'r1:i1': { run: 'r1', item: 'i1', result: 'pass', note: 'tsc --noEmit: 0 lỗi', by: 'claude', session: 'A:s1', updatedAt: now - 60 * min },
    'r1:i2': { run: 'r1', item: 'i2', result: 'fail', note: 'web/app.ts:1203 còn console.log(\'debug ws\')', by: 'claude', session: 'A:s1', updatedAt: now - 58 * min },
    'r1:i4': { run: 'r1', item: 'i4', result: 'skip', note: 'Cần người xem ảnh', by: 'claude', session: 'A:s1', updatedAt: now - 55 * min },
  },
};

const usage: UsageInfo = {
  provider: 'claude', enabled: true, account: 'a1', email: 'an@example.com', phase: 'active', fetchedAt: now,
  fiveHour: 64, resetsAt: now + 95 * min, weekly: 31, weeklyResetsAt: now + 3 * 24 * 60 * min,
};

const ask: PermissionAsk = {
  requestId: 'r1', sessionId: 's1', toolName: 'Bash',
  input: { command: 'git push origin main', description: 'Đẩy commit lên GitHub' },
  title: 'Claude muốn chạy lệnh Bash', canAlwaysAllow: true,
};

const md = `Đã sửa xong cách hiện bảng. Tóm tắt:

| # | Việc | Cách làm | Công sức |
|---|---|---|---|
| 0.1 | Bộ token | Gom màu, viền, bo góc, font thành biến CSS trong \`:root\` | M |
| 0.2 | Chọn theme | Claude / Retro, mỗi kiểu có Sáng / Tối / Theo máy | S |

Đoạn mã chính:

\`\`\`ts
export function enhanceTables(html: string): string {
  if (!html.includes('<table')) return html;
  return wrap(html);
}
\`\`\`

Bảng để dán lên Google Sheet (TSV, cột cách bằng tab):

\`\`\`tsv
Mã\tViệc\tCông sức
0.1\tBộ token\tM
0.2\tChọn theme\tS
\`\`\`

Lệnh dài cuộn ngang được:

\`\`\`
bun run scripts/ui-shots.ts "%TEMP%\\sessionmon-shots" "http://127.0.0.1:7430/#Z/s3" --một-tham-số-rất-dài-để-thử-cuộn-ngang-trên-điện-thoại
\`\`\`

Xem thêm [tài liệu Bun](https://bun.sh) nếu cần.`;

const messages: ChatMessage[] = [
  { id: 'u1', at: now - 9 * min, role: 'user', blocks: [{ type: 'text', text: 'Bảng trên điện thoại khó đọc, sửa giúp tôi' }] },
  { id: 'a1', at: now - 9 * min - 4_000, role: 'assistant', blocks: [{ type: 'thinking', text: 'Cần xem md() render bảng thế nào…' }] },
  { id: 'a2', at: now - 9 * min - 20_000, role: 'assistant', blocks: [
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'grep -n "md(" web/app.ts' } },
    { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'D:\\Projects\\sessionmon\\web\\style.css' } },
    { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: 'D:\\Projects\\sessionmon\\web\\app.ts', old_string: 'a', new_string: 'b' } },
  ] },
  { id: 'r1', at: now - 8 * min, role: 'user', blocks: [
    { type: 'tool_result', toolUseId: 't1', text: '1126:function md(text: string): string {', isError: false },
    { type: 'tool_result', toolUseId: 't2', text: ':root { … }', isError: false },
    { type: 'tool_result', toolUseId: 't3', text: 'ok', isError: false },
  ] },
  { id: 'a3', at: now - 7 * min + 10_000, role: 'assistant', blocks: [{ type: 'text', text: md }] },
  { id: 'a4', at: now - 7 * min + 2_000, role: 'assistant', blocks: [{ type: 'files', toolUseId: 't9', caption: 'Báo cáo hiệu năng', files: [
    { name: 'bao-cao-tuan-43.html', path: 'D:\\Projects\\sessionmon\\reports\\bao-cao-tuan-43.html', url: '/api/file/demo/bao-cao-tuan-43.html', kind: 'html', exists: true },
  ] }] },
  { id: 'u2', at: now - 47_000, role: 'user', blocks: [{ type: 'text', text: 'Ok, push lên đi' }] },
];

const question: PermissionAsk = {
  requestId: 'q1', sessionId: 's2', toolName: 'AskUserQuestion', canAlwaysAllow: false,
  input: { questions: [
    { header: 'Phạm vi', question: 'Server mới có Country + Report. Các phần còn lại CHƯA có API. Làm phần đó thế nào?', multiSelect: false, options: [
      { label: 'Client đủ + hợp đồng giả định (Recommended)', description: 'Làm đủ UI + logic client, tự đặt contract rồi viết spec gửi dev server' },
      { label: 'Chỉ làm Country + Report', description: 'Phần còn lại để đợt sau' },
      { label: 'Được sửa server luôn', description: 'Viết cả phần server' } ] },
    { header: 'Report', question: 'Nút Report đặt ở đâu?', multiSelect: false, options: [
      { label: 'Theo demo, bỏ thanh react (Recommended)', description: 'Nhấn giữ hoặc ⋮ → menu' }, { label: 'Theo GDD', description: 'Icon cạnh tên người gửi' } ] },
    { header: 'Dịch', question: 'Bật những gì cho tính năng dịch?', multiSelect: true, options: [
      { label: 'Tự động dịch', description: 'Lưu PlayerPrefs' }, { label: 'Nút dịch từng tin' } ] },
  ] },
};

const send = (ws: { send(s: string): void }, e: ServerEvent) => ws.send(JSON.stringify(e));

Bun.serve({
  port,
  hostname: process.env.PREVIEW_HOST ?? '127.0.0.1',
  routes: {
    '/': index,
    '/api/info': () => Response.json({
      self: { name: 'A', computer: 'PREVIEW-A' },
      machines: [{ name: 'A', computer: 'PREVIEW-A' }, { name: 'B', computer: 'PREVIEW-B' }],
      modes: ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'],
    }),
    '/api/sessions/:id/messages': (req) => Response.json({
      messages: req.params.id === 's1' ? messages : req.params.id === 's3' ? messages.slice(0, -1) : messages.slice(0, 1),
      pending: [],
      meta: { model: 'claude-opus-5-5', effort: 'medium', mode: 'bypassPermissions', context: { used: 84_000, max: 200_000, percent: 42, estimated: true } },
    }),
    '/api/models': () => Response.json({ models: [] }),
    '/api/commands': () => Response.json([]),
    '/api/usage': () => Response.json(usage),
    '/api/library/image/:sha': () => new Response(Bun.file(new URL('../web/public/icon-192.png', import.meta.url))),
    '/api/library/task': async (req) => {
      const b: any = await req.json();
      const id = b.id ?? crypto.randomUUID();
      const prev = library.tasks[id];
      const num = prev?.num ?? 1 + Math.max(0, ...Object.values(library.tasks).filter((t) => t.project === (b.project ?? prev?.project)).map((t) => t.num));
      library.tasks[id] = { project: b.project ?? prev.project, num, title: b.title ?? prev?.title ?? '', body: b.body ?? prev?.body ?? '', images: b.images ?? prev?.images ?? [], status: b.status ?? prev?.status ?? 'todo', priority: b.priority ?? prev?.priority, version: 'version' in b ? b.version || undefined : prev?.version, createdAt: prev?.createdAt ?? Date.now(), deleted: b.deleted ?? prev?.deleted, updatedAt: Date.now() };
      return Response.json({ id, library, sync: 'ok' });
    },
    '/api/library/checklist': async (req) => {
      const b: any = await req.json();
      const id = b.id ?? crypto.randomUUID();
      const prev = library.checklists[id];
      const items = (b.items ?? prev?.items ?? []).map((i: any) => ({ ...i, id: i.id || crypto.randomUUID().slice(0, 8) }));
      library.checklists[id] = { project: b.project ?? prev.project, name: b.name ?? prev?.name, notes: b.notes ?? prev?.notes ?? '', items, createdAt: prev?.createdAt ?? Date.now(), deleted: b.deleted ?? prev?.deleted, updatedAt: Date.now() };
      return Response.json({ id, library, sync: 'ok' });
    },
    '/api/library/checklist-run': async (req) => {
      const b: any = await req.json();
      const id = b.id ?? crypto.randomUUID().slice(0, 13);
      const prev = library.checklistRuns[id];
      const c = library.checklists[b.checklist];
      const base = prev ?? { project: c.project, checklist: b.checklist, name: c.name, notes: c.notes, items: c.items, createdAt: Date.now(), updatedAt: 0 };
      library.checklistRuns[id] = { ...base, version: 'version' in b ? b.version || undefined : base.version, deleted: b.deleted ?? base.deleted, updatedAt: Date.now() };
      return Response.json({ id, library, sync: 'ok' });
    },
    '/api/library/check-result': async (req) => {
      const b: any = await req.json();
      library.checkResults[`${b.run}:${b.item}`] = { run: b.run, item: b.item, result: b.result, note: b.note || undefined, by: 'user', updatedAt: Date.now() };
      return Response.json({ library, sync: 'ok' });
    },
    '/api/library/projectdef': async (req) => {
      const b: any = await req.json();
      const id = b.id ?? crypto.randomUUID();
      const prev = library.projectDefs[id];
      library.projectDefs[id] = { name: b.name ?? prev.name, code: (b.code || prev?.code || 'P').toUpperCase(), roots: b.roots ?? prev?.roots ?? [], order: b.order ?? prev?.order ?? 9, deleted: b.deleted ?? prev?.deleted, updatedAt: Date.now() };
      return Response.json({ id, library, sync: 'ok' });
    },
    '/api/path-check': async (req) => Response.json({ ok: true, path: ((await req.json()) as any).path }),
    '/api/file/:token/*': () => new Response(reportHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    '/public/*': (req) => new Response(Bun.file(new URL('../web' + new URL(req.url).pathname, import.meta.url))),
  },
  fetch(req, server) {
    if (new URL(req.url).pathname === '/ws' && server.upgrade(req)) return;
    return Response.json({});
  },
  websocket: {
    open(ws) {
      send(ws, { type: 'sessions', sessions });
      send(ws, { type: 'library', library, sync: 'ok' });
      send(ws, { type: 'usage', usage });
      send(ws, { type: 'permission', ask });
      send(ws, { type: 'permission', ask: question });
      // Session khác vừa xong lượt: thẻ báo trong app.
      setTimeout(() => send(ws, { type: 'result', sessionId: 's3', ok: true, durationMs: 134_000 }), 1200);
    },
    message() {},
  },
  development: true,
});
console.log(`SessionMon preview: http://127.0.0.1:${port}/#A/s1`);
