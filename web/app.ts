// Giao diện SessionMon: nối tới agent của mọi máy trong machines.json, gộp session theo máy.
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { htmlViewerOpen, openHtmlViewer } from './htmlview.ts';
import { makeZoomable, openLightbox } from './lightbox.ts';
import { enhanceTables, inScrollableTable, setupTables } from './mdtable.ts';
import { enhanceCode, messageCopyButton, setupCopy, setupTurnHover } from './copy.ts';
import { setThemePref, setupTheme, themePref } from './theme.ts';
import { disablePush, enablePush, push, setupPush, testPush } from './push.ts';
import type {
  Block,
  ChatMessage,
  ContextInfo,
  DeleteResult,
  Effort,
  CheckResult,
  ChecklistItem,
  FileRef,
  Library,
  LibraryChecklist,
  LibraryChecklistRun,
  LibraryProjectDef,
  LibraryTask,
  MachineInfo,
  ModelOption,
  PermissionAsk,
  ProjectRoot,
  ServerEvent,
  SessionMeta,
  SessionSummary,
  SlashCommandInfo,
  SyncState,
  TaskImage,
  TaskPriority,
  TaskStatus,
  UsageInfo,
} from '../src/protocol.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Tên chế độ quyền giữ tiếng Anh như trong Claude Code.
const MODE_LABELS: Record<string, string> = {
  default: 'Ask permissions',
  acceptEdits: 'Accept edits',
  auto: 'Auto',
  plan: 'Plan mode',
  bypassPermissions: 'Bypass permissions',
};
// Mặc định cho session mới: Opus 5.5 · Medium · Bypass permissions.
const NEW_SESSION_MODE = 'bypassPermissions';
const NEW_SESSION_EFFORT: Effort = 'medium';

// Một agent trên một máy.
interface Conn {
  machine: MachineInfo;
  // '' = cùng nguồn với trang; còn lại là https://<host>.<tailnet>.ts.net
  base: string | null;
  ok: boolean;
  sessions: SessionSummary[];
  retry: number;
  usage?: UsageInfo;
  // Lúc nối WebSocket: yêu cầu duyệt agent phát lại ngay sau đó là cái cũ, không báo lại.
  openedAt?: number;
}

const state = {
  self: null as MachineInfo | null,
  modes: [] as string[],
  conns: [] as Conn[],
  current: null as { conn: Conn; id: string } | null,
  messages: [] as ChatMessage[],
  streaming: '',
  asks: new Map<string, PermissionAsk & { machine: string }>(),
  lastResult: null as { ok: boolean; error?: string } | null,
  filter: '',
  collapsed: new Set<string>(),
  library: { version: 1, folders: {}, sessions: {}, paths: {}, projects: {}, projectDefs: {}, tasks: {}, checklists: {}, checklistRuns: {}, checkResults: {} } as Library,
  sync: 'pending' as SyncState,
  syncError: undefined as string | undefined,
};

// ---------- API ----------

async function api<T = any>(conn: Conn, path: string, init?: { body?: unknown }): Promise<T> {
  if (conn.base === null) throw new Error(`Máy ${conn.machine.name} chưa vào Tailscale`);
  const res = await fetch(conn.base + path, {
    method: init?.body ? 'POST' : 'GET',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  }).catch((err) => {
    throw new Error(err?.name === 'TimeoutError' ? `Agent ${conn.machine.name} không phản hồi, thử lại` : `Không nối được ${conn.machine.name}`);
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

// ---------- WebSocket ----------

function connect(conn: Conn) {
  if (conn.base === null) return;
  const url = conn.base ? conn.base.replace(/^http/, 'ws') + '/ws' : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const ws = new WebSocket(url);
  ws.onopen = () => {
    conn.retry = 0;
    conn.openedAt = Date.now();
    conn.ok = true;
    renderSessions();
    renderConn();
    if (isDraft()) fillMachineOptions();
    if (state.current?.conn === conn && state.current.id) void loadMessages(conn, state.current.id);
  };
  ws.onmessage = (ev) => handle(conn, JSON.parse(ev.data) as ServerEvent);
  ws.onclose = () => {
    const was = conn.ok;
    conn.ok = false;
    if (was) {
      for (const [id, a] of state.asks) if (a.machine === conn.machine.name) state.asks.delete(id);
      renderAsks();
    }
    renderSessions();
    renderConn();
    setTimeout(() => connect(conn), Math.min(15_000, 1000 * 2 ** conn.retry++));
  };
}

function renderConn() {
  const up = state.conns.filter((c) => c.ok).map((c) => c.machine.name);
  const down = state.conns.filter((c) => !c.ok).map((c) => c.machine.name);
  $('conn').classList.toggle('ok', down.length === 0);
  $('connText').textContent = [up.length ? `Đã nối ${up.join(', ')}` : '', down.length ? `Mất ${down.join(', ')}` : '']
    .filter(Boolean)
    .join(' · ');
}

// Session mới chưa gửi tin: state.current có id rỗng.
const isDraft = () => !!state.current && !state.current.id;
const isCurrent = (conn: Conn, id: string) => state.current?.conn === conn && state.current.id === id;

function handle(conn: Conn, e: ServerEvent) {
  switch (e.type) {
    case 'sessions':
      conn.sessions = e.sessions;
      renderSessions();
      renderHeader();
      // Màn session mới mở trước khi danh sách về: điền thư mục gần nhất khi đã có.
      if (isDraft() && state.current!.conn === conn && !newCwd) fillCwds();
      break;
    case 'state': {
      const s = conn.sessions.find((x) => x.id === e.sessionId);
      if (s) {
        s.state = e.state;
        s.live = e.live;
        s.turnStartedAt = e.turnStartedAt;
        if (e.live) s.elsewhere = false;
      }
      renderSessions();
      if (isCurrent(conn, e.sessionId)) {
        if (!e.live) state.streaming = '';
        renderHeader();
        renderMessages();
      }
      break;
    }
    case 'delta':
      if (!isCurrent(conn, e.sessionId)) break;
      state.streaming += e.text;
      renderStreaming();
      break;
    case 'message':
      if (!isCurrent(conn, e.sessionId)) break;
      if (e.message.role === 'assistant' && e.message.blocks.some((b) => b.type === 'text')) state.streaming = '';
      state.lastResult = null;
      // Tin của chính thiết bị này đã hiện sẵn lúc gửi; agent phát lại cùng id thì bỏ qua.
      if (!state.messages.some((m) => m.id === e.message.id)) state.messages.push(e.message);
      renderMessages();
      break;
    case 'result':
      // Bị ngắt (bấm dừng) thì không báo.
      if (e.ok || e.error !== 'error_during_execution')
        alertUser(conn, e.sessionId, e.ok ? '✓ Xong' : '⚠ Lỗi', e.ok ? (e.durationMs ? `làm trong ${fmtDuration(e.durationMs)}` : '') : (e.error ?? ''));
      if (!isCurrent(conn, e.sessionId)) break;
      state.streaming = '';
      state.lastResult = { ok: e.ok, error: e.error };
      renderMessages();
      break;
    case 'permission':
      state.asks.set(e.ask.requestId, { ...e.ask, machine: conn.machine.name });
      renderAsks();
      alertUser(conn, e.ask.sessionId, askLabel(e.ask), e.ask.title ?? '', e.ask.requestId);
      break;
    case 'permission_done':
      state.asks.delete(e.requestId);
      questionStates.delete(e.requestId);
      questionCards.delete(e.requestId);
      renderAsks();
      break;
    case 'error':
      if (!e.sessionId || isCurrent(conn, e.sessionId)) {
        state.lastResult = { ok: false, error: e.error };
        renderMessages();
      }
      break;
    case 'meta':
      if (!isCurrent(conn, e.sessionId)) break;
      meta = { ...meta, ...e.meta };
      renderComposerMeta();
      break;
    case 'usage':
      conn.usage = e.usage;
      renderUsage();
      break;
    case 'library':
      // Cách sắp xếp lấy từ agent của máy đang phục vụ trang; agent các máy tự đồng bộ với nhau qua git.
      if (conn.base !== '') break;
      state.library = e.library;
      state.sync = e.sync;
      state.syncError = e.syncError;
      // Đang sửa task thì không vẽ lại (giữ chữ đang gõ và con trỏ).
      if (taskView && !taskView.editing) renderTasks();
      renderSessions();
      renderHeader();
      renderSync();
      break;
  }
}

const askLabel = (ask: PermissionAsk) =>
  ask.toolName === 'AskUserQuestion' ? 'Claude đang hỏi' : ask.toolName === 'ExitPlanMode' ? 'Cần duyệt kế hoạch' : `Cần duyệt: ${toolName(ask.toolName)}`;

// Yêu cầu duyệt đã báo (agent phát lại yêu cầu đang chờ mỗi khi nối lại).
const alerted = new Set<string>();

// Báo session xong lượt / cần duyệt. Đang xem app: hiện thẻ nhỏ trong app (trừ khi đang xem đúng session đó).
// Không xem app: thiết bị đã bật thông báo đẩy thì agent đẩy (src/push.ts), chưa bật thì hiện thông báo của trình duyệt.
function alertUser(conn: Conn, sessionId: string, what: string, detail: string, askId?: string) {
  if (askId) {
    if (alerted.has(askId)) return;
    alerted.add(askId);
    if (Date.now() - (conn.openedAt ?? 0) < 3000) return;
  }
  const s = conn.sessions.find((x) => x.id === sessionId);
  const title = s ? titleOf(conn, s) : 'Session';
  const viewing = document.visibilityState === 'visible' && document.hasFocus();
  if (viewing) {
    const looking = isCurrent(conn, sessionId) && (!isMobile() || $('app').classList.contains('chat-open'));
    if (!looking) showToast(`${what} · ${title}`, [`Máy ${conn.machine.name}`, detail].filter(Boolean).join(' · '), () => openSession(conn, sessionId));
    return;
  }
  if (push.on && document.visibilityState === 'hidden') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const body = [`Máy ${conn.machine.name}`, detail].filter(Boolean).join(' · ');
  const opts = { body, tag: `${conn.machine.name}:${sessionId}`, data: { url: `/#${encodeURIComponent(conn.machine.name)}/${sessionId}` } };
  // Trên điện thoại (PWA) phải đi qua service worker mới hiện được thông báo.
  void navigator.serviceWorker?.getRegistration().then((reg) => {
    if (reg) void reg.showNotification(`${what} · ${title}`, opts);
    else new Notification(`${what} · ${title}`, opts);
  });
}

// Thẻ báo nhỏ góc màn hình, bấm để mở session; tự ẩn sau 6 giây.
function showToast(title: string, body: string, onOpen: () => void) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = Object.assign(document.createElement('div'), { id: 'toasts', className: 'toasts' });
    box.setAttribute('role', 'status');
    document.body.append(box);
  }
  const t = document.createElement('button');
  t.type = 'button';
  t.className = 'toast';
  t.append(
    Object.assign(document.createElement('span'), { className: 'toast-title', textContent: title }),
    Object.assign(document.createElement('span'), { className: 'toast-body', textContent: body }),
  );
  const close = () => t.remove();
  t.onclick = () => {
    close();
    onOpen();
  };
  box.append(t);
  while (box.children.length > 3) box.firstElementChild!.remove();
  setTimeout(close, 6000);
}

// ---------- Thời gian ----------

// Giờ gửi: hôm nay chỉ ghi giờ, ngày khác ghi thêm ngày.
function msgClock(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now.getTime() - 86_400_000);
  if (d.toDateString() === y.toDateString()) return `${hm} hôm qua`;
  return `${hm} ${d.getDate()}/${d.getMonth() + 1}${d.getFullYear() !== now.getFullYear() ? '/' + d.getFullYear() : ''}`;
}

function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} giây`;
  const m = Math.floor(sec / 60);
  if (m < 60) return sec % 60 ? `${m} phút ${sec % 60} giây` : `${m} phút`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} giờ ${m % 60} phút` : `${h} giờ`;
}

// Đồng hồ đếm lên gọn: 0:07, 12:34, 1:02:03.
function fmtElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

// Phần tử có data-since đếm lên mỗi giây (thời gian session đang chạy).
function sinceEl(since: number, prefix = '', cls = 'since'): HTMLSpanElement {
  const el = Object.assign(document.createElement('span'), { className: cls });
  el.dataset.since = String(since);
  el.dataset.prefix = prefix;
  el.textContent = prefix + fmtElapsed(Date.now() - since);
  return el;
}

function tickSince() {
  const now = Date.now();
  for (const el of document.querySelectorAll<HTMLElement>('[data-since]')) el.textContent = (el.dataset.prefix ?? '') + fmtElapsed(now - Number(el.dataset.since));
}

// ---------- Danh sách session ----------

function timeAgo(ms: number): string {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return 'vừa xong';
  if (d < 3600) return `${Math.floor(d / 60)} phút`;
  if (d < 86400) return `${Math.floor(d / 3600)} giờ`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} ngày`;
  return new Date(ms).toLocaleDateString('vi-VN');
}

function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? cwd;
}

function hasAsk(conn: Conn, id: string) {
  return [...state.asks.values()].some((a) => a.machine === conn.machine.name && a.sessionId === id);
}

type Activity = 'waiting' | 'running' | 'open' | '';

function activityOf(conn: Conn, s: SessionSummary): Activity {
  if (hasAsk(conn, s.id) || s.state === 'requires_action') return 'waiting';
  if (s.state === 'running') return 'running';
  if (s.live) return 'open';
  return '';
}

const ACTIVITY_LABEL: Record<Activity, string> = { waiting: 'chờ duyệt', running: 'đang chạy', open: 'đang mở', '': '' };

// Chỉ hiện các session đang hoạt động (bấm nút "◉ N đang chạy" ở đầu danh sách).
let onlyActive = false;

// Chế độ chọn nhiều (nút ☑ cạnh ô tìm): bấm session hay ô vuông của nhóm để chọn, rồi xoá / chuyển thư mục cùng lúc.
let selecting = false;
const selected = new Set<string>();

function renderActivityPill() {
  let running = 0;
  let waiting = 0;
  for (const c of state.conns)
    for (const s of c.sessions) {
      const a = activityOf(c, s);
      if (a === 'running') running++;
      else if (a === 'waiting') waiting++;
    }
  const pill = $('activityPill');
  const total = running + waiting;
  pill.hidden = !total && !onlyActive;
  pill.classList.toggle('on', onlyActive);
  pill.classList.toggle('waiting', waiting > 0);
  const full = total ? [running && `${running} đang chạy`, waiting && `${waiting} chờ duyệt`].filter(Boolean).join(' · ') : 'Không có gì đang chạy';
  // Máy tính: đầu cột trái chật (thêm nút Giao diện + Hệ thống) nên dùng chữ gọn, câu đầy đủ ở title.
  pill.textContent = total && !isMobile() ? [running && `${running} chạy`, waiting && `${waiting} chờ`].filter(Boolean).join(' · ') : full;
  pill.title = full + ' · ' + (onlyActive ? 'Bấm để hiện lại mọi session' : 'Bấm để chỉ xem session đang hoạt động');
}

function dotClass(conn: Conn, s: SessionSummary): string {
  if (hasAsk(conn, s.id) || s.state === 'requires_action') return 'requires_action';
  if (s.state === 'running') return 'running';
  if (s.live) return 'live';
  if (s.elsewhere) return 'elsewhere';
  return '';
}

const libKey = (conn: Conn, id: string) => `${conn.machine.name}:${id}`;
const entryOf = (conn: Conn, id: string) => state.library.sessions[libKey(conn, id)];
const titleOf = (conn: Conn, s: SessionSummary) => entryOf(conn, s.id)?.title || s.title;
const selfConn = () => state.conns.find((c) => c.base === '');

function liveFolders() {
  return Object.entries(state.library.folders)
    .filter(([, f]) => !f.deleted)
    .sort(([, a], [, b]) => a.order - b.order || a.name.localeCompare(b.name));
}

// "#nhãn" lọc đúng nhãn; còn lại tìm trong tên, thư mục làm việc và nhãn.
function matches(conn: Conn, s: SessionSummary, q: string): boolean {
  if (!q) return true;
  const tags = entryOf(conn, s.id)?.tags ?? [];
  if (q.startsWith('#')) return tags.some((t) => t.toLowerCase() === q.slice(1));
  return titleOf(conn, s).toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q) || tags.some((t) => t.toLowerCase().includes(q));
}

// ---------- Chế độ xem danh sách, trạng thái đóng / mở (nhớ trên thiết bị này) ----------

type SideView = 'machine' | 'project' | 'time';
type TimeBasis = 'active' | 'created';

function loadPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem('sessionmon:' + key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function savePref(key: string, v: unknown) {
  try {
    localStorage.setItem('sessionmon:' + key, JSON.stringify(v));
  } catch {}
}

let sideView: SideView = loadPref<SideView>('view', 'machine');
let timeBasis: TimeBasis = loadPref<TimeBasis>('timeBasis', 'active');
// Nhóm mặc định mở mà người dùng đã đóng, và nhóm mặc định đóng mà người dùng đã mở.
const closedGroups = new Set<string>(loadPref<string[]>('closed', []));
const openedGroups = new Set<string>(loadPref<string[]>('opened', []));

function isGroupOpen(key: string, defaultOpen: boolean) {
  // Đang tìm kiếm: mở hết để thấy kết quả.
  if (state.filter.trim()) return true;
  return defaultOpen ? !closedGroups.has(key) : openedGroups.has(key);
}

function toggleGroup(key: string, defaultOpen: boolean) {
  const set = defaultOpen ? closedGroups : openedGroups;
  set.has(key) ? set.delete(key) : set.add(key);
  savePref('closed', [...closedGroups]);
  savePref('opened', [...openedGroups]);
  renderSessions();
}

// level 0: nhóm chính; 1, 2: nhóm con (thụt vào, chữ nhỏ hơn).
function sectionHead(
  key: string,
  text: string,
  meta: string,
  cls: string,
  menu?: (anchor: HTMLElement) => void,
  opts: { defaultOpen?: boolean; level?: number; title?: string; items?: Item[] } = {},
) {
  const defaultOpen = opts.defaultOpen ?? true;
  const head = document.createElement('div');
  head.className = `section-head level-${opts.level ?? 0} ${cls}`;
  const open = isGroupOpen(key, defaultOpen);
  // Chế độ chọn: ô vuông chọn / bỏ chọn mọi session trong nhóm (kể cả khi nhóm đang đóng).
  if (selecting && opts.items?.length) {
    const keys = opts.items.map(({ conn, s }) => libKey(conn, s.id));
    const n = keys.filter((k) => selected.has(k)).length;
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'sel-box', checked: n === keys.length });
    box.indeterminate = n > 0 && n < keys.length;
    box.setAttribute('aria-label', `Chọn mọi session trong ${text}`);
    box.onchange = () => {
      for (const k of keys) n === keys.length ? selected.delete(k) : selected.add(k);
      renderSessions();
    };
    head.append(box);
  }
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'section-toggle';
  toggle.setAttribute('aria-expanded', String(open));
  if (opts.title) toggle.title = opts.title;
  toggle.append(
    Object.assign(document.createElement('span'), { className: 'chev', textContent: open ? '▾' : '▸' }),
    Object.assign(document.createElement('span'), { className: 'mdot' }),
    Object.assign(document.createElement('span'), { className: 'mname', textContent: text }),
    Object.assign(document.createElement('span'), { className: 'mmeta', textContent: meta }),
  );
  toggle.onclick = () => toggleGroup(key, defaultOpen);
  head.append(toggle);
  if (menu && !selecting) {
    const more = button('⋯', 'more-btn', () => menu(more));
    more.setAttribute('aria-label', `Tuỳ chọn ${text}`);
    head.append(more);
  }
  return { head, open };
}

function renderViewSwitch() {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#viewSwitch button')) {
    const on = b.dataset.view === sideView;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  }
  $('timeBasis').hidden = sideView !== 'time';
  for (const b of document.querySelectorAll<HTMLButtonElement>('#timeBasis button')) b.classList.toggle('on', b.dataset.basis === timeBasis);
}

function setupViewSwitch() {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#viewSwitch button'))
    b.onclick = () => {
      sideView = b.dataset.view as SideView;
      savePref('view', sideView);
      renderViewSwitch();
      renderSessions();
    };
  for (const b of document.querySelectorAll<HTMLButtonElement>('#timeBasis button'))
    b.onclick = () => {
      timeBasis = b.dataset.basis as TimeBasis;
      savePref('timeBasis', timeBasis);
      renderViewSwitch();
      renderSessions();
    };
  renderViewSwitch();
}

function sessionRow(conn: Conn, s: SessionSummary, showMachine: boolean, showProject = false) {
  const row = document.createElement('div');
  row.className = 'session' + (isCurrent(conn, s.id) ? ' active' : '');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'session-main';
  const title = titleOf(conn, s);
  b.title = `${title}\n${s.cwd}`;
  const dot = document.createElement('span');
  dot.className = 'state-dot ' + dotClass(conn, s);
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = title;
  const tags = entryOf(conn, s.id)?.tags ?? [];
  if (tags.length)
    name.append(Object.assign(document.createElement('span'), { className: 'tags', textContent: ' ' + tags.map((t) => '#' + t).join(' ') }));
  b.append(dot);
  if (showMachine) b.append(Object.assign(document.createElement('span'), { className: 'mbadge', textContent: conn.machine.name }));
  if (showProject && s.cwd) name.append(Object.assign(document.createElement('span'), { className: 'proj', textContent: ' · ' + projectLabel(conn, s.cwd) }));
  const shownAt = showProject && timeBasis === 'created' ? (s.createdAt ?? s.lastModified) : s.lastModified;
  const act = activityOf(conn, s);
  if (act) row.classList.add('act-' + act);
  const busy = act === 'running' || act === 'waiting';
  b.append(
    name,
    // Đang chạy: chỉ hiện đồng hồ (chấm màu đã báo trạng thái) cho tên session đỡ bị cắt.
    act === 'running' && s.turnStartedAt
      ? sinceEl(s.turnStartedAt, '', 'time')
      : Object.assign(document.createElement('span'), { className: 'time', textContent: busy ? ACTIVITY_LABEL[act] : timeAgo(shownAt) }),
  );
  if (selecting) {
    const key = libKey(conn, s.id);
    const on = selected.has(key);
    row.classList.add('selectable');
    row.classList.toggle('selected', on);
    const box = Object.assign(document.createElement('span'), { className: 'sel-mark', textContent: on ? '✓' : '' });
    box.setAttribute('aria-hidden', 'true');
    b.prepend(box);
    b.setAttribute('aria-pressed', String(on));
    b.onclick = () => {
      on ? selected.delete(key) : selected.add(key);
      renderSessions();
    };
    row.append(b);
    return row;
  }
  b.onclick = () => openSession(conn, s.id);
  const more = button('⋯', 'more-btn', () => openSessionMenu(conn, s, more));
  more.setAttribute('aria-label', 'Tuỳ chọn session');
  row.append(b, more);
  return row;
}

type Item = { conn: Conn; s: SessionSummary };

const UNKNOWN_CWD = '(không rõ thư mục)';
const SCRATCH = 'Session tự do';

// Nhóm theo thư mục làm việc. Session tự do (không thuộc dự án) nằm trong scratch-workspaces/…/scratch-<ngày>: của
// SessionMon (~/SessionMon/scratch-workspaces) hay của Claude desktop khi mở không chọn thư mục. Gom tất cả về một nhóm.
const isScratch = (cwd: string) => /[\\/]scratch-workspaces[\\/]/i.test(cwd);
function cwdGroup(cwd: string): { key: string; name: string } {
  if (!cwd) return { key: '?', name: UNKNOWN_CWD };
  if (isScratch(cwd)) return { key: 'scratch', name: SCRATCH };
  return { key: cwd.toLowerCase(), name: folderName(cwd) };
}

// Dự án = các thư mục làm việc cùng tên (gộp giữa các máy). Tên hiển thị tự đặt nằm trong library.projects.
function projectOf(cwd: string): { key: string; name: string } {
  const cg = cwdGroup(cwd);
  const key = cg.key === 'scratch' || cg.key === '?' ? cg.key : cg.name.toLowerCase();
  return { key, name: state.library.projects?.[key]?.name || cg.name };
}

// Dự án tự tạo (library.projectDefs), theo thứ tự đặt.
function liveProjects(): [string, LibraryProjectDef][] {
  return Object.entries(state.library.projectDefs ?? {})
    .filter(([, p]) => !p.deleted)
    .sort(([, a], [, b]) => a.order - b.order || a.name.localeCompare(b.name, 'vi'));
}

const normPath = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

// Dự án tự tạo chứa thư mục làm việc này (đúng thư mục gốc hoặc thư mục con của nó); gốc dài nhất thắng.
function defOf(machine: string, cwd: string): string | null {
  if (!cwd) return null;
  const c = normPath(cwd);
  let best: string | null = null;
  let len = -1;
  for (const [id, p] of liveProjects())
    for (const r of p.roots) {
      const root = normPath(r.path);
      if (r.machine === machine && (c === root || c.startsWith(root + '\\')) && root.length > len) {
        best = id;
        len = root.length;
      }
    }
  return best;
}

// Tên dự án để hiện cạnh session: dự án tự tạo nếu có, không thì tên nhóm theo thư mục.
function projectLabel(conn: Conn, cwd: string): string {
  const d = defOf(conn.machine.name, cwd);
  return d ? state.library.projectDefs[d].name : projectOf(cwd).name;
}

const taskCode = (t: LibraryTask) => `${state.library.projectDefs[t.project]?.code ?? '?'}-${t.num}`;
const liveTasks = (project: string) =>
  Object.entries(state.library.tasks ?? {}).filter(([, t]) => t.project === project && !t.deleted);
const indent = (el: HTMLElement) => (el.classList.add('indent'), el);
const empty = (text: string) => Object.assign(document.createElement('div'), { className: 'group-label', textContent: text });

function renderSessions() {
  const list = $('sessionList');
  const q = state.filter.trim().toLowerCase();
  list.replaceChildren();
  renderActivityPill();
  const all: Item[] = state.conns.flatMap((conn) =>
    conn.sessions.filter((s) => matches(conn, s, q) && (!onlyActive || activityOf(conn, s))).map((s) => ({ conn, s })),
  );
  const newest = (a: Item, b: Item) => b.s.lastModified - a.s.lastModified;
  const folders = liveFolders();
  const folderIds = new Set(folders.map(([id]) => id));

  // 1. Đã ghim, gom từ mọi máy (mọi chế độ xem).
  const pinned = all.filter(({ conn, s }) => entryOf(conn, s.id)?.pinned).sort(newest);
  if (pinned.length) {
    const { head, open } = sectionHead('pinned', 'Đã ghim', String(pinned.length), 'pinned', undefined, { items: pinned });
    list.append(head);
    if (open) for (const { conn, s } of pinned) list.append(sessionRow(conn, s, true));
  }

  // 2. Thư mục tự đặt, chứa session của bất kỳ máy nào.
  for (const [id, f] of folders) {
    const items = all.filter(({ conn, s }) => entryOf(conn, s.id)?.folder === id && !entryOf(conn, s.id)?.pinned).sort(newest);
    if (q && !items.length) continue;
    const { head, open } = sectionHead('folder:' + id, f.name, String(items.length), 'folder', (anchor) => openFolderMenu(id, anchor, items), { items });
    list.append(head);
    if (open) for (const { conn, s } of items) list.append(sessionRow(conn, s, true));
  }

  const unsorted = all.filter(({ conn, s }) => {
    const e = entryOf(conn, s.id);
    return !e?.pinned && !(e?.folder && folderIds.has(e.folder));
  });
  // 3. Phần còn lại, theo chế độ xem. Session tự do (không thuộc dự án) chỉ thành nhóm riêng ở chế độ Dự án;
  // ở Máy và Thời gian chúng nằm chung với session khác.
  if (sideView === 'project') {
    const free = unsorted.filter(({ s }) => isScratch(s.cwd)).sort(newest);
    if (free.length) {
      const menu = (anchor: HTMLElement) => openGroupMenu(anchor, SCRATCH, free, 'scratch', undefined, true);
      const { head, open } = sectionHead('scratch', SCRATCH, String(free.length), 'scratch', menu, { defaultOpen: false, items: free });
      list.append(head);
      if (open) for (const { conn, s } of free) list.append(sessionRow(conn, s, true));
    }
    renderByProject(list, unsorted.filter(({ s }) => !isScratch(s.cwd)));
    if (!selecting && !q) list.append(button('＋ Dự án mới…', 'add-project', () => openProjectDialog(null)));
  } else if (sideView === 'time') renderByTime(list, unsorted);
  else renderByMachine(list, unsorted);
  renderSelectBar();
}

function machineMeta(conn: Conn, count: number) {
  const waiting = conn.sessions.filter((s) => hasAsk(conn, s.id)).length;
  return conn.base === null ? 'chưa vào Tailscale' : !conn.ok ? 'mất kết nối' : waiting ? `${waiting} chờ duyệt` : String(count);
}

// Máy → thư mục làm việc (nhóm con, mặc định đóng) → session.
function renderByMachine(list: HTMLElement, rest: Item[]) {
  for (const conn of state.conns) {
    const mine = rest.filter((x) => x.conn === conn).map((x) => x.s);
    const mkey = 'machine:' + conn.machine.name;
    const { head, open } = sectionHead(mkey, `Máy ${conn.machine.name}`, machineMeta(conn, mine.length), 'machine' + (conn.ok ? ' ok' : ''), undefined, {
      items: mine.map((s) => ({ conn, s })),
    });
    list.append(head);
    if (!open) continue;
    const groups = new Map<string, { name: string; cwd: string; sessions: SessionSummary[] }>();
    for (const s of mine) {
      const g = cwdGroup(s.cwd);
      if (!groups.has(g.key)) {
        // Đúng thư mục gốc của một dự án tự tạo thì mang tên dự án đó.
        const d = defOf(conn.machine.name, s.cwd);
        const exact = d && state.library.projectDefs[d].roots.some((r) => r.machine === conn.machine.name && normPath(r.path) === normPath(s.cwd));
        groups.set(g.key, { name: exact ? state.library.projectDefs[d!].name : projectOf(s.cwd).name, cwd: g.key === 'scratch' ? '' : s.cwd, sessions: [] });
      }
      groups.get(g.key)!.sessions.push(s);
    }
    for (const [gk, { name, cwd, sessions }] of groups) {
      const items = sessions.map((s) => ({ conn, s }));
      const here = cwd ? { conn, cwd } : undefined;
      const menu = (anchor: HTMLElement) => openGroupMenu(anchor, name, items, projectOf(sessions[0].cwd).key, here);
      const title = cwd;
      const g = sectionHead(`${mkey}|${gk}`, name, String(sessions.length), 'sub', menu, {
        defaultOpen: false,
        level: 1,
        title,
        items,
      });
      list.append(g.head);
      if (g.open) for (const s of sessions) list.append(indent(sessionRow(conn, s, false)));
    }
    if (conn.ok && !mine.length) list.append(empty(state.filter.trim() ? 'Không có session khớp' : 'Đã sắp xếp hết'));
  }
}

// Dự án tự tạo (theo thứ tự đặt) → Task + máy → session. Session không thuộc dự án tự tạo nào gom vào "Khác",
// chia nhóm theo tên thư mục (gộp giữa các máy). Chưa tạo dự án nào thì các nhóm thư mục nằm ngay cấp đầu như cũ.
function renderByProject(list: HTMLElement, rest: Item[]) {
  const defs = liveProjects();
  const byDef = new Map<string, Item[]>(defs.map(([id]) => [id, []]));
  const others: Item[] = [];
  for (const it of rest) {
    const d = defOf(it.conn.machine.name, it.s.cwd);
    if (d) byDef.get(d)!.push(it);
    else others.push(it);
  }
  const q = state.filter.trim();
  for (const [id, p] of defs) {
    const items = byDef.get(id)!.sort((a, b) => b.s.lastModified - a.s.lastModified);
    if (q && !items.length) continue;
    const open = liveTasks(id).filter(([, t]) => t.status !== 'done').length;
    const machines = [...new Set(p.roots.map((r) => r.machine))];
    const pk = 'pdef:' + id;
    const g = sectionHead(pk, p.name, [p.code, ...machines, String(items.length)].join(' · '), 'project def', (anchor) => openProjectMenu(id, anchor, items), {
      defaultOpen: false,
      title: p.roots.map((r) => `${r.machine}: ${r.path}`).join('\n'),
      items,
    });
    list.append(g.head);
    if (!g.open) continue;
    if (!selecting) list.append(indent(taskLinkRow(id, open)));
    if (!selecting && liveChecklists(id).length) list.append(indent(checklistLinkRow(id)));
    for (const conn of state.conns) {
      const mine = items.filter((x) => x.conn === conn);
      if (!mine.length) continue;
      const h = sectionHead(`${pk}|${conn.machine.name}`, `Máy ${conn.machine.name}`, String(mine.length), 'machine sub' + (conn.ok ? ' ok' : ''), undefined, {
        defaultOpen: true,
        level: 1,
        items: mine,
      });
      list.append(h.head);
      if (h.open) for (const { s } of mine) list.append(indent(sessionRow(conn, s, false)));
    }
  }

  // Nhóm theo tên thư mục cho phần còn lại.
  const groups = new Map<string, { name: string; paths: Set<string>; items: Item[]; latest: number }>();
  for (const it of others) {
    const { key, name } = projectOf(it.s.cwd);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { name, paths: new Set(), items: [], latest: 0 }));
    if (it.s.cwd && key !== 'scratch') g.paths.add(`${it.conn.machine.name}: ${it.s.cwd}`);
    g.items.push(it);
    g.latest = Math.max(g.latest, it.s.lastModified);
  }
  const sorted = [...groups.entries()].sort(([, a], [, b]) => b.latest - a.latest);
  if (!sorted.length && !defs.length) list.append(empty(q ? 'Không có session khớp' : 'Chưa có session nào'));
  if (!sorted.length) return;
  // Có dự án tự tạo: phần còn lại nằm trong nhóm "Khác" (mặc định đóng) cho danh sách gọn.
  const nested = defs.length > 0;
  if (nested) {
    const h = sectionHead('pdef:other', 'Khác', String(others.length), 'other', undefined, { defaultOpen: false, items: others });
    list.append(h.head);
    if (!h.open) return;
  }
  for (const [key, g] of sorted) {
    const machines = [...new Set(g.items.map((x) => x.conn.machine.name))];
    const pk = 'project:' + key;
    const latest = [...g.items].sort((a, b) => b.s.lastModified - a.s.lastModified)[0];
    // Session mới ở đây: thư mục của session gần nhất trong nhóm (đúng máy của nó).
    const here = key !== 'scratch' && key !== '?' && latest?.s.cwd ? { conn: latest.conn, cwd: latest.s.cwd } : undefined;
    const menu = (anchor: HTMLElement) => openGroupMenu(anchor, g.name, g.items, key, here);
    const h = sectionHead(pk, g.name, `${machines.join(' · ')} · ${g.items.length}`, 'project' + (nested ? ' sub' : ''), menu, {
      defaultOpen: false,
      level: nested ? 1 : 0,
      title: [...g.paths].join('\n'),
      items: g.items,
    });
    list.append(h.head);
    if (!h.open) continue;
    if (nested) {
      for (const { conn, s } of [...g.items].sort((a, b) => b.s.lastModified - a.s.lastModified)) list.append(indent(sessionRow(conn, s, true)));
      continue;
    }
    for (const conn of state.conns) {
      const items = g.items.filter((x) => x.conn === conn).sort((a, b) => b.s.lastModified - a.s.lastModified);
      if (!items.length) continue;
      const m = sectionHead(`${pk}|${conn.machine.name}`, `Máy ${conn.machine.name}`, String(items.length), 'machine sub' + (conn.ok ? ' ok' : ''), undefined, {
        defaultOpen: true,
        level: 1,
        items,
      });
      list.append(m.head);
      if (m.open) for (const { s } of items) list.append(indent(sessionRow(conn, s, false)));
    }
  }
}

// Dòng "Task" đầu mỗi dự án tự tạo: bấm để mở trang task của dự án.
function taskLinkRow(project: string, open: number) {
  const row = document.createElement('div');
  row.className = 'session task-link' + (taskView?.project === project && taskView.tab === 'tasks' ? ' active' : '');
  const b = button('', 'session-main', () => openTasks(project));
  b.append(
    Object.assign(document.createElement('span'), { className: 'task-ico', textContent: '☰' }),
    Object.assign(document.createElement('span'), { className: 'name', textContent: 'Task' }),
    Object.assign(document.createElement('span'), { className: 'time', textContent: open ? `${open} chưa xong` : '' }),
  );
  row.append(b);
  return row;
}

// Dòng "Checklist" dưới dòng Task (chỉ khi dự án đã có checklist): số lượt chạy còn mục lỗi hoặc chưa kiểm.
function checklistLinkRow(project: string) {
  const row = document.createElement('div');
  row.className = 'session task-link' + (taskView?.project === project && taskView.tab === 'checklists' ? ' active' : '');
  const b = button('', 'session-main', () => openTasks(project, null, 'checklists'));
  const runs = liveRuns(project);
  const failing = runs.filter(([id, r]) => runStats(id, r).fail).length;
  b.append(
    Object.assign(document.createElement('span'), { className: 'task-ico', textContent: '✓' }),
    Object.assign(document.createElement('span'), { className: 'name', textContent: 'Checklist' }),
    Object.assign(document.createElement('span'), { className: 'time', textContent: failing ? `${failing} lượt có lỗi` : '' }),
  );
  row.append(b);
  return row;
}

// Hôm nay / Hôm qua / 2–7 ngày / Cũ hơn, theo lần hoạt động gần nhất hoặc ngày tạo.
function renderByTime(list: HTMLElement, rest: Item[]) {
  const at = (s: SessionSummary) => (timeBasis === 'created' ? (s.createdAt ?? s.lastModified) : s.lastModified);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const t0 = startOfToday.getTime();
  const DAY = 86_400_000;
  const buckets = [
    { key: 'today', name: 'Hôm nay', min: t0, open: true },
    { key: 'yesterday', name: 'Hôm qua', min: t0 - DAY, open: true },
    { key: 'week', name: '2–7 ngày', min: t0 - 7 * DAY, open: false },
    { key: 'older', name: 'Cũ hơn', min: -Infinity, open: false },
  ];
  const sorted = [...rest].sort((a, b) => at(b.s) - at(a.s));
  if (!sorted.length) list.append(empty(state.filter.trim() ? 'Không có session khớp' : 'Chưa có session nào'));
  let from = 0;
  for (const bk of buckets) {
    let to = from;
    while (to < sorted.length && at(sorted[to].s) >= bk.min) to++;
    const items = sorted.slice(from, to);
    from = to;
    if (!items.length) continue;
    const { head, open } = sectionHead(`time:${timeBasis}:${bk.key}`, bk.name, String(items.length), 'time', undefined, { defaultOpen: bk.open, items });
    list.append(head);
    if (open) for (const { conn, s } of items) list.append(sessionRow(conn, s, true, true));
  }
}

// ---------- Menu sắp xếp ----------

// sub: dòng phụ chữ mờ (vd đường dẫn đầy đủ).
type MenuItem = { label: string; sub?: string; run: () => void; on?: boolean; danger?: boolean } | string;
let menuEl: HTMLElement | null = null;

const isMobile = () => matchMedia('(max-width: 760px)').matches;

function closeMenu() {
  menuEl?.remove();
  menuEl = null;
  document.querySelector('.menu-backdrop')?.remove();
}

// Máy tính: menu nổi cạnh nút. Điện thoại: tấm trồi lên từ đáy, có lớp nền tối, bấm ra ngoài để đóng.
// matchWidth: menu rộng bằng nút mở nó (kiểu dropdown).
function showMenu(anchor: HTMLElement, items: MenuItem[], heading?: string, matchWidth = false) {
  closeMenu();
  const sheet = isMobile();
  // Hộp thoại modal nằm ở top layer: menu phải nằm trong hộp thoại thì mới hiện lên trên.
  const host = anchor.closest('dialog[open]') ?? document.body;
  const m = document.createElement('div');
  m.className = 'menu' + (sheet ? ' sheet' : '');
  m.setAttribute('role', 'menu');
  if (sheet && heading) m.append(Object.assign(document.createElement('div'), { className: 'menu-title', textContent: heading }));
  for (const it of items) {
    if (typeof it === 'string') {
      m.append(Object.assign(document.createElement('div'), { className: 'menu-label', textContent: it }));
      continue;
    }
    const b = button(it.sub ? '' : (it.on ? '✓ ' : '') + it.label, 'menu-item' + (it.sub ? ' two-line' : '') + (it.on ? ' on' : '') + (it.danger ? ' danger' : ''), () => {
      closeMenu();
      it.run();
    });
    if (it.sub) {
      b.append(
        Object.assign(document.createElement('span'), { className: 'mi-label', textContent: it.label }),
        Object.assign(document.createElement('span'), { className: 'mi-sub', textContent: `(${it.sub})` }),
      );
      b.title = it.sub;
    }
    b.setAttribute('role', 'menuitem');
    m.append(b);
  }
  if (sheet) {
    const backdrop = Object.assign(document.createElement('div'), { className: 'menu-backdrop' });
    backdrop.onclick = closeMenu;
    host.append(backdrop);
    m.append(button('Huỷ', 'menu-item menu-cancel', closeMenu));
  }
  host.append(m);
  if (!sheet) {
    const r = anchor.getBoundingClientRect();
    if (matchWidth) {
      // Dropdown: rộng bằng ô chọn, nằm ngay dưới (hoặc ngay trên nếu dưới hẹp), cuộn trong phần còn trống.
      m.style.width = `${Math.min(r.width, innerWidth - 16)}px`;
      m.style.maxWidth = 'none';
      const below = innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const down = below >= 240 || below >= above;
      m.style.maxHeight = `${Math.max(160, down ? below : above)}px`;
      m.style.top = `${down ? r.bottom + 4 : Math.max(8, r.top - 4 - m.offsetHeight)}px`;
    } else if (r.bottom + 4 + m.offsetHeight > innerHeight - 8 && r.top > innerHeight / 2) {
      // Nút nằm thấp (vd hàng nút của ô nhập): mở lên trên, cuộn trong phần còn trống.
      m.style.maxHeight = `${r.top - 12}px`;
      m.style.top = `${Math.max(8, r.top - 4 - m.offsetHeight)}px`;
    } else {
      m.style.top = `${Math.max(8, Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8))}px`;
    }
    const left = matchWidth ? r.left : r.right - m.offsetWidth;
    m.style.left = `${Math.max(8, Math.min(left, innerWidth - m.offsetWidth - 8))}px`;
    (m.querySelector('button') as HTMLButtonElement | null)?.focus();
  }
  menuEl = m;
}

async function saveEntry(conn: Conn, id: string, patch: Record<string, unknown>) {
  const self = selfConn();
  if (!self) return alert('Không nối được agent của máy đang mở trang');
  try {
    const r = await api<{ library: Library }>(self, '/api/library/session', { body: { key: libKey(conn, id), ...patch } });
    state.library = r.library;
    renderSessions();
    renderHeader();
  } catch (err) {
    alert((err as Error).message);
  }
}

async function saveFolder(body: Record<string, unknown>): Promise<string | null> {
  const self = selfConn();
  if (!self) return null;
  try {
    const r = await api<{ id: string; library: Library }>(self, '/api/library/folder', { body });
    state.library = r.library;
    renderSessions();
    return r.id;
  } catch (err) {
    alert((err as Error).message);
    return null;
  }
}

// Hộp nhập chữ thay cho prompt() của trình duyệt: mở lên là chọn sẵn toàn bộ chữ để gõ đè ngay.
// Enter = Lưu, Esc / Huỷ / chạm ra ngoài = null.
function askText(label: string, value = ''): Promise<string | null> {
  return new Promise((done) => {
    closeMenu();
    const dlg = document.createElement('dialog');
    dlg.className = 'ask-text';
    const form = document.createElement('form');
    form.method = 'dialog';
    const title = Object.assign(document.createElement('label'), { className: 'ask-text-label', textContent: label });
    const input = Object.assign(document.createElement('input'), { type: 'text', value, autocomplete: 'off', spellcheck: false });
    input.id = 'askTextInput';
    title.htmlFor = input.id;
    const row = Object.assign(document.createElement('div'), { className: 'ask-text-actions' });
    const cancel = button('Huỷ', 'ghost-btn', () => dlg.close());
    const ok = Object.assign(document.createElement('button'), { type: 'submit', className: 'primary-btn', textContent: 'Lưu' });
    row.append(cancel, ok);
    form.append(title, input, row);
    dlg.append(form);
    let result: string | null = null;
    form.onsubmit = () => {
      result = input.value;
    };
    // Chạm vào nền tối bên ngoài hộp thì đóng.
    dlg.onclick = (e) => {
      if (e.target === dlg) dlg.close();
    };
    dlg.onclose = () => {
      dlg.remove();
      done(result);
    };
    document.body.append(dlg);
    dlg.showModal();
    input.focus();
    input.select();
    input.setSelectionRange(0, input.value.length);
  });
}

async function newFolder(): Promise<string | null> {
  const name = (await askText('Tên thư mục mới'))?.trim();
  return name ? saveFolder({ name }) : null;
}

function openSessionMenu(conn: Conn, s: SessionSummary, anchor: HTMLElement) {
  showMenu(anchor, sessionMenuItems(conn, s), titleOf(conn, s));
}

function sessionMenuItems(conn: Conn, s: SessionSummary): MenuItem[] {
  const e = entryOf(conn, s.id);
  const items: MenuItem[] = [
    { label: e?.pinned ? 'Bỏ ghim' : 'Ghim', run: () => saveEntry(conn, s.id, { pinned: !e?.pinned }) },
    {
      label: 'Đổi tên…',
      run: async () => {
        const t = await askText('Tên hiển thị (để trống để dùng tên gốc)', e?.title ?? s.title);
        if (t !== null) void saveEntry(conn, s.id, { title: t.trim() === s.title ? '' : t });
      },
    },
    {
      label: 'Nhãn…',
      run: async () => {
        const t = await askText('Nhãn, cách nhau bằng dấu phẩy', (e?.tags ?? []).join(', '));
        if (t !== null) void saveEntry(conn, s.id, { tags: t.split(',').map((x) => x.trim().replace(/^#/, '')).filter(Boolean) });
      },
    },
    'Chuyển vào thư mục',
  ];
  for (const [id, f] of liveFolders()) items.push({ label: f.name, on: e?.folder === id, run: () => saveEntry(conn, s.id, { folder: id }) });
  items.push({
    label: '＋ Thư mục mới…',
    run: async () => {
      const id = await newFolder();
      if (id) await saveEntry(conn, s.id, { folder: id });
    },
  });
  if (e?.folder) items.push({ label: 'Bỏ khỏi thư mục', run: () => saveEntry(conn, s.id, { folder: null }) });
  items.push({ label: 'Xoá session…', danger: true, run: () => void confirmDelete([{ conn, s }], `session "${titleOf(conn, s)}"`) });
  return items;
}

// Chuyển nhiều session vào một thư mục bằng một lần gọi.
async function saveEntries(items: Item[], patch: Record<string, unknown>) {
  const self = selfConn();
  if (!self) return alert('Không nối được agent của máy đang mở trang');
  if (!items.length) return;
  try {
    const keys = items.map(({ conn, s }) => libKey(conn, s.id));
    const r = await api<{ library: Library }>(self, '/api/library/session', { body: { keys, ...patch } });
    state.library = r.library;
    renderSessions();
    renderHeader();
  } catch (err) {
    alert((err as Error).message);
  }
}

// Xoá session: agent của từng máy chuyển tệp lịch sử vào Thùng rác của máy đó (khôi phục được từ Thùng rác).
// Trả true khi người dùng đã đồng ý xoá.
async function confirmDelete(items: Item[], what: string): Promise<boolean> {
  if (!items.length) return false;
  const machines = [...new Set(items.map((x) => x.conn.machine.name))];
  const offline = machines.filter((m) => !connByName(m)?.ok);
  if (offline.length) {
    alert(`Máy ${offline.join(', ')} đang mất kết nối, chưa xoá được.`);
    return false;
  }
  const notes: string[] = [];
  const running = items.filter(({ s }) => s.live).length;
  const elsewhere = items.filter(({ s }) => s.elsewhere).length;
  if (running) notes.push(`${running} session đang chạy sẽ bị dừng.`);
  if (elsewhere) notes.push(`${elsewhere} session có thể đang mở ở nơi khác (Claude desktop, CLI).`);
  const where = `Lịch sử chat chuyển vào Thùng rác của máy ${machines.join(', ')}, khôi phục được từ đó.`;
  if (!confirm([`Xoá ${what}?`, where, ...notes].join('\n\n'))) return false;
  const failed: string[] = [];
  for (const conn of state.conns) {
    const ids = items.filter((x) => x.conn === conn).map(({ s }) => s.id);
    // Agent nhận tối đa 200 session mỗi lần.
    for (let i = 0; i < ids.length; i += 200) {
      try {
        const r = await api<DeleteResult>(conn, '/api/sessions/delete', { body: { ids: ids.slice(i, i + 200) } });
        for (const f of r.failed) failed.push(`${conn.machine.name}: ${f.error}`);
        const gone = new Set(r.deleted);
        conn.sessions = conn.sessions.filter((s) => !gone.has(s.id));
        for (const id of gone) selected.delete(libKey(conn, id));
        if (state.current?.conn === conn && gone.has(state.current.id)) openNewDraft();
      } catch (err) {
        failed.push(`${conn.machine.name}: ${(err as Error).message}`);
      }
    }
  }
  renderSessions();
  renderHeader();
  if (failed.length) alert(`Có ${failed.length} session chưa xoá được:\n` + [...new Set(failed)].slice(0, 5).join('\n'));
  return true;
}

// Session mới trong một thư mục làm việc trên một máy.
// conn null: máy đang mở (như nút Session mới).
function newSessionIn(conn: Conn | null, cwd: string, scratch = false) {
  stopVoice();
  if (conn) enterDraft(conn);
  else openNewDraft();
  setCwd(cwd, scratch);
  if (!isMobile()) $('input').focus();
}

// Nút ⋯ của nhóm dự án (chế độ xem Dự án) và nhóm thư mục làm việc (chế độ xem Máy).
function openGroupMenu(anchor: HTMLElement, name: string, items: Item[], projectKey: string, here?: { conn: Conn; cwd: string }, scratch = false) {
  const menu: MenuItem[] = [];
  if (here) menu.push({ label: 'Session mới ở đây', sub: `Máy ${here.conn.machine.name}: ${here.cwd}`, run: () => newSessionIn(here.conn, here.cwd) });
  if (scratch) menu.push({ label: 'Session tự do mới', run: () => newSessionIn(null, '', true) });
  if (projectKey !== '?') {
    const cur = state.library.projects?.[projectKey]?.name;
    menu.push({
      label: 'Đổi tên dự án…',
      run: async () => {
        const t = await askText('Tên hiển thị của dự án (để trống để dùng tên thư mục)', cur ?? name);
        if (t !== null) void saveProject(projectKey, t.trim());
      },
    });
  }
  // Gộp nhóm thư mục này vào một dự án tự tạo (thêm thư mục gốc), hoặc tạo dự án mới từ nó.
  if (projectKey !== '?' && projectKey !== 'scratch') {
    menu.push('Đưa vào dự án');
    for (const [id, p] of liveProjects()) menu.push({ label: p.name, run: () => void addRootsToProject(id, items) });
    menu.push({ label: '＋ Dự án mới từ nhóm này…', run: () => openProjectDialog(null, groupRoots(items)) });
  }
  menu.push('Chuyển cả nhóm vào thư mục');
  for (const [id, f] of liveFolders()) menu.push({ label: f.name, run: () => saveEntries(items, { folder: id }) });
  menu.push({
    label: '＋ Thư mục mới…',
    run: async () => {
      const id = await newFolder();
      if (id) await saveEntries(items, { folder: id });
    },
  });
  menu.push({ label: `Xoá ${items.length} session…`, danger: true, run: () => void confirmDelete(items, `${items.length} session trong "${name}"`) });
  showMenu(anchor, menu, name);
}

async function saveProject(key: string, name: string) {
  const self = selfConn();
  if (!self) return alert('Không nối được agent của máy đang mở trang');
  try {
    const r = await api<{ library: Library }>(self, '/api/library/project', { body: { key, name } });
    state.library = r.library;
    renderSessions();
  } catch (err) {
    alert((err as Error).message);
  }
}

// Nút ⋯ trên thanh trên: chế độ quyền, dừng, đóng tiến trình, rồi các mục sắp xếp.
function openTopMenu(anchor: HTMLElement) {
  const cur = state.current;
  const s = current();
  if (!cur || !s) return;
  const items: MenuItem[] = [];
  if (s.live) {
    items.push('Tiến trình');
    if (s.state !== 'idle')
      items.push({ label: 'Dừng lượt đang chạy', run: () => void api(cur.conn, `/api/sessions/${cur.id}/interrupt`, { body: {} }) });
    items.push({ label: 'Đóng tiến trình (giữ lịch sử)', run: () => void api(cur.conn, `/api/sessions/${cur.id}/close`, { body: {} }) });
    items.push('Sắp xếp');
  }
  items.push(...sessionMenuItems(cur.conn, s));
  showMenu(anchor, items, titleOf(cur.conn, s));
}

// Đổi chỗ thư mục với thư mục kề trên (dir = -1) hoặc kề dưới (dir = 1); đánh lại thứ tự cho liền mạch.
async function moveFolder(id: string, dir: -1 | 1) {
  const ids = liveFolders().map(([fid]) => fid);
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  for (const [order, fid] of ids.entries()) if (state.library.folders[fid].order !== order) await saveFolder({ id: fid, order });
}

function openFolderMenu(id: string, anchor: HTMLElement, items: Item[] = []) {
  const f = state.library.folders[id];
  const ids = liveFolders().map(([fid]) => fid);
  const pos = ids.indexOf(id);
  const menu: MenuItem[] = [];
  if (pos > 0) menu.push({ label: 'Lên trên', run: () => void moveFolder(id, -1) });
  if (pos >= 0 && pos < ids.length - 1) menu.push({ label: 'Xuống dưới', run: () => void moveFolder(id, 1) });
  menu.push(
    {
      label: 'Đổi tên…',
      run: async () => {
        const name = (await askText('Tên thư mục', f.name))?.trim();
        if (name) void saveFolder({ id, name });
      },
    },
    {
      label: 'Xoá thư mục',
      run: () => {
        if (confirm(`Xoá thư mục "${f.name}"? Session bên trong quay về danh sách của từng máy.`)) void saveFolder({ id, deleted: true });
      },
    },
  );
  if (items.length)
    menu.push({ label: `Xoá ${items.length} session bên trong…`, danger: true, run: () => void confirmDelete(items, `${items.length} session trong thư mục "${f.name}"`) });
  showMenu(anchor, menu, f.name);
}

function renderSync() {
  const el = $('sync');
  const labels: Record<SyncState, string> = { ok: 'Đã đồng bộ', pending: 'Đang đồng bộ…', offline: 'Chưa đồng bộ (mất mạng)', error: 'Lỗi đồng bộ' };
  el.textContent = labels[state.sync];
  el.title = state.syncError ?? '';
  el.className = 'sync ' + state.sync;
}

// ---------- Hạn mức Claude (cửa sổ 5 giờ, 7 ngày) và tự đánh thức, đầu cột trái ----------

interface UsageGroup {
  usage: UsageInfo;
  conn: Conn; // máy có số mới nhất, dùng để làm mới / poke
  machines: string[];
}

// Các máy đăng nhập cùng tài khoản cho cùng số liệu: gộp lại, lấy số mới nhất.
function usageGroups(): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const c of state.conns) {
    const u = c.usage;
    if (!u || !u.enabled) continue;
    const key = u.account ?? c.machine.name;
    const g = groups.get(key);
    if (!g) groups.set(key, { usage: u, conn: c, machines: [c.machine.name] });
    else {
      g.machines.push(c.machine.name);
      if ((u.fetchedAt ?? 0) > (g.usage.fetchedAt ?? 0)) Object.assign(g, { usage: u, conn: c });
    }
  }
  return [...groups.values()];
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
const dayClock = (ms: number) =>
  new Date(ms).toLocaleString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function left(ms: number): string {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60_000));
  if (m >= 48 * 60) return `${Math.floor(m / 1440)} ngày`;
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m} phút`;
}
const usageLevel = (p?: number) => (p === undefined ? '' : p >= 85 ? 'high' : p >= 60 ? 'mid' : 'low');
const windowOpen = (u: UsageInfo) => u.phase === 'active' || u.phase === 'blocked';

// Dòng mô tả cửa sổ 5 giờ theo trạng thái.
function fiveHourNote(u: UsageInfo): string {
  switch (u.phase) {
    case 'active':
      return u.resetsAt ? `reset ${clock(u.resetsAt)} · còn ${left(u.resetsAt)}` : 'đang mở';
    case 'blocked':
      return u.nextPokeAt ? `cạn tới ${u.nextPokeAt - Date.now() > 12 * 3600_000 ? dayClock(u.nextPokeAt) : clock(u.nextPokeAt)}` : 'cạn hạn mức';
    case 'quiet':
      return `giờ nghỉ · mở lúc ${u.schedule?.pokeAt ?? (u.nextPokeAt ? clock(u.nextPokeAt) : '?')}`;
    case 'idle':
      return 'cửa sổ trống · đang mở lại';
    case 'unknown':
      return u.error ?? 'chưa đọc được số';
    default:
      return '';
  }
}

function weekNote(u: UsageInfo): string {
  return u.weeklyResetsAt && u.weeklyResetsAt > Date.now() ? `reset ${dayClock(u.weeklyResetsAt)}` : '';
}

function usageBar(label: string, pct: number | undefined, note: string, stale = false) {
  const row = document.createElement('div');
  row.className = 'usage-row';
  const bar = document.createElement('span');
  bar.className = 'usage-bar';
  bar.dataset.level = stale ? '' : usageLevel(pct);
  bar.append(Object.assign(document.createElement('i'), { style: `width:${stale ? 0 : Math.min(100, pct ?? 0)}%` }));
  row.append(
    Object.assign(document.createElement('span'), { className: 'usage-label', textContent: label }),
    bar,
    Object.assign(document.createElement('span'), { className: 'usage-pct', textContent: stale || pct === undefined ? '–' : `${Math.round(pct)}%` }),
    Object.assign(document.createElement('span'), { className: 'usage-note', textContent: note }),
  );
  return row;
}

// Hai thanh 5h / 7d. Cửa sổ đã hết thì % cũ không còn nghĩa, thanh để trống.
function usageBars(u: UsageInfo) {
  const weekOver = !!u.weeklyResetsAt && u.weeklyResetsAt <= Date.now();
  return [usageBar('5h', u.fiveHour, fiveHourNote(u), !windowOpen(u)), usageBar('7d', u.weekly, weekNote(u), weekOver)];
}

function renderUsage() {
  const card = $('usageCard');
  const groups = usageGroups();
  card.hidden = groups.length === 0;
  card.replaceChildren();
  for (const g of groups) {
    const box = document.createElement('div');
    box.className = 'usage-group';
    box.dataset.phase = g.usage.phase;
    box.append(
      Object.assign(document.createElement('div'), {
        className: 'usage-who',
        textContent: groups.length > 1 ? `Claude · ${g.machines.join(', ')}` : 'Claude',
      }),
    );
    box.append(...usageBars(g.usage));
    card.append(box);
  }
  card.title = 'Hạn mức Claude · bấm để xem chi tiết';
  if (usageBox?.isConnected) usagePanelContent(usageBox);
}

let usageBox: HTMLElement | null = null;

function usagePanelContent(box: HTMLElement) {
  box.replaceChildren();
  const groups = usageGroups();
  if (!groups.length) {
    box.textContent = 'Chưa có số liệu.';
    return;
  }
  for (const g of groups) {
    const u = g.usage;
    const sec = document.createElement('div');
    sec.className = 'usage-group usage-detail';
    sec.dataset.phase = u.phase;
    const line = (k: string, v: string) => {
      const r = document.createElement('div');
      r.className = 'usage-kv';
      r.append(Object.assign(document.createElement('span'), { textContent: k }), Object.assign(document.createElement('span'), { textContent: v }));
      sec.append(r);
    };
    sec.append(...usageBars(u));
    if (u.email) line('Tài khoản', u.email);
    line('Máy theo dõi', g.machines.join(', '));
    if (u.schedule)
      line(
        'Mốc neo',
        `reset ${u.schedule.resetAt} mỗi ngày · poke ${u.schedule.pokeAt} · nghỉ ${u.schedule.quietFrom}–${u.schedule.pokeAt}${u.schedule.quietNow ? ' (đang nghỉ)' : ''}`,
      );
    else line('Mốc neo', 'không đặt, poke ngay khi reset');
    if (u.nextPokeAt) line('Tự poke kế tiếp', u.nextPokeAt <= Date.now() + 30_000 ? 'ngay bây giờ' : `${dayClock(u.nextPokeAt)} (còn ${left(u.nextPokeAt)})`);
    if (u.lastPoke) line('Poke gần nhất', `${dayClock(u.lastPoke.at)}${u.lastPoke.ok ? '' : ' · lỗi'}`);
    if (u.fetchedAt) line('Cập nhật số', `${clock(u.fetchedAt)} (máy ${g.conn.machine.name})`);
    if (u.error) line('Lỗi', u.error);
    const row = document.createElement('div');
    row.className = 'usage-actions';
    // Probe lúc cửa sổ đã hết chính là mở cửa sổ mới, nên chỉ cho "Làm mới" khi cửa sổ đang mở.
    const action: 'refresh' | 'poke' = windowOpen(u) ? 'refresh' : 'poke';
    const b = button(action === 'refresh' ? 'Làm mới' : 'Mở cửa sổ ngay', action === 'refresh' ? 'ghost-btn' : 'primary-btn', async () => {
      b.disabled = true;
      b.textContent = 'Đang gọi…';
      try {
        g.conn.usage = await api<UsageInfo>(g.conn, '/api/usage', { body: { action } });
        renderUsage();
      } catch (err) {
        b.disabled = false;
        b.textContent = (err as Error).message;
      }
    });
    row.append(b);
    sec.append(row);
    box.append(sec);
  }
}

function openUsagePanel() {
  const card = $('usageCard');
  const box = document.createElement('div');
  box.className = 'usage-panel';
  usageBox = box;
  usagePanelContent(box);
  showPanel(card, 'Hạn mức Claude', box);
  // showPanel đặt bảng phía trên nút; thẻ nằm đầu cột trái nên đặt xuống dưới.
  if (menuEl && !menuEl.classList.contains('sheet')) {
    const r = card.getBoundingClientRect();
    menuEl.style.left = `${Math.max(8, r.left)}px`;
    menuEl.style.top = `${r.bottom + 6}px`;
  }
}

// ---------- Khung chat ----------

const current = () => (state.current ? (state.current.conn.sessions.find((s) => s.id === state.current!.id) ?? null) : null);

function renderHeader() {
  const s = current();
  const conn = state.current?.conn;
  $('title').textContent = s && conn ? titleOf(conn, s) : isDraft() ? 'Session mới' : state.current ? 'Session' : 'Chọn một session';
  $('subtitle').textContent = s && conn ? [`Máy ${conn.machine.name}`, s.cwd, s.gitBranch].filter(Boolean).join(' · ') : '';
  const act = s && conn ? activityOf(conn, s) : '';
  const badge = $('statusBadge');
  badge.hidden = !act;
  badge.className = 'status-badge ' + act;
  badge.textContent = ACTIVITY_LABEL[act];
  const since = act === 'running' || act === 'waiting' ? turnStart() : undefined;
  if (since) badge.append(sinceEl(since));
  $('warn').hidden = !s?.elsewhere;
  $('composer').hidden = !state.current;
  $('closeBtn').hidden = !s?.live;
  $('topMoreBtn').hidden = !s;
  $('mode').hidden = !s;
  const busy = s?.state === 'running' || s?.state === 'requires_action';
  $('stopBtn').hidden = !busy;
}

function md(text: string): string {
  return enhanceCode(enhanceTables(DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: false }) as string)));
}

function toolArg(input: any): string {
  if (!input || typeof input !== 'object') return '';
  return String(input.command ?? input.file_path ?? input.pattern ?? input.path ?? input.url ?? input.query ?? input.description ?? input.skill ?? '').split('\n')[0];
}

// Mỗi tin vẽ thành một nút riêng, giữ lại giữa các lần vẽ nếu không đổi: video đang phát không bị dừng,
// ảnh không bị tải lại mỗi khi có sự kiện mới.
const msgNodes = new Map<string, { sig: string; el: HTMLElement }>();

type ToolResult = Extract<Block, { type: 'tool_result' }>;

// Địa chỉ ảnh/tệp nằm trên agent của máy chạy session (có thể là máy khác).
const mediaUrl = (u: string) => (/^(blob|data):/.test(u) ? u : (state.current?.conn.base ?? '') + u);

type ToolUse = Extract<Block, { type: 'tool_use' }>;

// mcp__claude-in-chrome__navigate → navigate (tên công cụ MCP dài, phần cuối là đủ hiểu).
const toolName = (n: string) => n.replace(/^mcp__.+?__/, '');

// Một khối hiển thị trên khung chat. Các tool chạy liền nhau (và suy nghĩ xen giữa) gom thành một nhóm.
type Unit =
  | { kind: 'user'; key: string; msg: ChatMessage }
  // Cuối một lượt đã xong: giờ Claude trả lời xong và đã làm trong bao lâu.
  // text: Markdown gốc mọi đoạn chữ Claude viết trong lượt, cho nút chép cả tin.
  | { kind: 'turn'; key: string; start?: number; end?: number; text: string }
  | { kind: 'block'; key: string; block: Block }
  | { kind: 'tools'; key: string; tools: ToolUse[]; thinking: string[] };

// Nhóm tool người dùng đã mở ra xem (giữ nguyên khi vẽ lại).
const openGroups = new Set<string>();

// Tin người dùng tự gõ (không phải tin chỉ chứa kết quả tool).
const isPrompt = (m: ChatMessage) => m.role === 'user' && !m.blocks.every((x) => x.type === 'tool_result');

// Lượt đang chạy bắt đầu lúc nào: agent báo, không có thì lấy giờ tin người dùng cuối.
function turnStart(): number | undefined {
  const s = current();
  if (s?.turnStartedAt) return s.turnStartedAt;
  for (let i = state.messages.length - 1; i >= 0; i--) if (isPrompt(state.messages[i])) return state.messages[i].at;
  return undefined;
}

// running: lượt cuối đang chạy, chưa có dòng kết thúc lượt.
function buildUnits(running = false): Unit[] {
  const units: Unit[] = [];
  let group: Extract<Unit, { kind: 'tools' }> | null = null;
  let pendingThinking: string[] = [];
  const flushThinking = () => {
    for (const t of pendingThinking) units.push({ kind: 'block', key: `th:${units.length}:${t.length}`, block: { type: 'thinking', text: t } });
    pendingThinking = [];
  };
  let turn: { key: string; start?: number; end?: number; replied: boolean; texts: string[] } | null = null;
  const closeTurn = () => {
    flushThinking();
    if (turn?.replied) units.push({ kind: 'turn', key: `t:${turn.key}`, start: turn.start, end: turn.end, text: turn.texts.join('\n\n') });
    turn = null;
  };
  for (const m of state.messages) {
    if (turn && m.at) turn.end = Math.max(turn.end ?? 0, m.at);
    if (m.role === 'user') {
      // Tin chỉ chứa kết quả tool không làm đứt nhóm.
      if (!isPrompt(m)) continue;
      group = null;
      closeTurn();
      units.push({ kind: 'user', key: m.id, msg: m });
      turn = { key: m.id, start: m.at, replied: false, texts: [] };
      continue;
    }
    if (turn) turn.replied = true;
    m.blocks.forEach((blk, i) => {
      if (blk.type === 'tool_use') {
        if (!group) {
          group = { kind: 'tools', key: `g:${blk.id}`, tools: [], thinking: [] };
          units.push(group);
        }
        group.thinking.push(...pendingThinking);
        pendingThinking = [];
        group.tools.push(blk);
      } else if (blk.type === 'thinking') {
        // Suy nghĩ giữa các tool thuộc về nhóm; suy nghĩ đứng riêng thì hiện như cũ.
        if (group) group.thinking.push(blk.text);
        else pendingThinking.push(blk.text);
      } else if (blk.type !== 'tool_result') {
        group = null;
        flushThinking();
        if (blk.type === 'text' && turn && blk.text.trim()) turn.texts.push(blk.text);
        units.push({ kind: 'block', key: `${m.id}:${i}`, block: blk });
      }
    });
  }
  if (running) flushThinking();
  else closeTurn();
  return units;
}

function renderMessages() {
  const box = $('messages');
  $('empty').hidden = !!state.current;
  $('newPanel').hidden = !isDraft() || state.messages.length > 0;
  const chat = $('chat');
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;

  // Gom kết quả tool theo id để gắn vào đúng thẻ tool.
  const results = new Map<string, ToolResult>();
  for (const m of state.messages) for (const b of m.blocks) if (b.type === 'tool_result') results.set(b.toolUseId, b);

  const s = current();
  const running = s?.state === 'running' || s?.state === 'requires_action';
  const units = buildUnits(running);
  const last = units.at(-1);
  const desired: HTMLElement[] = [];
  const keep = new Set<string>();
  for (const u of units) {
    const live = running && u === last;
    const sig =
      u.kind === 'tools'
        ? JSON.stringify([u.tools.map((t) => t.id), u.tools.map((t) => results.get(t.id) ?? null), u.thinking.length, live, openGroups.has(u.key)])
        : u.kind === 'user'
          ? JSON.stringify([u.msg.blocks, u.msg.at])
          : u.kind === 'turn'
            ? JSON.stringify([u.start, u.end, u.text])
            : JSON.stringify(u.block);
    let node = msgNodes.get(u.key);
    if (!node || node.sig !== sig) {
      node = { sig, el: renderUnit(u, results, live) };
      msgNodes.set(u.key, node);
    }
    keep.add(u.key);
    desired.push(node.el);
  }
  for (const id of msgNodes.keys()) if (!keep.has(id)) msgNodes.delete(id);

  if (state.streaming) {
    const el = document.createElement('div');
    el.className = 'msg-assistant';
    el.id = 'streaming';
    el.innerHTML = md(state.streaming);
    desired.push(el);
  } else if (running && last?.kind !== 'tools') {
    const el = document.createElement('div');
    el.className = 'typing';
    el.id = 'streaming';
    el.textContent = 'Claude đang làm…';
    const since = turnStart();
    if (since) el.append(sinceEl(since, ' ', 'since typing-time'));
    desired.push(el);
  }
  // Đang chạy tool hoặc đang viết: dòng nhỏ đếm thời gian đã chạy của lượt.
  if (running && (state.streaming || last?.kind === 'tools')) {
    const since = turnStart();
    if (since) {
      const el = document.createElement('div');
      el.className = 'turn-meta live';
      el.append(sinceEl(since, 'Đang làm · '));
      desired.push(el);
    }
  }
  if (state.lastResult && !state.lastResult.ok) {
    const el = document.createElement('div');
    el.className = 'result-note err';
    el.textContent = `Lỗi: ${state.lastResult.error ?? 'không rõ'}`;
    desired.push(el);
  }

  // Chỉ chèn / bỏ những nút khác đi; nút đã đúng chỗ thì để yên (không gỡ khỏi trang).
  desired.forEach((el, i) => {
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] ?? null);
  });
  while (box.children.length > desired.length) box.lastElementChild!.remove();
  if (atBottom) chat.scrollTop = chat.scrollHeight;
}

function renderUnit(u: Unit, results: Map<string, ToolResult>, live: boolean): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'msg';
  if (u.kind === 'user') {
    const m = u.msg;
    const text = m.blocks.filter((b) => b.type === 'text').map((b) => (b as any).text).join('\n');
    const images = m.blocks.flatMap((b) => (b.type === 'image' ? [b.image] : []));
    if (images.length) wrap.append(thumbs(images.map((x) => ({ src: mediaUrl(x.url), caption: '' })), 'user-images'));
    if (text) {
      const el = document.createElement('div');
      el.className = 'msg-user';
      el.textContent = text;
      wrap.append(el);
    }
    if (m.at) wrap.append(Object.assign(document.createElement('div'), { className: 'msg-time', textContent: msgClock(m.at), title: new Date(m.at).toLocaleString('vi-VN') }));
    return wrap;
  }
  if (u.kind === 'turn') {
    const el = document.createElement('div');
    el.className = 'turn-meta';
    const parts = [u.end ? msgClock(u.end) : '', u.start && u.end && u.end > u.start ? `làm trong ${fmtDuration(u.end - u.start)}` : ''].filter(Boolean);
    // Như Claude desktop: nút chép cả tin nằm kín đáo cuối lượt, hiện khi rê chuột (điện thoại thì luôn hiện).
    wrap.classList.add('turn');
    if (u.text) el.append(messageCopyButton(u.text));
    el.append(Object.assign(document.createElement('span'), { textContent: parts.join(' · ') }));
    if (u.end) el.title = `Trả lời xong lúc ${new Date(u.end).toLocaleString('vi-VN')}`;
    if (parts.length || u.text) wrap.append(el);
    return wrap;
  }
  if (u.kind === 'tools') {
    wrap.append(toolGroup(u, results, live));
    // Ảnh Claude vừa xem (đọc tệp ảnh, chụp màn hình) vẫn hiện thành hàng ảnh nhỏ dưới nhóm.
    const imgs = u.tools.flatMap((t) => (results.get(t.id)?.images ?? []).map((x) => ({ src: mediaUrl(x.url), caption: `${t.name}: ${toolArg(t.input)}` })));
    if (imgs.length) wrap.append(thumbs(imgs, 'tool-images'));
    return wrap;
  }
  const blk = u.block;
  if (blk.type === 'text') {
    const el = document.createElement('div');
    el.className = 'msg-assistant';
    el.innerHTML = md(blk.text);
    const mdImgs = [...el.querySelectorAll('img')];
    const mdGallery = mdImgs.map((im) => ({ src: im.src, caption: im.alt }));
    mdImgs.forEach((im, i) => {
      im.classList.add('md-image');
      makeZoomable(im, () => openLightbox(mdGallery, i, im));
    });
    wrap.append(el);
  } else if (blk.type === 'thinking') {
    const el = document.createElement('div');
    el.className = 'thinking';
    el.textContent = blk.text;
    wrap.append(el);
  } else if (blk.type === 'image') {
    wrap.append(thumbs([{ src: mediaUrl(blk.image.url), caption: '' }]));
  } else if (blk.type === 'files') {
    wrap.append(attachment(blk));
  }
  return wrap;
}

// Một dòng thu gọn cho cả nhóm tool; bấm để mở danh sách thẻ tool. Đang chạy: chỉ hiện tool hiện tại.
function toolGroup(u: Extract<Unit, { kind: 'tools' }>, results: Map<string, ToolResult>, live: boolean) {
  const box = document.createElement('div');
  box.className = 'tgroup';
  const open = openGroups.has(u.key);
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'tgroup-head';
  head.setAttribute('aria-expanded', String(open));
  const errors = u.tools.filter((t) => results.get(t.id)?.isError).length;
  const pending = u.tools.find((t) => !results.get(t.id));
  const chev = Object.assign(document.createElement('span'), { className: 'tgroup-chev', textContent: open ? '▾' : '▸' });
  const text = document.createElement('span');
  text.className = 'tgroup-text';
  const status = document.createElement('span');
  status.className = 'tgroup-status';
  if (live && pending) {
    const arg = toolArg(pending.input);
    text.append(Object.assign(document.createElement('span'), { className: 'spinner', ariaHidden: 'true' }), document.createTextNode(`Đang chạy ${toolName(pending.name)}`));
    if (arg) text.append(Object.assign(document.createElement('span'), { className: 'tgroup-arg', textContent: arg }));
    box.classList.add('running');
  } else {
    const names = [...new Set(u.tools.map((t) => toolName(t.name)))];
    if (u.tools.length === 1) {
      text.append(Object.assign(document.createElement('b'), { textContent: toolName(u.tools[0].name) }));
      const arg = toolArg(u.tools[0].input);
      if (arg) text.append(Object.assign(document.createElement('span'), { className: 'tgroup-arg', textContent: arg }));
    } else {
      text.append(Object.assign(document.createElement('b'), { textContent: `${u.tools.length} bước` }));
      text.append(Object.assign(document.createElement('span'), { className: 'tgroup-arg', textContent: names.slice(0, 4).join(', ') + (names.length > 4 ? '…' : '') }));
    }
    status.textContent = errors ? `${errors} lỗi` : pending ? '' : '✓';
    if (errors) box.classList.add('err');
  }
  head.append(chev, text, status);
  const body = document.createElement('div');
  body.className = 'tgroup-body';
  body.hidden = !open;
  const fill = () => {
    if (body.childElementCount) return;
    for (const t of u.thinking) body.append(Object.assign(document.createElement('div'), { className: 'thinking', textContent: t }));
    for (const t of u.tools) body.append(toolCard(t, results.get(t.id)));
  };
  if (open) fill();
  head.onclick = () => {
    const now = body.hidden;
    if (now) {
      openGroups.add(u.key);
      fill();
    } else openGroups.delete(u.key);
    body.hidden = !now;
    head.setAttribute('aria-expanded', String(now));
    chev.textContent = now ? '▾' : '▸';
  };
  box.append(head, body);
  return box;
}

// ---------- Ảnh, video, tệp đính kèm ----------

function thumbs(items: { src: string; caption: string }[], cls = '') {
  const row = document.createElement('div');
  row.className = 'thumbs ' + cls;
  items.forEach((it, i) => {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.src = it.src;
    img.alt = it.caption || 'Ảnh';
    img.loading = 'lazy';
    img.decoding = 'async';
    makeZoomable(img, () => openLightbox(items, i, img));
    row.append(img);
  });
  return row;
}

// Tệp Claude gửi bằng SendUserFile: ảnh xem ngay, video phát ngay, HTML xem trong app hoặc mở trình duyệt, tệp khác tải về.
function attachment(b: Extract<Block, { type: 'files' }>) {
  const box = document.createElement('div');
  box.className = 'attach';
  if (b.caption) box.append(Object.assign(document.createElement('div'), { className: 'attach-caption', textContent: b.caption }));
  const images = b.files.filter((f) => f.kind === 'image' && f.exists);
  const gallery = images.map((f) => ({ src: mediaUrl(f.url), caption: b.caption ? `${f.name} — ${b.caption}` : f.name }));
  // Ảnh gom thành một hàng ảnh nhỏ đúng tỉ lệ; video và tệp khác nằm riêng bên dưới.
  const row = document.createElement('div');
  row.className = 'attach-images';
  for (const f of b.files) {
    if (!f.exists) {
      box.append(Object.assign(document.createElement('div'), { className: 'attach-missing', textContent: `${f.name} (tệp không còn trên máy)`, title: f.path }));
    } else if (f.kind === 'image') {
      const img = document.createElement('img');
      img.className = 'attach-image';
      img.src = mediaUrl(f.url);
      img.alt = f.name;
      img.loading = 'lazy';
      const i = images.indexOf(f);
      makeZoomable(img, () => openLightbox(gallery, i, img));
      row.append(img);
      if (!row.isConnected) box.append(row);
    } else if (f.kind === 'video') {
      const v = document.createElement('video');
      v.className = 'attach-video';
      v.src = mediaUrl(f.url);
      v.controls = true;
      v.playsInline = true;
      v.preload = 'metadata';
      v.title = f.name;
      box.append(v);
    } else if (f.kind === 'html') {
      box.append(htmlCard(f));
    } else {
      const a = document.createElement('a');
      a.className = 'attach-file';
      a.href = mediaUrl(f.url);
      a.download = f.name;
      a.textContent = `⇩ ${f.name}`;
      a.title = f.path;
      box.append(a);
    }
  }
  return box;
}

// Báo cáo HTML: bấm thẻ để xem ngay trong app; nút bên cạnh mở bằng trình duyệt hoặc tải về.
function htmlCard(f: FileRef) {
  const src = mediaUrl(f.url);
  const card = document.createElement('div');
  card.className = 'html-card';
  const view = document.createElement('button');
  view.type = 'button';
  view.className = 'html-card-main';
  view.title = `Xem trong SessionMon
${f.path}`;
  view.append(
    Object.assign(document.createElement('span'), { className: 'html-card-icon', textContent: '</>', ariaHidden: 'true' }),
    Object.assign(document.createElement('span'), { className: 'html-card-name', textContent: f.name }),
    Object.assign(document.createElement('span'), { className: 'html-card-hint', textContent: 'Xem ở đây' }),
  );
  view.onclick = () => openHtmlViewer({ src, name: f.name, path: f.path }, view, openExternal);
  const ext = document.createElement('button');
  ext.type = 'button';
  ext.className = 'html-card-btn';
  ext.textContent = '↗';
  ext.title = 'Mở bằng trình duyệt';
  ext.setAttribute('aria-label', 'Mở bằng trình duyệt');
  ext.onclick = () => openExternal(new URL(src, location.href).href, ext);
  const dl = document.createElement('a');
  dl.className = 'html-card-btn';
  dl.href = src;
  dl.download = f.name;
  dl.textContent = '⇩';
  dl.title = 'Tải về';
  dl.setAttribute('aria-label', 'Tải về');
  card.append(view, ext, dl);
  return card;
}

function renderStreaming() {
  const el = document.getElementById('streaming');
  if (!el || el.classList.contains('typing')) return renderMessages();
  const chat = $('chat');
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  el.innerHTML = md(state.streaming);
  if (atBottom) chat.scrollTop = chat.scrollHeight;
}

function toolCard(b: Extract<Block, { type: 'tool_use' }>, r?: Extract<Block, { type: 'tool_result' }>) {
  const d = document.createElement('details');
  d.className = 'tool' + (r?.isError ? ' err' : '');
  const sum = document.createElement('summary');
  const name = document.createElement('span');
  name.className = 'tname';
  name.textContent = toolName(b.name);
  name.title = b.name;
  const arg = document.createElement('span');
  arg.className = 'targ';
  arg.textContent = toolArg(b.input);
  const st = document.createElement('span');
  st.className = 'tstatus';
  st.textContent = r ? (r.isError ? 'lỗi' : '✓') : '…';
  sum.append(name, arg, st);
  d.append(sum);
  d.addEventListener('toggle', () => {
    if (!d.open || d.querySelector('.tbody')) return;
    const body = document.createElement('div');
    body.className = 'tbody';
    body.append(label('Đầu vào'), pre(JSON.stringify(b.input, null, 2)));
    if (r) body.append(label('Kết quả'), pre(r.text || (r.images?.length ? `(${r.images.length} ảnh)` : '(trống)')));
    d.append(body);
  });
  return d;
}

const label = (t: string) => Object.assign(document.createElement('div'), { className: 'tlabel', textContent: t });
const pre = (t: string) => Object.assign(document.createElement('pre'), { textContent: t });

// ---------- Thẻ duyệt quyền ----------

function renderAsks() {
  const box = $('asks');
  box.replaceChildren();
  const cur = state.current;
  for (const ask of state.asks.values()) {
    if (!cur || ask.machine !== cur.conn.machine.name || ask.sessionId !== cur.id) continue;
    box.append(ask.toolName === 'AskUserQuestion' ? questionCard(cur.conn, ask) : permissionCard(cur.conn, ask));
  }
  renderSessions();
  updateBadge();
}

// Số yêu cầu chờ duyệt trên tiêu đề tab và biểu tượng app.
function updateBadge() {
  const n = state.asks.size;
  document.title = `${n ? `(${n}) ` : ''}SessionMon`;
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (n) void nav.setAppBadge?.(n).catch(() => {});
  else void nav.clearAppBadge?.().catch(() => {});
}

function permissionCard(conn: Conn, ask: PermissionAsk) {
  const card = document.createElement('div');
  card.className = 'ask';
  const h = document.createElement('h3');
  h.textContent = ask.title ?? `Claude muốn dùng ${ask.toolName}`;
  card.append(h);
  if (ask.description) card.append(Object.assign(document.createElement('p'), { textContent: ask.description }));
  const arg = toolArg(ask.input);
  card.append(pre(arg && Object.keys(ask.input).length <= 2 ? arg : JSON.stringify(ask.input, null, 2)));
  const row = document.createElement('div');
  row.className = 'ask-row';
  row.append(button('Từ chối', 'ghost-btn', () => decide(conn, ask, { allow: false })));
  if (ask.canAlwaysAllow) row.append(button('Luôn cho phép', 'ghost-btn', () => decide(conn, ask, { allow: true, always: true })));
  row.append(button('Cho phép', 'primary-btn', () => decide(conn, ask, { allow: true })));
  card.append(row);
  return card;
}

// AskUserQuestion: hỏi từng câu một (Trước / Tiếp), mỗi câu có thêm lựa chọn "Khác" để tự gõ câu trả lời.
// Trả lời xong mọi câu thì sang bước xem lại, bấm Gửi mới gửi đi. Thẻ được giữ lại giữa các lần vẽ lại
// (renderAsks chạy cả khi có sự kiện của session khác) để không mất chữ đang gõ và focus.
interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
}
interface QuestionState {
  step: number;
  picks: Record<number, string[]>;
  other: Record<number, string>;
  otherOn: Record<number, boolean>;
}
const questionStates = new Map<string, QuestionState>();
const questionCards = new Map<string, HTMLElement>();

function questionAnswer(st: QuestionState, i: number): string {
  const parts = [...(st.picks[i] ?? [])];
  const other = (st.other[i] ?? '').trim();
  if (st.otherOn[i] && other) parts.push(other);
  return parts.join(', ');
}

function questionCard(conn: Conn, ask: PermissionAsk) {
  const cached = questionCards.get(ask.requestId);
  if (cached) return cached;
  const card = document.createElement('div');
  card.className = 'ask ask-question';
  questionCards.set(ask.requestId, card);
  const questions = ((ask.input.questions as AskQuestion[]) ?? []).filter((q) => q && typeof q.question === 'string');
  const st: QuestionState = questionStates.get(ask.requestId) ?? { step: 0, picks: {}, other: {}, otherOn: {} };
  questionStates.set(ask.requestId, st);
  const n = questions.length;
  const review = () => st.step >= n;
  const answered = (i: number) => !!questionAnswer(st, i);

  let nextBtn: HTMLButtonElement | null = null;
  const refreshNav = () => {
    if (nextBtn) nextBtn.disabled = !answered(st.step);
    card.querySelectorAll<HTMLElement>('.qstep').forEach((d, i) => d.classList.toggle('done', answered(i)));
  };
  const go = (step: number) => {
    st.step = Math.max(0, Math.min(n, step));
    draw();
    (card.querySelector('.option.on, .option, .primary-btn') as HTMLElement | null)?.focus({ preventScroll: true });
  };

  const head = () => {
    const h = document.createElement('div');
    h.className = 'qhead';
    h.append(Object.assign(document.createElement('h3'), { textContent: review() ? 'Xem lại câu trả lời' : `Claude hỏi · câu ${st.step + 1}/${n}` }));
    if (n > 1) {
      const dots = document.createElement('div');
      dots.className = 'qsteps';
      questions.forEach((q, i) => {
        const d = button(String(i + 1), 'qstep', () => go(i));
        d.title = q.header || q.question;
        d.classList.toggle('cur', i === st.step);
        d.classList.toggle('done', answered(i));
        dots.append(d);
      });
      h.append(dots);
    }
    return h;
  };

  const optionRow = (label: string, desc: string | undefined, on: boolean, multi: boolean, onClick: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'option' + (on ? ' on' : '');
    b.setAttribute('role', multi ? 'checkbox' : 'radio');
    b.setAttribute('aria-checked', String(on));
    const mark = Object.assign(document.createElement('span'), { className: 'opt-mark' + (multi ? ' multi' : ''), ariaHidden: 'true' });
    const text = document.createElement('span');
    text.className = 'opt-text';
    text.append(Object.assign(document.createElement('span'), { className: 'opt-label', textContent: label }));
    if (desc) text.append(Object.assign(document.createElement('small'), { textContent: desc }));
    b.append(mark, text);
    b.onclick = onClick;
    return b;
  };

  const questionBody = (i: number) => {
    const q = questions[i];
    const multi = !!q.multiSelect;
    const wrap = document.createElement('div');
    wrap.className = 'question';
    if (q.header) wrap.append(Object.assign(document.createElement('span'), { className: 'qchip', textContent: q.header }));
    wrap.append(Object.assign(document.createElement('div'), { className: 'q', textContent: q.question }));
    if (multi) wrap.append(Object.assign(document.createElement('div'), { className: 'qhint', textContent: 'Chọn được nhiều' }));
    const opts = document.createElement('div');
    opts.className = 'options';
    opts.setAttribute('role', multi ? 'group' : 'radiogroup');
    const picks = st.picks[i] ?? [];
    for (const o of q.options ?? []) {
      opts.append(
        optionRow(o.label, o.description, picks.includes(o.label), multi, () => {
          if (multi) {
            const set = new Set(st.picks[i] ?? []);
            set.has(o.label) ? set.delete(o.label) : set.add(o.label);
            st.picks[i] = [...set];
          } else {
            st.picks[i] = [o.label];
            st.otherOn[i] = false;
          }
          draw();
        }),
      );
    }
    // Khác: tự gõ câu trả lời.
    const otherOn = !!st.otherOn[i];
    opts.append(
      optionRow('Khác…', 'Tự gõ câu trả lời', otherOn, multi, () => {
        st.otherOn[i] = !otherOn;
        if (!multi && st.otherOn[i]) st.picks[i] = [];
        draw();
        if (st.otherOn[i]) (card.querySelector('.qother') as HTMLTextAreaElement | null)?.focus();
      }),
    );
    if (otherOn) {
      const ta = document.createElement('textarea');
      ta.className = 'qother';
      ta.rows = 2;
      ta.placeholder = 'Câu trả lời của bạn…';
      ta.value = st.other[i] ?? '';
      ta.oninput = () => {
        st.other[i] = ta.value;
        refreshNav();
      };
      ta.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          if (answered(i)) go(i + 1);
        }
      };
      opts.append(ta);
    }
    wrap.append(opts);
    return wrap;
  };

  const reviewBody = () => {
    const list = document.createElement('div');
    list.className = 'qreview';
    questions.forEach((q, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'qreview-row';
      row.title = 'Bấm để sửa';
      row.append(
        Object.assign(document.createElement('span'), { className: 'qreview-q', textContent: `${i + 1}. ${q.header ? q.header + ' — ' : ''}${q.question}` }),
        Object.assign(document.createElement('span'), { className: 'qreview-a', textContent: questionAnswer(st, i) || '(chưa trả lời)' }),
      );
      row.onclick = () => go(i);
      list.append(row);
    });
    return list;
  };

  const draw = () => {
    card.replaceChildren(head());
    card.append(review() ? reviewBody() : questionBody(st.step));
    const row = document.createElement('div');
    row.className = 'ask-row qnav';
    row.append(button('Bỏ qua', 'ghost-btn qskip', () => decide(conn, ask, { allow: false, message: 'Người dùng bỏ qua câu hỏi' })));
    row.append(Object.assign(document.createElement('span'), { className: 'row-spacer' }));
    const prev = button('‹ Trước', 'ghost-btn', () => go(st.step - 1));
    prev.disabled = st.step === 0;
    row.append(prev);
    nextBtn = null;
    if (review()) {
      const send = button('Gửi câu trả lời', 'primary-btn', () => {
        const answers: Record<string, string> = {};
        questions.forEach((q, i) => (answers[q.question] = questionAnswer(st, i)));
        void decide(conn, ask, { allow: true, answers });
      });
      send.disabled = questions.some((_, i) => !answered(i));
      row.append(send);
    } else {
      nextBtn = button(st.step === n - 1 ? 'Xem lại ›' : 'Tiếp ›', 'primary-btn', () => go(st.step + 1));
      row.append(nextBtn);
    }
    card.append(row);
    refreshNav();
  };
  draw();
  return card;
}

function button(text: string, cls: string, onClick: () => void) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  b.onclick = onClick;
  return b;
}

async function decide(
  conn: Conn,
  ask: PermissionAsk,
  d: { allow: boolean; always?: boolean; answers?: Record<string, string>; message?: string },
) {
  try {
    await api(conn, `/api/permissions/${ask.requestId}`, { body: { sessionId: ask.sessionId, ...d } });
  } catch (err) {
    alert((err as Error).message);
    return;
  }
  state.asks.delete(ask.requestId);
  questionStates.delete(ask.requestId);
  questionCards.delete(ask.requestId);
  renderAsks();
}

// ---------- Hành động ----------

async function loadMessages(conn: Conn, id: string) {
  try {
    const data = await api<{ messages: ChatMessage[]; pending: PermissionAsk[]; meta?: SessionMeta }>(conn, `/api/sessions/${id}/messages`);
    if (!isCurrent(conn, id)) return;
    state.messages = data.messages;
    meta = data.meta ?? {};
    renderComposerMeta();
    for (const a of data.pending) state.asks.set(a.requestId, { ...a, machine: conn.machine.name });
    renderMessages();
    renderAsks();
    $('chat').scrollTop = $('chat').scrollHeight;
  } catch (err) {
    state.lastResult = { ok: false, error: (err as Error).message };
    renderMessages();
  }
}

function connByName(name: string) {
  return state.conns.find((c) => c.machine.name === name);
}

// Hiện màn chat (điện thoại): thêm một mục lịch sử để nút quay lại của máy đưa về danh sách.
function showChat(conn: Conn, id: string) {
  hideTasks();
  // Mở thẳng bằng link có #session: mục lịch sử bên dưới phải là danh sách, không phải chính session đó (showMain lo).
  showMain(id ? `#${conn.machine.name}/${id}` : '#new');
}

async function openSession(conn: Conn, id: string) {
  // Session đang giữ sẵn (vừa vuốt về danh sách): chỉ hiện lại, không tải lại.
  if (isCurrent(conn, id) && state.messages.length) {
    showChat(conn, id);
    renderSessions();
    return;
  }
  state.current = { conn, id };
  state.messages = [];
  msgNodes.clear();
  openGroups.clear();
  meta = {};
  hideSlash();
  clearPendingFiles();
  renderComposerMeta();
  void modelsFor(conn).then(renderComposerMeta);
  state.streaming = '';
  state.lastResult = null;
  showChat(conn, id);
  if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
  renderSessions();
  renderHeader();
  renderMessages();
  renderAsks();
  await loadMessages(conn, id);
  if (!isMobile()) $('input').focus();
}

// Về danh sách. Session vẫn được giữ (tin nhắn, sự kiện tiếp tục về) để vuốt trái là hiện lại ngay.
function closeChat() {
  hideTasks();
  $('app').classList.remove('chat-open');
  syncInert();
  if (location.hash) history.replaceState(history.state, '', location.pathname);
  renderSessions();
}

// Màn đang bị che không nhận focus / chạm (điện thoại hiện một màn một lúc).
function syncInert() {
  const mobile = isMobile();
  const open = $('app').classList.contains('chat-open');
  $('sidebar').inert = mobile && open;
  (document.querySelector('.main') as HTMLElement).inert = mobile && !open;
}

// Điện thoại: kéo ngang để chuyển màn, màn đi theo ngón tay. Ở chat kéo sang phải → danh sách;
// ở danh sách kéo sang trái → session đang giữ. Thả: quá 30% bề ngang hoặc vuốt nhanh thì chuyển, không thì bật về.
// Bỏ qua khi bắt đầu trong vùng tự cuộn ngang (code, bảng, ảnh) hay đang mở menu / ảnh phóng to.
function setupSwipe() {
  const app = $('app');
  const side = $('sidebar');
  const main = document.querySelector('.main') as HTMLElement;
  let x0 = 0;
  let y0 = 0;
  let t0 = 0;
  let dx = 0;
  let mode: 'idle' | 'pending' | 'drag' | 'off' = 'idle';
  let fromChat = false;

  const place = (d: number) => {
    const w = app.clientWidth;
    if (fromChat) {
      const x = Math.max(0, Math.min(w, d));
      main.style.transform = `translateX(${x}px)`;
      side.style.transform = `translateX(${-0.28 * (w - x)}px)`;
    } else {
      const x = Math.max(-w, Math.min(0, d));
      main.style.transform = `translateX(${w + x}px)`;
      side.style.transform = `translateX(${0.28 * x}px)`;
    }
  };
  const release = () => {
    app.classList.remove('dragging');
    main.style.transform = '';
    side.style.transform = '';
  };

  app.addEventListener(
    'touchstart',
    (e) => {
      const t = e.target as HTMLElement;
      const blocked = inScrollableTable(t) || t.closest('pre, .thumbs, .attach-images, video, .menu, .slash-menu, textarea, input, select');
      fromChat = app.classList.contains('chat-open');
      const canGo = fromChat || !!state.current;
      mode = isMobile() && e.touches.length === 1 && !blocked && canGo && !menuEl && !document.getElementById('lightbox') && !htmlViewerOpen() ? 'pending' : 'off';
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      t0 = Date.now();
      dx = 0;
    },
    { passive: true },
  );

  app.addEventListener(
    'touchmove',
    (e) => {
      if (mode === 'off' || mode === 'idle') return;
      const mx = e.touches[0].clientX - x0;
      const my = e.touches[0].clientY - y0;
      if (mode === 'pending') {
        if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
        // Chỉ nhận vuốt ngang, và đúng hướng: chat → phải, danh sách → trái.
        const horizontal = Math.abs(mx) > Math.abs(my) * 1.2;
        const rightWay = fromChat ? mx > 0 : mx < 0;
        if (!horizontal || !rightWay) {
          mode = 'off';
          return;
        }
        mode = 'drag';
        app.classList.add('dragging');
      }
      e.preventDefault();
      dx = mx;
      place(dx);
    },
    { passive: false },
  );

  const end = () => {
    if (mode !== 'drag') {
      mode = 'idle';
      return;
    }
    mode = 'idle';
    const w = app.clientWidth;
    const speed = Math.abs(dx) / Math.max(1, Date.now() - t0);
    const go = Math.abs(dx) > w * 0.3 || speed > 0.5;
    // Bỏ kiểu inline rồi đổi lớp: transition chạy tiếp từ chỗ ngón tay dừng tới vị trí đích.
    release();
    if (!go) return;
    if (fromChat) goBack();
    else if (state.current) {
      if (state.current.id) void openSession(state.current.conn, state.current.id);
      else showChat(state.current.conn, '');
    }
  };
  app.addEventListener('touchend', end);
  app.addEventListener('touchcancel', () => {
    mode = 'idle';
    release();
  });
  addEventListener('resize', syncInert);
  syncInert();
}

// Bàn phím điện thoại: iOS không thu nhỏ trang khi bàn phím mở mà đẩy cả trang lên, để lại khoảng trống dưới ô nhập.
// Bám theo visualViewport: app nằm đúng phần còn thấy (vị trí và chiều cao), bỏ lề an toàn đáy khi bàn phím đang mở.
function setupViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    const open = innerHeight - vv.height > 120;
    // iOS kéo khung nhìn xuống (offsetTop) thay vì thu trang: đặt app đúng chỗ khung nhìn đang đứng.
    document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    document.documentElement.style.setProperty('--vvtop', `${Math.round(vv.offsetTop)}px`);
    document.body.classList.toggle('kb-open', open);
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}

// Máy tính: ẩn / hiện thanh bên để tập trung vào chat. Nút ở thanh trên hoặc Ctrl+B; nhớ trên thiết bị này.
const SIDE_KEY = 'sessionmon:sideHidden';
function setSideHidden(hidden: boolean) {
  $('app').classList.toggle('side-hidden', hidden);
  const btn = $('sideToggle');
  const label = hidden ? 'Hiện thanh bên' : 'Ẩn thanh bên';
  btn.title = `${label} (Ctrl+B)`;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-expanded', String(!hidden));
  try {
    localStorage.setItem(SIDE_KEY, hidden ? '1' : '');
  } catch {}
}

function setupSideToggle() {
  let hidden = false;
  try {
    hidden = localStorage.getItem(SIDE_KEY) === '1';
  } catch {}
  setSideHidden(hidden);
  $('sideToggle').onclick = () => setSideHidden(!$('app').classList.contains('side-hidden'));
  document.addEventListener('keydown', (e) => {
    if (isMobile() || e.key.toLowerCase() !== 'b' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    e.preventDefault();
    setSideHidden(!$('app').classList.contains('side-hidden'));
  });
}

function goBack() {
  if (history.state?.sessionmon === 'chat') history.back();
  else closeChat();
}

async function send() {
  const input = $<HTMLTextAreaElement>('input');
  const text = input.value.trim();
  const cur = state.current;
  if ((!text && !pendingFiles.length) || !cur) return;
  if (!cur.id) return void startDraft();
  stopVoice();
  input.value = '';
  autosize();
  const clientId = crypto.randomUUID();
  const files = pendingFiles;
  pendingFiles = [];
  renderTray();
  // Hiện ngay: ảnh xem trước bằng blob:, tệp khác ghi tên.
  const blocks: Block[] = files.filter((f) => f.preview).map((f) => ({ type: 'image', image: { url: f.preview!, mediaType: f.type } }));
  const others = files.filter((f) => !f.preview).map((f) => `📎 ${f.name}`);
  const shown = [text, ...others].filter(Boolean).join('\n');
  if (shown) blocks.push({ type: 'text', text: shown });
  const at = Date.now();
  state.messages.push({ id: clientId, role: 'user', blocks, at });
  state.lastResult = null;
  const s = current();
  if (s) {
    if (s.state !== 'running' && s.state !== 'requires_action') s.turnStartedAt = at;
    s.state = 'running';
  }
  renderMessages();
  renderHeader();
  try {
    const choice = choices.get(sessionKey()) ?? {};
    await api(cur.conn, `/api/sessions/${cur.id}/send`, {
      body: {
        text,
        clientId,
        mode: choice.mode ?? meta.mode,
        model: choice.model,
        effort: choice.effort,
        attachments: files.map(({ name, type, data }) => ({ name, type, data })),
      },
    });
  } catch (err) {
    state.lastResult = { ok: false, error: (err as Error).message };
    renderMessages();
  }
}

function autosize() {
  const t = $<HTMLTextAreaElement>('input');
  t.style.height = 'auto';
  t.style.height = Math.min(240, t.scrollHeight) + 'px';
}

function fillModes(select: HTMLSelectElement) {
  select.replaceChildren(...state.modes.map((m) => new Option(MODE_LABELS[m] ?? m, m)));
}

// ---------- Chọn thư mục làm việc cho session mới ----------

const RECENT_CWDS = 2;
let newCwd = '';
// Session tự do: agent tạo thư mục riêng lúc gửi tin đầu, newCwd để trống.
let newScratch = false;

const pathKey = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();

// Thư mục làm việc của một máy: lấy từ các session đã có và các đường dẫn tự thêm (đồng bộ qua library).
// Trả về [gần đây nhất (tối đa 2), còn lại theo tên].
function cwdChoices(conn: Conn) {
  const byKey = new Map<string, { path: string; at: number }>();
  const add = (path: string, at: number) => {
    const k = pathKey(path);
    const prev = byKey.get(k);
    if (!prev || at > prev.at) byKey.set(k, { path: prev?.path ?? path, at: Math.max(at, prev?.at ?? 0) });
  };
  for (const s of conn.sessions) if (s.cwd && !isScratch(s.cwd)) add(s.cwd, s.lastModified);
  for (const p of Object.values(state.library.paths ?? {})) if (p.machine === conn.machine.name && !p.deleted) add(p.path, p.updatedAt);
  const all = [...byKey.values()].sort((a, b) => b.at - a.at);
  const recent = all.slice(0, RECENT_CWDS);
  const rest = all.slice(RECENT_CWDS).sort((a, b) => folderName(a.path).localeCompare(folderName(b.path), 'vi'));
  return { recent, rest };
}

function setCwd(path: string, scratch = false) {
  newScratch = scratch;
  newCwd = scratch ? '' : path;
  $('newCwdName').textContent = scratch ? SCRATCH : path ? folderName(path) : 'Chọn thư mục';
  $('newCwdPath').textContent = scratch ? '(không thuộc dự án nào)' : path ? `(${path})` : '';
  $('newCwdBtn').title = scratch ? 'Mỗi session tự do có một thư mục riêng trong ~/SessionMon/scratch-workspaces' : path;
}

function fillCwds() {
  const conn = connByName($<HTMLSelectElement>('newMachine').value);
  if (!conn) return setCwd('');
  const { recent, rest } = cwdChoices(conn);
  const known = [...recent, ...rest].map((c) => pathKey(c.path));
  // Giữ lựa chọn nếu máy mới cũng có thư mục đó; không thì lấy thư mục của session đang mở, rồi thư mục gần nhất.
  if (newScratch) return setCwd('', true);
  if (newCwd && known.includes(pathKey(newCwd))) return setCwd(newCwd);
  const fromCurrent = state.current?.conn === conn ? current()?.cwd : undefined;
  if (fromCurrent && isScratch(fromCurrent)) return setCwd('', true);
  setCwd(fromCurrent ?? recent[0]?.path ?? '');
}

function openCwdPicker() {
  const conn = connByName($<HTMLSelectElement>('newMachine').value);
  if (!conn) return;
  const { recent, rest } = cwdChoices(conn);
  const item = (c: { path: string }): MenuItem => ({
    label: folderName(c.path),
    sub: c.path,
    on: !newScratch && pathKey(c.path) === pathKey(newCwd),
    run: () => setCwd(c.path),
  });
  const items: MenuItem[] = [
    { label: `✦ ${SCRATCH}`, sub: 'Không thuộc dự án nào, mỗi session một thư mục riêng', on: newScratch, run: () => setCwd('', true) },
  ];
  if (recent.length) items.push('Gần đây', ...recent.map(item));
  if (rest.length) items.push('Thư mục khác', ...rest.map(item));
  items.push({ label: '＋ Thêm đường dẫn…', run: () => toggleAddPath(true) });
  showMenu($('newCwdBtn'), items, `Thư mục trên máy ${conn.machine.name}`, true);
}

function toggleAddPath(show = $('addPathRow').hidden) {
  $('addPathRow').hidden = !show;
  $('addPathError').hidden = true;
  if (show) $('addPathInput').focus();
}

// Kiểm đường dẫn trên đúng máy sẽ chạy session, rồi lưu vào library để lần sau (và máy khác) chọn nhanh.
async function saveNewPath() {
  const conn = connByName($<HTMLSelectElement>('newMachine').value);
  const input = $<HTMLInputElement>('addPathInput');
  const raw = input.value.trim();
  const err = $('addPathError');
  if (!conn || !raw) return;
  try {
    const check = await api<{ ok: boolean; path: string }>(conn, '/api/path-check', { body: { path: raw } });
    if (!check.ok) throw new Error(`Không có thư mục này trên máy ${conn.machine.name}`);
    const self = selfConn();
    if (self) {
      const r = await api<{ library: Library }>(self, '/api/library/path', { body: { machine: conn.machine.name, path: check.path } });
      state.library = r.library;
    }
    setCwd(check.path);
    input.value = '';
    toggleAddPath(false);
  } catch (e) {
    err.textContent = (e as Error).message;
    err.hidden = false;
  }
}

// Mở màn chat trống để bắt đầu session mới (như Claude): chọn máy + thư mục trong khung chat, gõ ở ô nhập chung.
function openNewDraft() {
  const online = state.conns.filter((c) => c.ok);
  const prev = state.current?.conn;
  // Lúc mới mở app có thể chưa kết nối xong: vẫn mở trên máy đang phục vụ trang.
  const conn = (prev && prev.ok ? prev : (online.find((c) => c.base === '') ?? online[0])) ?? selfConn() ?? state.conns[0];
  if (!conn) return;
  stopVoice();
  enterDraft(conn);
  if (!isMobile()) $('input').focus();
}

// Danh sách máy trong màn session mới; máy chưa kết nối vẫn hiện để biết, ghi chú bên cạnh.
function fillMachineOptions() {
  const sel = $<HTMLSelectElement>('newMachine');
  const cur = state.current?.conn;
  const list = state.conns.filter((c) => c.base !== null && (c.ok || c === cur));
  sel.replaceChildren(...list.map((c) => new Option(`Máy ${c.machine.name}${c.ok ? '' : ' (đang kết nối…)'}`, c.machine.name)));
  if (cur) sel.value = cur.machine.name;
}

function enterDraft(conn: Conn) {
  state.current = { conn, id: '' };
  fillMachineOptions();
  state.messages = [];
  msgNodes.clear();
  openGroups.clear();
  meta = {};
  hideSlash();
  state.streaming = '';
  state.lastResult = null;
  fillCwds();
  toggleAddPath(false);
  $('newError').hidden = true;
  void initDraftChoices(conn);
  showChat(conn, '');
  renderSessions();
  renderHeader();
  renderMessages();
  renderAsks();
  renderComposerMeta();
}

// Mặc định cho session mới: Opus 5.5 (ưu tiên lựa chọn ghi rõ Opus 5.5, không có thì Default) · Medium · Bypass.
async function initDraftChoices(conn: Conn) {
  const key = `${conn.machine.name}:`;
  if (!choices.has(key)) choices.set(key, { mode: NEW_SESSION_MODE, effort: NEW_SESSION_EFFORT });
  const models = await modelsFor(conn);
  const ch = choices.get(key)!;
  if (!ch.model) {
    const mentions = (m: ModelOption) => /opus 5\.5/i.test(`${m.displayName} ${m.description}`);
    const pick = models.find((m) => m.value !== 'default' && mentions(m)) ?? models.find(mentions) ?? models.find((m) => m.value === 'default');
    if (pick) ch.model = pick.value;
    if (ch.effort && pick && !pick.efforts.includes(ch.effort)) delete ch.effort;
  }
  if (isCurrent(conn, '')) renderComposerMeta();
}

function draftError(msg: string) {
  const e = $('newError');
  e.textContent = msg;
  e.hidden = !msg;
}

let starting = false;

// Gửi tin đầu: tạo session trên máy đã chọn rồi chuyển sang session đó.
async function startDraft() {
  const cur = state.current;
  if (!cur || cur.id || starting) return;
  const conn = cur.conn;
  if (!newCwd && !newScratch) {
    draftError('Chọn thư mục làm việc trước khi gửi.');
    openCwdPicker();
    return;
  }
  const input = $<HTMLTextAreaElement>('input');
  stopVoice();
  const text = input.value.trim();
  const files = pendingFiles;
  if (!text && !files.length) return;
  const key = `${conn.machine.name}:`;
  const choice = choices.get(key) ?? {};
  const clientId = crypto.randomUUID();
  starting = true;
  draftError('');
  $<HTMLButtonElement>('sendBtn').disabled = true;
  try {
    const { id } = await api<{ id: string }>(conn, '/api/sessions', {
      body: {
        cwd: newCwd,
        scratch: newScratch || undefined,
        text,
        clientId,
        mode: choice.mode ?? NEW_SESSION_MODE,
        model: choice.model || undefined,
        effort: choice.effort || undefined,
        attachments: files.map(({ name, type, data }) => ({ name, type, data })),
      },
    });
    input.value = '';
    autosize();
    pendingFiles = [];
    renderTray();
    choices.set(`${conn.machine.name}:${id}`, { ...choice });
    if (!isCurrent(conn, '')) return; // người dùng đã chuyển đi chỗ khác
    // Mở session; hiện sẵn tin đầu (kể cả ảnh) nếu transcript chưa kịp ghi.
    const blocks: Block[] = files.filter((f) => f.preview).map((f) => ({ type: 'image', image: { url: f.preview!, mediaType: f.type } }));
    const shown = [text, ...files.filter((f) => !f.preview).map((f) => `📎 ${f.name}`)].filter(Boolean).join('\n');
    if (shown) blocks.push({ type: 'text', text: shown });
    await openSession(conn, id);
    if (!state.messages.some((m) => m.role === 'user')) {
      state.messages.unshift({ id: clientId, role: 'user', blocks });
      renderMessages();
    }
  } catch (err) {
    draftError((err as Error).message);
  } finally {
    starting = false;
    $<HTMLButtonElement>('sendBtn').disabled = false;
  }
}

// Mở app: link có #session thì mở session đó, không thì mở sẵn màn session mới (như Claude).
function startup() {
  const [machine, id] = decodeURIComponent(location.hash.slice(1)).split('/');
  if (machine === 'tasks' && id && state.library.projectDefs[id]) openTasks(id);
  else if (machine && id && connByName(machine)) openFromHash();
  else if (!state.current) openNewDraft();
}

function openFromHash() {
  const [machine, id] = decodeURIComponent(location.hash.slice(1)).split('/');
  // #tasks/<id dự án>: trang task của dự án.
  if (machine === 'tasks') {
    if (id && state.library.projectDefs[id] && taskView?.project !== id) openTasks(id);
    return;
  }
  const target = machine && id ? connByName(machine) : undefined;
  if (target && !isCurrent(target, id)) void openSession(target, id);
  else if (!target && (state.current || taskView) && location.hash !== '#new') closeChat();
}

// ---------- Chọn nhiều session, dọn session cũ ----------

function selectedItems(): Item[] {
  return state.conns.flatMap((conn) => conn.sessions.filter((s) => selected.has(libKey(conn, s.id))).map((s) => ({ conn, s })));
}

function setSelecting(on: boolean) {
  selecting = on;
  if (!on) selected.clear();
  closeMenu();
  renderSessions();
}

function renderSelectBar() {
  const n = selecting ? selectedItems().length : 0;
  $('selectBar').hidden = !selecting;
  $('selectBtn').classList.toggle('on', selecting);
  $('selectBtn').setAttribute('aria-pressed', String(selecting));
  $('selectCount').textContent = n ? `Đã chọn ${n}` : 'Chọn session hoặc nhóm';
  $<HTMLButtonElement>('selDelete').disabled = !n;
  $<HTMLButtonElement>('selMore').disabled = !n;
}

function openSelectMenu(anchor: HTMLElement) {
  const items = selectedItems();
  if (!items.length) return;
  const done = async (patch: Record<string, unknown>) => {
    await saveEntries(items, patch);
    setSelecting(false);
  };
  const menu: MenuItem[] = [
    { label: 'Ghim', run: () => void done({ pinned: true }) },
    { label: 'Bỏ ghim', run: () => void done({ pinned: false }) },
    'Chuyển vào thư mục',
    ...liveFolders().map(([id, f]) => ({ label: f.name, run: () => void done({ folder: id }) })),
    {
      label: '＋ Thư mục mới…',
      run: async () => {
        const id = await newFolder();
        if (id) await done({ folder: id });
      },
    },
    { label: 'Bỏ khỏi thư mục', run: () => void done({ folder: null }) },
  ];
  showMenu(anchor, menu, `${items.length} session`);
}

async function deleteSelected() {
  const items = selectedItems();
  if (await confirmDelete(items, `${items.length} session đã chọn`)) setSelecting(false);
}

// Dọn session không hoạt động quá X ngày trên các máy đang nối (bỏ qua session đã ghim hoặc đang mở).
// Chọn sẵn chúng rồi hỏi xoá; bấm Huỷ thì vẫn ở chế độ chọn để bỏ bớt vài session rồi xoá.
async function cleanOld() {
  const raw = await askText('Xoá session không hoạt động quá bao nhiêu ngày? (giữ session đã ghim hoặc đang mở)', String(loadPref<number>('cleanDays', 30)));
  if (raw === null) return;
  const days = Number.parseInt(raw, 10);
  if (!(days > 0)) return alert('Nhập số ngày lớn hơn 0');
  savePref('cleanDays', days);
  const cutoff = Date.now() - days * 86_400_000;
  const items = state.conns
    .filter((c) => c.ok)
    .flatMap((conn) => conn.sessions.filter((s) => s.lastModified < cutoff && !s.live && !entryOf(conn, s.id)?.pinned).map((s) => ({ conn, s })));
  if (!items.length) return showToast('Không có session cũ', `Không có session nào không hoạt động quá ${days} ngày`, () => {});
  selecting = true;
  selected.clear();
  for (const { conn, s } of items) selected.add(libKey(conn, s.id));
  renderSessions();
  if (await confirmDelete(items, `${items.length} session không hoạt động quá ${days} ngày`)) setSelecting(false);
}

// ---------- Dự án tự tạo ----------

async function saveProjectDef(body: Record<string, unknown>): Promise<string | null> {
  const self = selfConn();
  if (!self) throw new Error('Không nối được agent của máy đang mở trang');
  const r = await api<{ id: string; library: Library }>(self, '/api/library/projectdef', { body });
  state.library = r.library;
  renderSessions();
  if (taskView) renderTasks();
  return r.id;
}

// Hộp thoại tạo / sửa dự án: tên, mã (đầu mã task) và thư mục gốc trên từng máy.
function openProjectDialog(id: string | null, seed: ProjectRoot[] = []) {
  closeMenu();
  const prev = id ? state.library.projectDefs[id] : undefined;
  const dlg = document.createElement('dialog');
  dlg.className = 'ask-text project-dlg';
  const form = document.createElement('form');
  form.method = 'dialog';
  const field = (label: string, input: HTMLElement) => {
    const l = Object.assign(document.createElement('label'), { className: 'pd-field' });
    l.append(Object.assign(document.createElement('span'), { className: 'ask-text-label', textContent: label }), input);
    return l;
  };
  const name = Object.assign(document.createElement('input'), { type: 'text', value: prev?.name ?? '', placeholder: 'vd game1', autocomplete: 'off', spellcheck: false });
  const code = Object.assign(document.createElement('input'), { type: 'text', value: prev?.code ?? '', placeholder: 'tự đặt theo tên', autocomplete: 'off', spellcheck: false });
  code.maxLength = 8;
  code.className = 'pd-code';
  const rootsBox = Object.assign(document.createElement('div'), { className: 'pd-roots' });
  const machines = state.conns.map((c) => c.machine.name);
  const addRoot = (r?: ProjectRoot) => {
    const row = Object.assign(document.createElement('div'), { className: 'pd-root' });
    const sel = document.createElement('select');
    sel.append(...machines.map((m) => new Option(`Máy ${m}`, m)));
    sel.value = r?.machine ?? state.self?.name ?? machines[0];
    const path = Object.assign(document.createElement('input'), { type: 'text', value: r?.path ?? '', placeholder: 'E:\\Work\\du-an', autocomplete: 'off', spellcheck: false });
    path.setAttribute('autocapitalize', 'off');
    const x = button('×', 'icon-btn pd-remove', () => row.remove());
    x.setAttribute('aria-label', 'Bỏ thư mục này');
    row.append(sel, path, x);
    rootsBox.append(row);
    return path;
  };
  for (const r of prev?.roots ?? []) addRoot(r);
  for (const r of seed) addRoot(r);
  if (!rootsBox.children.length) addRoot();
  const err = Object.assign(document.createElement('p'), { className: 'form-error', hidden: true });
  const actions = Object.assign(document.createElement('div'), { className: 'ask-text-actions' });
  if (id)
    actions.append(
      button('Xoá dự án', 'ghost-btn danger-btn', async () => {
        if (!confirm(`Xoá dự án "${prev!.name}"? Session vẫn còn (về nhóm Khác), task của dự án bị ẩn.`)) return;
        try {
          await saveProjectDef({ id, deleted: true });
          if (taskView?.project === id) closeTasks();
          dlg.close();
        } catch (e) {
          err.textContent = (e as Error).message;
          err.hidden = false;
        }
      }),
      Object.assign(document.createElement('span'), { className: 'row-spacer' }),
    );
  const ok = Object.assign(document.createElement('button'), { type: 'submit', className: 'primary-btn', textContent: 'Lưu' });
  actions.append(
    button('Huỷ', 'ghost-btn', () => dlg.close()),
    ok,
  );
  form.append(
    Object.assign(document.createElement('h3'), { className: 'pd-title', textContent: id ? 'Sửa dự án' : 'Dự án mới' }),
    field('Tên dự án', name),
    field('Mã (đầu mã task, vd MSO → MSO-12)', code),
    Object.assign(document.createElement('span'), {
      className: 'ask-text-label',
      textContent: 'Thư mục gốc trên từng máy (session ở thư mục này hoặc thư mục con thuộc dự án)',
    }),
    rootsBox,
    button('＋ Thêm thư mục', 'ghost-btn pd-add', () => addRoot().focus()),
    err,
    actions,
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    ok.disabled = true;
    try {
      if (!name.value.trim()) throw new Error('Đặt tên cho dự án');
      const roots: ProjectRoot[] = [];
      for (const row of rootsBox.querySelectorAll<HTMLElement>('.pd-root')) {
        const machine = row.querySelector('select')!.value;
        let path = row.querySelector('input')!.value.trim().replace(/^"(.*)"$/, '$1');
        if (!path) continue;
        // Máy đang nối thì kiểm đường dẫn có thật trên máy đó; máy mất kết nối thì lưu như đã gõ.
        const conn = connByName(machine);
        if (conn?.ok) {
          const check = await api<{ ok: boolean; path: string }>(conn, '/api/path-check', { body: { path } });
          if (!check.ok) throw new Error(`Không có thư mục ${path} trên máy ${machine}`);
          path = check.path;
        }
        roots.push({ machine, path });
      }
      if (!roots.length) throw new Error('Thêm ít nhất một thư mục gốc');
      await saveProjectDef({ id: id ?? undefined, name: name.value.trim(), code: code.value.trim(), roots });
      dlg.close();
    } catch (e2) {
      err.textContent = (e2 as Error).message;
      err.hidden = false;
    } finally {
      ok.disabled = false;
    }
  };
  dlg.onclick = (e) => {
    if (e.target === dlg) dlg.close();
  };
  dlg.onclose = () => dlg.remove();
  dlg.append(form);
  document.body.append(dlg);
  dlg.showModal();
  name.focus();
}

// Đưa các thư mục làm việc của một nhóm session vào dự án có sẵn.
async function addRootsToProject(id: string, items: Item[]) {
  const p = state.library.projectDefs[id];
  const roots = [...p.roots];
  for (const { conn, s } of items) {
    if (!s.cwd || isScratch(s.cwd) || defOf(conn.machine.name, s.cwd) === id) continue;
    if (!roots.some((r) => r.machine === conn.machine.name && normPath(r.path) === normPath(s.cwd))) roots.push({ machine: conn.machine.name, path: s.cwd });
  }
  try {
    await saveProjectDef({ id, roots });
  } catch (e) {
    alert((e as Error).message);
  }
}

function groupRoots(items: Item[]): ProjectRoot[] {
  const out: ProjectRoot[] = [];
  for (const { conn, s } of items)
    if (s.cwd && !isScratch(s.cwd) && !out.some((r) => r.machine === conn.machine.name && normPath(r.path) === normPath(s.cwd)))
      out.push({ machine: conn.machine.name, path: s.cwd });
  return out;
}

async function moveProject(id: string, dir: -1 | 1) {
  const ids = liveProjects().map(([pid]) => pid);
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  try {
    for (const [order, pid] of ids.entries()) if (state.library.projectDefs[pid].order !== order) await saveProjectDef({ id: pid, order });
  } catch (e) {
    alert((e as Error).message);
  }
}

// Nút ⋯ của dự án tự tạo.
function openProjectMenu(id: string, anchor: HTMLElement, items: Item[]) {
  const p = state.library.projectDefs[id];
  const ids = liveProjects().map(([pid]) => pid);
  const pos = ids.indexOf(id);
  const menu: MenuItem[] = [
    { label: 'Task của dự án', sub: `${liveTasks(id).filter(([, t]) => t.status !== 'done').length} chưa xong`, run: () => openTasks(id) },
    { label: 'Checklist của dự án', sub: `${liveChecklists(id).length} checklist`, run: () => openTasks(id, null, 'checklists') },
  ];
  const roots = p.roots.filter((r) => connByName(r.machine)?.ok);
  if (roots.length) {
    menu.push('Session mới');
    for (const r of roots) menu.push({ label: `Máy ${r.machine}`, sub: r.path, run: () => newSessionIn(connByName(r.machine)!, r.path) });
  }
  menu.push('Dự án');
  menu.push({ label: 'Sửa dự án…', run: () => openProjectDialog(id) });
  if (pos > 0) menu.push({ label: 'Lên trên', run: () => void moveProject(id, -1) });
  if (pos >= 0 && pos < ids.length - 1) menu.push({ label: 'Xuống dưới', run: () => void moveProject(id, 1) });
  menu.push({ label: '＋ Dự án mới…', run: () => openProjectDialog(null) });
  if (items.length) menu.push({ label: `Xoá ${items.length} session…`, danger: true, run: () => void confirmDelete(items, `${items.length} session của dự án "${p.name}"`) });
  showMenu(anchor, menu, p.name);
}

// ---------- Task của dự án ----------

// Lọc danh sách: trạng thái ('open' = mọi trạng thái trừ Done), mức ưu tiên, phiên bản ('-' = chưa định), chữ tìm.
interface TaskFilter {
  status: 'open' | 'all' | TaskStatus;
  priority: 'all' | TaskPriority;
  version: string;
  q: string;
}
const TASK_STATUS_ORDER: TaskStatus[] = ['todo', 'doing', 'pending', 'done'];
const STATUS_LABEL: Record<TaskStatus, string> = { todo: 'To do', doing: 'Doing', pending: 'Pending', done: 'Done' };
const TASK_PRIORITY_ORDER: TaskPriority[] = ['urgent', 'high', 'medium', 'low'];
const PRIORITY_LABEL: Record<TaskPriority, string> = { urgent: 'Khẩn', high: 'Cao', medium: 'Vừa', low: 'Thấp' };
const prio = (t: LibraryTask): TaskPriority => t.priority ?? 'medium';
const defaultTaskFilter = (): TaskFilter => ({ status: 'open', priority: 'all', version: 'all', q: '' });
// task: id đang xem, 'new' = đang tạo; editing: đang sửa (form).
// tab: trang Task hay Checklist; cl: id checklist mẫu đang xem ('new' = đang tạo); run: id lượt chạy đang xem.
let taskView: {
  project: string;
  tab: 'tasks' | 'checklists';
  task: string | null;
  cl: string | null;
  run: string | null;
  editing: boolean;
  filter: TaskFilter;
} | null = null;
// Nội dung đang sửa, giữ riêng để sự kiện library từ máy khác không xoá chữ đang gõ.
let taskDraft: { title: string; body: string; images: TaskImage[]; status: TaskStatus; priority: TaskPriority; version: string } | null = null;
let taskUploads = 0;

const imgUrl = (sha: string) => `${selfConn()?.base ?? ''}/api/library/image/${sha}`;

// Hiện khung chính (điện thoại: chuyển sang màn bên phải, thêm mục lịch sử để nút quay lại về danh sách).
function showMain(hash: string) {
  if (isMobile() && !$('app').classList.contains('chat-open')) {
    if (location.hash === hash) history.replaceState(null, '', location.pathname + location.search);
    history.pushState({ sessionmon: 'chat' }, '', hash);
  } else history.replaceState(history.state, '', hash);
  $('app').classList.add('chat-open');
  syncInert();
}

function openTasks(project: string, task: string | null = null, tab: 'tasks' | 'checklists' = 'tasks') {
  if (!state.library.projectDefs[project]) return;
  closeMenu();
  taskView = { project, tab, task, cl: null, run: null, editing: false, filter: taskView?.project === project ? taskView.filter : defaultTaskFilter() };
  taskDraft = null;
  clDraft = null;
  $('tasksPage').hidden = false;
  showMain(`#tasks/${project}`);
  renderTasks();
  renderSessions();
}

// Đóng trang task (không đổi màn trên điện thoại; closeChat lo việc đó).
function hideTasks() {
  if (!taskView) return;
  taskView = null;
  taskDraft = null;
  clDraft = null;
  $('tasksPage').hidden = true;
  $('tasksPage').replaceChildren();
  renderSessions();
}

// Nút đóng trang task: về session đang giữ (máy tính) hoặc về danh sách (điện thoại).
function closeTasks() {
  hideTasks();
  if (isMobile()) return goBack();
  const cur = state.current;
  if (!cur) return openNewDraft();
  history.replaceState(history.state, '', cur.id ? `#${cur.conn.machine.name}/${cur.id}` : '#new');
}

function taskBack() {
  if (!taskView) return;
  if (taskView.editing && !confirmLeaveEdit()) return;
  if (taskView.tab === 'checklists') return checklistBack();
  if (taskView.editing && taskView.task !== 'new') {
    taskView.editing = false;
    taskDraft = null;
  } else if (taskView.task) {
    taskView.task = null;
    taskView.editing = false;
    taskDraft = null;
  } else return closeTasks();
  renderTasks();
}

function confirmLeaveEdit(): boolean {
  if (taskView?.tab === 'checklists') return confirmLeaveChecklistEdit();
  if (!taskView?.editing || !taskDraft) return true;
  const t = taskView.task && taskView.task !== 'new' ? state.library.tasks[taskView.task] : undefined;
  const changed = t
    ? taskDraft.title !== t.title ||
      taskDraft.body !== t.body ||
      taskDraft.images.length !== t.images.length ||
      taskDraft.status !== t.status ||
      taskDraft.priority !== prio(t) ||
      taskDraft.version !== (t.version ?? '')
    : !!(taskDraft.title.trim() || taskDraft.body.trim() || taskDraft.images.length);
  return !changed || confirm('Bỏ những gì đang sửa?');
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function statusPill(s: TaskStatus) {
  return el('span', `task-status ${s}`, STATUS_LABEL[s]);
}

function priorityPill(p: TaskPriority) {
  return el('span', `task-prio ${p}`, PRIORITY_LABEL[p]);
}

function selectOf<T extends string>(cls: string, opts: [T, string][], value: T, onChange: (v: T) => void) {
  const s = document.createElement('select');
  s.className = cls;
  for (const [v, label] of opts) s.append(new Option(label, v));
  s.value = value;
  s.onchange = () => onChange(s.value as T);
  return s;
}

const statusOpts = (): [TaskStatus, string][] => TASK_STATUS_ORDER.map((s) => [s, STATUS_LABEL[s]]);
const priorityOpts = (): [TaskPriority, string][] => TASK_PRIORITY_ORDER.map((x) => [x, `Ưu tiên: ${PRIORITY_LABEL[x]}`]);

// Các phiên bản đã dùng trong dự án, mới nhất trước (so theo số: 1.10 > 1.9).
function projectVersions(project: string): string[] {
  const vs = [...new Set(liveTasks(project).map(([, t]) => t.version).filter((v): v is string => !!v))];
  return vs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

function renderTasks() {
  const page = $('tasksPage');
  if (!taskView) return;
  const p = state.library.projectDefs[taskView.project];
  if (!p || p.deleted) return closeTasks();
  if (taskView.tab === 'checklists') return renderChecklists(page, p);
  if (taskView.task && taskView.task !== 'new' && (!state.library.tasks[taskView.task] || state.library.tasks[taskView.task].deleted)) {
    taskView.task = null;
    taskView.editing = false;
  }
  if (taskView.editing) return renderTaskEditor(page, p);
  if (taskView.task) return renderTaskDetail(page, p, taskView.task);
  renderTaskList(page, taskView.project, p);
}

function tasksHead(title: string, sub: string, actions: HTMLElement[]) {
  const head = el('header', 'topbar tasks-head');
  const back = button('‹', 'icon-btn tasks-back', taskBack);
  back.setAttribute('aria-label', 'Quay lại');
  const wrap = el('div', 'title-wrap');
  wrap.append(el('div', 'title', title), el('div', 'subtitle', sub));
  head.append(back, wrap, ...actions);
  return head;
}

function renderTaskList(page: HTMLElement, project: string, p: LibraryProjectDef) {
  const all = liveTasks(project);
  const f = taskView!.filter;
  const versions = projectVersions(project);
  if (f.version !== 'all' && f.version !== '-' && !versions.includes(f.version)) f.version = 'all';
  const q = f.q.trim().toLowerCase();
  // Áp lọc ưu tiên / phiên bản / chữ tìm trước, để số trên nút trạng thái khớp với danh sách đang thấy.
  const base = all.filter(
    ([, t]) =>
      (f.priority === 'all' || prio(t) === f.priority) &&
      (f.version === 'all' || (f.version === '-' ? !t.version : t.version === f.version)) &&
      (!q || t.title.toLowerCase().includes(q) || taskCode(t).toLowerCase() === q || String(t.num) === q),
  );
  const match = (st: TaskFilter['status'], t: LibraryTask) => (st === 'all' ? true : st === 'open' ? t.status !== 'done' : t.status === st);
  const shown = base.filter(([, t]) => match(f.status, t));
  const rank: Record<TaskStatus, number> = { doing: 0, todo: 1, pending: 2, done: 3 };
  const prank = (t: LibraryTask) => TASK_PRIORITY_ORDER.indexOf(prio(t));
  shown.sort(([, a], [, b]) => rank[a.status] - rank[b.status] || prank(a) - prank(b) || b.num - a.num);

  const add = button('＋ Task mới', 'primary-btn', () => {
    taskView = { ...taskView!, task: 'new', editing: true };
    // Đang lọc theo một mức ưu tiên / phiên bản thì task mới nhận luôn giá trị đó.
    taskDraft = {
      title: '',
      body: '',
      images: [],
      status: 'todo',
      priority: f.priority !== 'all' ? f.priority : 'medium',
      version: f.version !== 'all' && f.version !== '-' ? f.version : '',
    };
    renderTasks();
  });
  const head = tasksHead(`Task · ${p.name}`, `Mã ${p.code} · ${p.roots.map((r) => r.machine).filter((m, i, a) => a.indexOf(m) === i).join(', ')}`, [add]);

  const chips = el('div', 'time-basis task-filter');
  const statusChips: [TaskFilter['status'], string][] = [['open', 'Chưa xong'], ...statusOpts(), ['all', 'Tất cả']];
  for (const [st, label] of statusChips) {
    chips.append(
      button(`${label} · ${base.filter(([, t]) => match(st, t)).length}`, st === f.status ? 'on' : '', () => {
        f.status = st;
        renderTasks();
      }),
    );
  }

  const bar = el('div', 'task-filterbar');
  const search = Object.assign(document.createElement('input'), { type: 'search', value: f.q, placeholder: `Tìm tiêu đề hoặc số (vd ${p.code}-3)`, className: 'task-input task-search' });
  search.oninput = () => {
    f.q = search.value;
    const pos = search.selectionStart;
    renderTasks();
    const again = document.querySelector<HTMLInputElement>('.task-search');
    if (again) {
      again.focus();
      again.setSelectionRange(pos, pos);
    }
  };
  bar.append(
    search,
    selectOf<TaskFilter['priority']>('task-status-select', [['all', 'Mọi ưu tiên'], ...priorityOpts()], f.priority, (v) => {
      f.priority = v;
      renderTasks();
    }),
    selectOf<string>('task-status-select', [['all', 'Mọi phiên bản'], ['-', 'Chưa định phiên bản'], ...versions.map((v): [string, string] => [v, `Phiên bản ${v}`])], f.version, (v) => {
      f.version = v;
      renderTasks();
    }),
  );
  if (f.priority !== 'all' || f.version !== 'all' || f.q) {
    bar.append(
      button('Bỏ lọc', 'ghost-btn', () => {
        taskView!.filter = { ...defaultTaskFilter(), status: f.status };
        renderTasks();
      }),
    );
  }

  // List view: mỗi task một dòng, cột cố định: số · tiêu đề · ưu tiên · trạng thái · phiên bản.
  const list = el('div', 'task-list');
  if (shown.length) {
    const hdr = el('div', 'task-row task-row-head');
    hdr.append(el('span', 'task-code', '#'), el('span', 'task-title', 'Tiêu đề'), el('span', 'task-col-prio', 'Ưu tiên'), el('span', 'task-col-status', 'Trạng thái'), el('span', 'task-ver', 'Phiên bản'));
    list.append(hdr);
  }
  for (const [id, t] of shown) {
    const row = button('', `task-row${t.status === 'done' ? ' is-done' : ''}`, () => {
      taskView = { ...taskView!, task: id, editing: false };
      renderTasks();
    });
    const title = el('span', 'task-title', t.title);
    if (t.images.length) title.append(el('span', 'task-imgs', ` 🖼 ${t.images.length}`));
    const pc = el('span', 'task-col-prio');
    pc.append(priorityPill(prio(t)));
    const sc = el('span', 'task-col-status');
    sc.append(statusPill(t.status));
    row.append(el('span', 'task-code', taskCode(t)), title, pc, sc, el('span', 'task-ver' + (t.version ? '' : ' none'), t.version || '—'));
    list.append(row);
  }
  if (!shown.length) list.append(el('p', 'task-empty', all.length ? 'Không có task nào khớp bộ lọc.' : 'Chưa có task nào. Bấm ＋ Task mới để thêm.'));
  else list.append(el('p', 'task-hint', `${shown.length} / ${all.length} task`));

  const body = el('div', 'tasks-body');
  body.append(pageTabs(), chips, bar, list);
  page.replaceChildren(head, body);
}

function taskImages(images: TaskImage[], code: string, onRemove?: (i: number) => void) {
  const grid = el('div', 'task-images');
  const items = images.map((img, i) => ({ src: imgUrl(img.sha), caption: img.name || `${code} · ảnh ${i + 1}` }));
  images.forEach((img, i) => {
    const cell = el('div', 'task-image');
    const im = Object.assign(document.createElement('img'), { src: imgUrl(img.sha), alt: items[i].caption, loading: 'lazy' });
    makeZoomable(im, () => openLightbox(items, i, im));
    cell.append(im);
    if (onRemove) {
      const x = button('×', 'tray-remove', () => onRemove(i));
      x.setAttribute('aria-label', 'Bỏ ảnh này');
      cell.append(x);
    }
    grid.append(cell);
  });
  return grid;
}

function renderTaskDetail(page: HTMLElement, p: LibraryProjectDef, id: string) {
  const t = state.library.tasks[id];
  const code = taskCode(t);
  const edit = button('Sửa', 'ghost-btn', () => {
    taskView!.editing = true;
    taskDraft = { title: t.title, body: t.body, images: [...t.images], status: t.status, priority: prio(t), version: t.version ?? '' };
    renderTasks();
  });
  const head = tasksHead(code, p.name, [edit]);

  const body = el('div', 'tasks-body task-detail');
  const status = selectOf('task-status-select', statusOpts(), t.status, (v) => void saveTask({ id, status: v }));
  const priority = selectOf('task-status-select', priorityOpts(), prio(t), (v) => void saveTask({ id, priority: v }));
  const meta = el('div', 'task-meta');
  meta.append(el('span', 'task-code', code), status, priority);
  if (t.version) meta.append(el('span', 'task-ver-badge', `Phiên bản ${t.version}`));
  meta.append(el('span', 'task-date', `tạo ${new Date(t.createdAt).toLocaleDateString('vi-VN')}`));
  body.append(meta, el('h2', 'task-heading', t.title));
  if (t.body.trim()) {
    const text = el('div', 'msg-assistant task-text');
    text.innerHTML = md(t.body);
    body.append(text);
  }
  if (t.images.length) {
    body.append(el('p', 'task-hint', 'Bấm vào ảnh để xem cỡ lớn'));
    body.append(taskImages(t.images, code));
  }
  const actions = el('div', 'task-actions');
  const run = button('Session mới cho task này', 'primary-btn', () => void sessionForTask(id, run));
  actions.append(
    run,
    button('Xoá task', 'ghost-btn danger-btn', async () => {
      if (!confirm(`Xoá task ${code}?`)) return;
      if (await saveTask({ id, deleted: true })) {
        taskView!.task = null;
        renderTasks();
      }
    }),
  );
  body.append(actions);
  page.replaceChildren(head, body);
}

function renderTaskEditor(page: HTMLElement, p: LibraryProjectDef) {
  const isNew = taskView!.task === 'new';
  const t = isNew ? undefined : state.library.tasks[taskView!.task!];
  const d = taskDraft!;
  const code = t ? taskCode(t) : `${p.code}-mới`;
  const save = button('Lưu', 'primary-btn', () => void submitTask());
  save.disabled = taskUploads > 0;
  const head = tasksHead(isNew ? 'Task mới' : `Sửa ${code}`, p.name, [save]);

  const body = el('div', 'tasks-body task-form');
  const title = Object.assign(document.createElement('input'), { type: 'text', value: d.title, placeholder: 'Tiêu đề task', className: 'task-input' });
  title.oninput = () => (d.title = title.value);
  const status = selectOf('task-status-select', statusOpts(), d.status, (v) => (d.status = v));
  const priority = selectOf('task-status-select', priorityOpts(), d.priority, (v) => (d.priority = v));
  // Target version: gõ tự do, gợi ý các phiên bản đã dùng trong dự án.
  const verList = Object.assign(document.createElement('datalist'), { id: 'taskVersions' });
  for (const v of projectVersions(taskView!.project)) verList.append(new Option(v, v));
  const version = Object.assign(document.createElement('input'), { type: 'text', value: d.version, placeholder: 'Target version (vd 1.4.0)', className: 'task-input task-version', maxLength: 40 });
  version.setAttribute('list', 'taskVersions');
  version.oninput = () => (d.version = version.value);
  const text = Object.assign(document.createElement('textarea'), { value: d.body, placeholder: 'Mô tả (Markdown). Dán ảnh vào đây cũng được.', className: 'task-input task-body', rows: 8 });
  text.oninput = () => {
    d.body = text.value;
    text.style.height = 'auto';
    text.style.height = `${Math.min(text.scrollHeight + 2, innerHeight * 0.6)}px`;
  };
  const imgs = el('div', 'task-images-wrap');
  const drawImages = () => {
    imgs.replaceChildren(
      taskImages(d.images, code, (i) => {
        d.images.splice(i, 1);
        drawImages();
      }),
    );
    if (taskUploads) imgs.append(el('p', 'task-hint', `Đang tải ${taskUploads} ảnh…`));
    save.disabled = taskUploads > 0;
  };
  const file = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const upload = async (files: File[]) => {
    files = files.filter((f) => f.type.startsWith('image/'));
    taskUploads += files.length;
    drawImages();
    for (const f of files) {
      try {
        const img = await prepareImage(f);
        if (!img) throw new Error(`Không đọc được ảnh ${f.name}`);
        const r = await api<{ sha: string; type: string }>(selfConn()!, '/api/library/image', { body: { type: img.type, data: await blobToBase64(img.blob) } });
        d.images.push({ sha: r.sha, type: r.type, name: f.name && f.name !== 'image.png' ? f.name : undefined });
      } catch (e) {
        alert((e as Error).message);
      } finally {
        taskUploads--;
        drawImages();
      }
    }
  };
  file.onchange = () => {
    void upload([...(file.files ?? [])]);
    file.value = '';
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    void upload(files);
  };
  text.addEventListener('paste', onPaste);
  title.addEventListener('paste', onPaste);
  body.ondragover = (e) => e.preventDefault();
  body.ondrop = (e) => {
    e.preventDefault();
    void upload([...(e.dataTransfer?.files ?? [])]);
  };
  const addImg = button('＋ Thêm ảnh', 'ghost-btn', () => file.click());
  const row = el('div', 'task-meta');
  const verLabel = el('label', 'task-date', 'Target version');
  verLabel.htmlFor = version.id = 'taskVersion';
  row.append(el('span', 'task-code', code), status, priority, verLabel, version, verList);
  const err = el('p', 'form-error');
  err.id = 'taskError';
  err.hidden = true;
  body.append(row, title, text, imgs, addImg, file, err);
  page.replaceChildren(head, body);
  drawImages();
  requestAnimationFrame(() => text.dispatchEvent(new Event('input')));
  if (!isMobile()) (isNew ? title : text).focus();
}

async function saveTask(b: Record<string, unknown>): Promise<string | null> {
  const self = selfConn();
  try {
    if (!self) throw new Error('Không nối được agent của máy đang mở trang');
    const r = await api<{ id: string; library: Library }>(self, '/api/library/task', { body: b });
    state.library = r.library;
    renderSessions();
    if (taskView && !taskView.editing) renderTasks();
    return r.id;
  } catch (e) {
    const err = document.getElementById('taskError');
    if (err) {
      err.textContent = (e as Error).message;
      err.hidden = false;
    } else alert((e as Error).message);
    return null;
  }
}

async function submitTask() {
  if (!taskView || !taskDraft || taskUploads) return;
  const d = taskDraft;
  if (!d.title.trim()) {
    const err = document.getElementById('taskError');
    if (err) {
      err.textContent = 'Task cần có tiêu đề';
      err.hidden = false;
    }
    return;
  }
  const isNew = taskView.task === 'new';
  const id = await saveTask({
    id: isNew ? undefined : taskView.task,
    project: taskView.project,
    title: d.title.trim(),
    body: d.body,
    images: d.images,
    status: d.status,
    priority: d.priority,
    version: d.version.trim(),
  });
  if (!id || !taskView) return;
  taskView.task = id;
  taskView.editing = false;
  taskDraft = null;
  renderTasks();
}

// Mở session mới ở thư mục gốc của dự án, điền sẵn mã, tiêu đề, mô tả và ảnh của task vào ô nhập.
async function sessionForTask(id: string, anchor: HTMLElement) {
  const t = state.library.tasks[id];
  pickProjectRoot(t.project, anchor, 'Session mới cho task', async (r) => {
    newSessionIn(connByName(r.machine)!, r.path);
    const input = $<HTMLTextAreaElement>('input');
    input.value = [`${taskCode(t)}: ${t.title}`, t.body.trim()].filter(Boolean).join('\n\n');
    autosize();
    const files: File[] = [];
    for (const [i, img] of t.images.entries()) {
      try {
        const blob = await fetch(imgUrl(img.sha)).then((res) => (res.ok ? res.blob() : Promise.reject(new Error(res.statusText))));
        const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        files.push(new File([blob], img.name || `${taskCode(t)}-${i + 1}.${ext}`, { type: blob.type || img.type }));
      } catch {}
    }
    if (files.length) await addFiles(files);
  });
}

// Chọn thư mục gốc của dự án trên một máy đang kết nối (một máy thì khỏi hỏi) rồi chạy go.
function pickProjectRoot(project: string, anchor: HTMLElement, heading: string, go: (r: ProjectRoot) => void | Promise<void>) {
  const p = state.library.projectDefs[project];
  const roots = p.roots.filter((r) => connByName(r.machine)?.ok);
  if (!roots.length) return alert('Dự án chưa có thư mục gốc trên máy nào đang kết nối.');
  if (roots.length === 1) return void go(roots[0]);
  showMenu(anchor, ['Mở session ở', ...roots.map((r) => ({ label: `Máy ${r.machine}`, sub: r.path, run: () => void go(r) }))], heading);
}

// ---------- Checklist của dự án ----------
//
// Checklist mẫu (vd "Verify trước khi release") gồm các mục; mỗi lần dùng tạo một lượt chạy gắn với phiên bản,
// chụp lại các mục của mẫu. Người dùng tick tay, hoặc bấm "Cho Claude verify": mở session ở thư mục dự án với
// prompt liệt kê các mục, Claude quét project rồi báo từng mục qua tool checklist_report (agent ghi vào library).

const RESULT_LABEL: Record<CheckResult, string> = { pass: 'Đạt', fail: 'Lỗi', skip: 'Bỏ qua', todo: 'Chưa kiểm' };
const RESULT_ICON: Record<CheckResult, string> = { pass: '✓', fail: '✗', skip: '–', todo: '' };
// Mẫu đang sửa: tên, hướng dẫn cho Claude, các mục dạng chữ (mỗi dòng một mục, dòng bắt đầu bằng # là tiêu đề nhóm).
let clDraft: { name: string; notes: string; text: string } | null = null;

const liveChecklists = (project: string) =>
  Object.entries(state.library.checklists ?? {})
    .filter(([, c]) => c.project === project && !c.deleted)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));
const liveRuns = (project: string, checklist?: string) =>
  Object.entries(state.library.checklistRuns ?? {})
    .filter(([, r]) => r.project === project && !r.deleted && (!checklist || r.checklist === checklist))
    .sort(([, a], [, b]) => b.createdAt - a.createdAt);
const checkResult = (run: string, item: string) => state.library.checkResults?.[`${run}:${item}`];

function runStats(id: string, r: LibraryChecklistRun) {
  const n: Record<CheckResult, number> = { pass: 0, fail: 0, skip: 0, todo: 0 };
  for (const i of r.items) if (!i.heading) n[checkResult(id, i.id)?.result ?? 'todo']++;
  return { ...n, total: n.pass + n.fail + n.skip + n.todo };
}

const itemsToText = (items: ChecklistItem[]) => items.map((i) => (i.heading ? `# ${i.text}` : i.text)).join('\n');

// Chữ -> mục; giữ id của mục cũ trùng nội dung để lượt chạy và kết quả cũ vẫn khớp.
function textToItems(text: string, prev: ChecklistItem[]): ChecklistItem[] {
  const pool = [...prev];
  const out: ChecklistItem[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^[-*]\s*(\[[ xX]?\]\s*)?/, '');
    if (!line) continue;
    const heading = /^#+\s*/.test(line);
    const t = line.replace(/^#+\s*/, '').trim();
    if (!t) continue;
    const i = pool.findIndex((x) => x.text === t && !!x.heading === heading);
    const id = i >= 0 ? pool.splice(i, 1)[0].id : '';
    out.push(heading ? { id, text: t, heading: true } : { id, text: t });
  }
  return out;
}

function pageTabs() {
  const tabs = el('div', 'view-switch task-tabs');
  tabs.setAttribute('role', 'tablist');
  for (const [tab, label] of [['tasks', 'Task'], ['checklists', 'Checklist']] as const) {
    const b = button(label, taskView!.tab === tab ? 'on' : '', () => {
      if (taskView!.tab === tab) return;
      taskView = { ...taskView!, tab, task: null, cl: null, run: null, editing: false };
      taskDraft = null;
      clDraft = null;
      renderTasks();
      renderSessions();
    });
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(taskView!.tab === tab));
    tabs.append(b);
  }
  return tabs;
}

function checklistBack() {
  const v = taskView!;
  if (v.editing) {
    v.editing = false;
    if (v.cl === 'new') v.cl = null;
    clDraft = null;
  } else if (v.run) {
    v.cl = state.library.checklistRuns?.[v.run]?.checklist ?? null;
    if (v.cl && (!state.library.checklists?.[v.cl] || state.library.checklists[v.cl].deleted)) v.cl = null;
    v.run = null;
  } else if (v.cl) v.cl = null;
  else return closeTasks();
  renderTasks();
}

function confirmLeaveChecklistEdit(): boolean {
  if (!taskView?.editing || !clDraft) return true;
  const c = taskView.cl && taskView.cl !== 'new' ? state.library.checklists?.[taskView.cl] : undefined;
  const changed = c
    ? clDraft.name !== c.name || clDraft.notes !== c.notes || clDraft.text !== itemsToText(c.items)
    : !!(clDraft.name.trim() || clDraft.notes.trim() || clDraft.text.trim());
  return !changed || confirm('Bỏ những gì đang sửa?');
}

function renderChecklists(page: HTMLElement, p: LibraryProjectDef) {
  const v = taskView!;
  if (v.run && (!state.library.checklistRuns?.[v.run] || state.library.checklistRuns[v.run].deleted)) v.run = null;
  if (v.cl && v.cl !== 'new' && (!state.library.checklists?.[v.cl] || state.library.checklists[v.cl].deleted)) {
    v.cl = null;
    v.editing = false;
  }
  if (v.editing) return renderChecklistEditor(page, p);
  if (v.run) return renderRun(page, p, v.run);
  if (v.cl) return renderChecklistDetail(page, p, v.cl);
  renderChecklistList(page, p);
}

async function postLibrary<T extends { library: Library }>(path: string, b: Record<string, unknown>): Promise<T | null> {
  const self = selfConn();
  try {
    if (!self) throw new Error('Không nối được agent của máy đang mở trang');
    const r = await api<T>(self, path, { body: b });
    state.library = r.library;
    renderSessions();
    if (taskView && !taskView.editing) renderTasks();
    return r;
  } catch (e) {
    const err = document.getElementById('clError');
    if (err) {
      err.textContent = (e as Error).message;
      err.hidden = false;
    } else alert((e as Error).message);
    return null;
  }
}

function newChecklist(from?: LibraryChecklist) {
  taskView = { ...taskView!, cl: 'new', run: null, editing: true };
  clDraft = from
    ? { name: `${from.name} (bản sao)`, notes: from.notes, text: itemsToText(from.items) }
    : { name: '', notes: '', text: '' };
  renderTasks();
}

// Thanh tiến độ của một lượt chạy: đạt / lỗi / bỏ qua / chưa kiểm.
function runBar(id: string, r: LibraryChecklistRun) {
  const s = runStats(id, r);
  const bar = el('div', 'cl-bar');
  bar.title = `${s.pass} đạt · ${s.fail} lỗi · ${s.skip} bỏ qua · ${s.todo} chưa kiểm`;
  for (const k of ['pass', 'fail', 'skip'] as const) {
    if (!s[k]) continue;
    const seg = el('span', `cl-seg ${k}`);
    seg.style.width = `${(100 * s[k]) / Math.max(1, s.total)}%`;
    bar.append(seg);
  }
  return bar;
}

function runSummary(id: string, r: LibraryChecklistRun) {
  const s = runStats(id, r);
  const parts = [`${s.pass}/${s.total} đạt`];
  if (s.fail) parts.push(`${s.fail} lỗi`);
  if (s.skip) parts.push(`${s.skip} bỏ qua`);
  return parts.join(' · ');
}

function runRow(id: string, r: LibraryChecklistRun, showName: boolean) {
  const row = button('', 'task-row cl-run-row', () => {
    taskView = { ...taskView!, run: id };
    renderTasks();
  });
  const s = runStats(id, r);
  const title = el('span', 'task-title', showName ? `${r.name}${r.version ? ` · ${r.version}` : ''}` : r.version ? `Phiên bản ${r.version}` : 'Chưa ghi phiên bản');
  row.append(
    el('span', 'task-date', new Date(r.createdAt).toLocaleDateString('vi-VN')),
    title,
    runBar(id, r),
    el('span', 'cl-run-sum' + (s.fail ? ' has-fail' : s.pass === s.total ? ' all-pass' : ''), runSummary(id, r)),
  );
  return row;
}

function renderChecklistList(page: HTMLElement, p: LibraryProjectDef) {
  const head = tasksHead(`Checklist · ${p.name}`, 'Bộ kiểm tra dùng lại được, vd verify trước khi release', [button('＋ Checklist mới', 'primary-btn', () => newChecklist())]);
  const body = el('div', 'tasks-body');
  body.append(pageTabs());
  const cls = liveChecklists(taskView!.project);
  const list = el('div', 'task-list');
  for (const [id, c] of cls) {
    const row = button('', 'task-row', () => {
      taskView = { ...taskView!, cl: id };
      renderTasks();
    });
    const last = liveRuns(taskView!.project, id)[0];
    row.append(el('span', 'task-ico', '✓'), el('span', 'task-title', c.name), el('span', 'task-date', `${c.items.filter((i) => !i.heading).length} mục`));
    if (last) row.append(el('span', 'task-date', `lần cuối ${last[1].version || new Date(last[1].createdAt).toLocaleDateString('vi-VN')}: ${runSummary(last[0], last[1])}`));
    list.append(row);
  }
  if (!cls.length) {
    list.append(el('p', 'task-empty', 'Chưa có checklist nào. Tạo một bộ, vd "Verify trước khi release", rồi mỗi phiên bản bấm Chạy và giao cho Claude quét project.'));
    // Dự án khác có checklist thì cho chép sang.
    const others = Object.entries(state.library.checklists ?? {}).filter(([, c]) => !c.deleted && c.project !== taskView!.project && !state.library.projectDefs[c.project]?.deleted);
    if (others.length) {
      const copy = button('Chép từ dự án khác…', 'ghost-btn', () =>
        showMenu(copy, others.map(([, c]) => ({ label: c.name, sub: state.library.projectDefs[c.project]?.name, run: () => newChecklist(c) })), 'Chép checklist'),
      );
      list.append(copy);
    }
  }
  body.append(list);
  const runs = liveRuns(taskView!.project).slice(0, 20);
  if (runs.length) {
    body.append(el('h3', 'cl-section', 'Lượt chạy gần đây'));
    const rl = el('div', 'task-list');
    for (const [id, r] of runs) rl.append(runRow(id, r, true));
    body.append(rl);
  }
  page.replaceChildren(head, body);
}

function renderChecklistDetail(page: HTMLElement, p: LibraryProjectDef, id: string) {
  const c = state.library.checklists[id];
  const edit = button('Sửa', 'ghost-btn', () => {
    taskView!.editing = true;
    clDraft = { name: c.name, notes: c.notes, text: itemsToText(c.items) };
    renderTasks();
  });
  const head = tasksHead(c.name, `Checklist · ${p.name}`, [edit]);
  const body = el('div', 'tasks-body task-detail');
  const run = button('▶ Chạy checklist', 'primary-btn', () => void startRun(id));
  const actions = el('div', 'task-actions');
  actions.append(
    run,
    button('Nhân bản', 'ghost-btn', () => newChecklist(c)),
    button('Xoá checklist', 'ghost-btn danger-btn', async () => {
      if (!confirm(`Xoá checklist "${c.name}"? Các lượt chạy cũ vẫn giữ.`)) return;
      if (await postLibrary('/api/library/checklist', { id, deleted: true })) {
        taskView!.cl = null;
        renderTasks();
      }
    }),
  );
  body.append(actions);
  if (c.notes.trim()) {
    body.append(el('h3', 'cl-section', 'Hướng dẫn cho Claude'));
    const n = el('div', 'msg-assistant task-text');
    n.innerHTML = md(c.notes);
    body.append(n);
  }
  body.append(el('h3', 'cl-section', `Các mục · ${c.items.filter((i) => !i.heading).length}`));
  const ul = el('div', 'cl-items');
  for (const i of c.items) ul.append(i.heading ? el('div', 'cl-heading', i.text) : el('div', 'cl-item plain', i.text));
  if (!c.items.length) ul.append(el('p', 'task-empty', 'Chưa có mục nào. Bấm Sửa để thêm.'));
  body.append(ul);
  const runs = liveRuns(taskView!.project, id);
  if (runs.length) {
    body.append(el('h3', 'cl-section', 'Các lượt chạy'));
    const rl = el('div', 'task-list');
    for (const [rid, r] of runs) rl.append(runRow(rid, r, false));
    body.append(rl);
  }
  const err = el('p', 'form-error');
  err.id = 'clError';
  err.hidden = true;
  body.append(err);
  page.replaceChildren(head, body);
}

async function startRun(checklist: string) {
  const versions = projectVersions(taskView!.project);
  const version = prompt('Chạy checklist cho phiên bản nào? (để trống nếu không gắn phiên bản)', versions[0] ?? '');
  if (version === null) return;
  const r = await postLibrary<{ id: string; library: Library }>('/api/library/checklist-run', { checklist, version: version.trim() });
  if (!r || !taskView) return;
  taskView.run = r.id;
  renderTasks();
}

function renderChecklistEditor(page: HTMLElement, p: LibraryProjectDef) {
  const isNew = taskView!.cl === 'new';
  const c = isNew ? undefined : state.library.checklists[taskView!.cl!];
  const d = clDraft!;
  const save = button('Lưu', 'primary-btn', () => void submitChecklist());
  const head = tasksHead(isNew ? 'Checklist mới' : `Sửa ${c!.name}`, p.name, [save]);
  const body = el('div', 'tasks-body task-form');
  const name = Object.assign(document.createElement('input'), { type: 'text', value: d.name, placeholder: 'Tên checklist, vd Verify trước khi release', className: 'task-input' });
  name.oninput = () => (d.name = name.value);
  const grow = (t: HTMLTextAreaElement) => {
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight + 2, innerHeight * 0.6)}px`;
  };
  const items = Object.assign(document.createElement('textarea'), {
    value: d.text,
    placeholder: '# Build\nBuild Android release không lỗi, không warning mới\nTăng versionCode / bundle version\n# Nội dung\nKhông còn log debug, cheat, nút test\nText mới đã có đủ bản dịch',
    className: 'task-input task-body cl-items-input',
    rows: 10,
  });
  items.oninput = () => {
    d.text = items.value;
    grow(items);
  };
  const notes = Object.assign(document.createElement('textarea'), {
    value: d.notes,
    placeholder: 'Hướng dẫn cho Claude khi verify (Markdown): lệnh build / test, thư mục cần xem, những gì không được đụng…',
    className: 'task-input task-body',
    rows: 4,
  });
  notes.oninput = () => {
    d.notes = notes.value;
    grow(notes);
  };
  const err = el('p', 'form-error');
  err.id = 'clError';
  err.hidden = true;
  body.append(
    name,
    el('label', 'task-hint', 'Các mục: mỗi dòng một mục. Dòng bắt đầu bằng # là tiêu đề nhóm.'),
    items,
    el('label', 'task-hint', 'Hướng dẫn thêm cho Claude (không bắt buộc)'),
    notes,
    err,
  );
  page.replaceChildren(head, body);
  requestAnimationFrame(() => {
    grow(items);
    grow(notes);
  });
  if (!isMobile()) (isNew ? name : items).focus();
}

async function submitChecklist() {
  if (!taskView || !clDraft) return;
  const d = clDraft;
  const err = document.getElementById('clError');
  if (!d.name.trim()) {
    if (err) {
      err.textContent = 'Checklist cần có tên';
      err.hidden = false;
    }
    return;
  }
  const isNew = taskView.cl === 'new';
  const prev = isNew ? [] : (state.library.checklists[taskView.cl!]?.items ?? []);
  const r = await postLibrary<{ id: string; library: Library }>('/api/library/checklist', {
    id: isNew ? undefined : taskView.cl,
    project: taskView.project,
    name: d.name.trim(),
    notes: d.notes,
    items: textToItems(d.text, prev),
  });
  if (!r || !taskView) return;
  taskView.cl = r.id;
  taskView.editing = false;
  clDraft = null;
  renderTasks();
}

async function setResult(run: string, item: string, result: CheckResult, note?: string) {
  await postLibrary('/api/library/check-result', { run, item, result, note });
}

function renderRun(page: HTMLElement, p: LibraryProjectDef, id: string) {
  const r = state.library.checklistRuns[id];
  const s = runStats(id, r);
  const head = tasksHead(`${r.name}${r.version ? ` · ${r.version}` : ''}`, `Lượt chạy ${new Date(r.createdAt).toLocaleString('vi-VN')} · ${p.name}`, []);
  const body = el('div', 'tasks-body task-detail');

  const sum = el('div', 'cl-summary');
  sum.append(runBar(id, r));
  const counts = el('div', 'cl-counts');
  for (const k of ['pass', 'fail', 'skip', 'todo'] as const) counts.append(el('span', `cl-count ${k}`, `${RESULT_LABEL[k]} ${s[k]}`));
  sum.append(counts);
  body.append(sum);

  const actions = el('div', 'task-actions');
  const verify = button(s.todo === s.total ? 'Cho Claude verify' : 'Cho Claude verify tiếp', 'primary-btn', () => void verifyRun(id, verify));
  actions.append(verify);
  // Session đã báo kết quả gần nhất: mở lại để xem Claude đã làm gì.
  const last = r.items
    .map((i) => checkResult(id, i.id))
    .filter((x): x is NonNullable<typeof x> => !!x?.session)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (last?.session) {
    const [m, sid] = [last.session.slice(0, last.session.indexOf(':')), last.session.slice(last.session.indexOf(':') + 1)];
    const conn = connByName(m);
    if (conn) actions.append(button('Mở session đã verify', 'ghost-btn', () => void openSession(conn, sid)));
  }
  actions.append(
    button('Đổi phiên bản', 'ghost-btn', async () => {
      const v = prompt('Phiên bản của lượt chạy này', r.version ?? '');
      if (v !== null) await postLibrary('/api/library/checklist-run', { id, version: v.trim() });
    }),
    button('Xoá lượt chạy', 'ghost-btn danger-btn', async () => {
      if (!confirm('Xoá lượt chạy này?')) return;
      if (await postLibrary('/api/library/checklist-run', { id, deleted: true })) checklistBack();
    }),
  );
  body.append(actions);

  const list = el('div', 'cl-items');
  for (const i of r.items) {
    if (i.heading) {
      list.append(el('div', 'cl-heading', i.text));
      continue;
    }
    const res = checkResult(id, i.id);
    const cur: CheckResult = res?.result ?? 'todo';
    const row = el('div', `cl-item ${cur}`);
    const btns = el('div', 'cl-btns');
    for (const k of ['pass', 'fail', 'skip'] as const) {
      const b = button(RESULT_ICON[k], `cl-btn ${k}${cur === k ? ' on' : ''}`, () => void setResult(id, i.id, cur === k ? 'todo' : k, cur === k ? undefined : res?.note));
      b.title = cur === k ? 'Bỏ đánh dấu' : RESULT_LABEL[k];
      b.setAttribute('aria-label', `${RESULT_LABEL[k]}: ${i.text}`);
      b.setAttribute('aria-pressed', String(cur === k));
      btns.append(b);
    }
    const main = el('div', 'cl-main');
    main.append(el('div', 'cl-text', i.text));
    if (res && res.result !== 'todo') {
      const meta = el('div', 'cl-note');
      if (res.note) meta.append(el('span', '', res.note));
      meta.append(el('span', 'cl-by', ` — ${res.by === 'claude' ? 'Claude' : 'bạn'}, ${new Date(res.updatedAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}`));
      main.append(meta);
    }
    const note = button('✎', 'icon-btn cl-note-btn', async () => {
      const n = prompt(`Ghi chú cho mục:\n${i.text}`, res?.note ?? '');
      if (n !== null) await setResult(id, i.id, cur, n);
    });
    note.title = 'Ghi chú';
    note.setAttribute('aria-label', 'Ghi chú');
    row.append(btns, main, note);
    list.append(row);
  }
  body.append(list);
  const err = el('p', 'form-error');
  err.id = 'clError';
  err.hidden = true;
  body.append(err);
  page.replaceChildren(head, body);
}

// Prompt cho Claude: các mục kèm id và kết quả đã có, cách báo kết quả qua tool checklist_report.
function verifyPrompt(id: string, r: LibraryChecklistRun, p: LibraryProjectDef) {
  const lines = [
    `Verify checklist "${r.name}" cho dự án ${p.name}${r.version ? `, phiên bản ${r.version}` : ''} (lượt chạy ${id}).`,
    '',
    'Quét project trong thư mục này và kiểm lần lượt từng mục chưa đạt bên dưới. Đọc code, chạy build / test / lệnh kiểm khi cần. ' +
      'Chỉ kiểm, không sửa code khi tôi chưa bảo.',
    `Kiểm xong mục nào thì gọi ngay tool checklist_report (run: ${id}) cho mục đó: pass nếu đạt, fail nếu lỗi, skip nếu không tự kiểm được ` +
      '(cần người kiểm, vd chơi thử trên máy thật). Luôn kèm note ngắn: bằng chứng (lệnh đã chạy, tệp:dòng, số liệu) hoặc lý do.',
    'Xong hết thì tóm tắt: các mục lỗi kèm cách sửa đề xuất, các mục cần người kiểm.',
  ];
  if (r.notes.trim()) lines.push('', 'Hướng dẫn:', r.notes.trim());
  lines.push('', 'Các mục (id trong ngoặc vuông):');
  for (const i of r.items) {
    if (i.heading) {
      lines.push(`## ${i.text}`);
      continue;
    }
    const res = checkResult(id, i.id);
    const done = res && res.result !== 'todo' ? ` (lần trước: ${RESULT_LABEL[res.result].toLowerCase()}${res.note ? ` — ${res.note}` : ''})` : '';
    lines.push(`- [${i.id}] ${i.text}${done}`);
  }
  return lines.join('\n');
}

function verifyRun(id: string, anchor: HTMLElement) {
  const r = state.library.checklistRuns[id];
  const p = state.library.projectDefs[r.project];
  pickProjectRoot(r.project, anchor, 'Verify bằng Claude', (root) => {
    newSessionIn(connByName(root.machine)!, root.path);
    const input = $<HTMLTextAreaElement>('input');
    input.value = verifyPrompt(id, r, p);
    autosize();
  });
}

// ---------- Khởi động ----------

// Chọn giao diện (nhớ trên thiết bị này): kiểu Claude / Retro / Aero, sáng / tối. Chỉ có giao diện; việc hệ thống ở openSystemMenu.
function openThemeMenu(anchor: HTMLElement) {
  const p = themePref();
  showMenu(anchor, [
    'Kiểu giao diện',
    { label: 'Claude', on: p.style === 'claude', run: () => setThemePref({ style: 'claude' }) },
    { label: 'Retro (Windows 95)', on: p.style === 'retro', run: () => setThemePref({ style: 'retro' }) },
    { label: 'Frutiger Aero (Vista / 7)', on: p.style === 'aero', run: () => setThemePref({ style: 'aero' }) },
    'Sáng / tối',
    { label: 'Theo máy', on: p.scheme === 'auto', run: () => setThemePref({ scheme: 'auto' }) },
    { label: 'Sáng', on: p.scheme === 'light', run: () => setThemePref({ scheme: 'light' }) },
    { label: 'Tối', on: p.scheme === 'dark', run: () => setThemePref({ scheme: 'dark' }) },
  ], 'Giao diện');
}

// Hệ thống: trình duyệt mở link, thông báo đẩy, khởi động lại agent (chỉ trên máy tính).
function openSystemMenu(anchor: HTMLElement) {
  showMenu(anchor, [
    ...(needsBrowserApp() ? ['Mở link bằng trình duyệt', ...browserItems()] : []),
    'Thông báo trên thiết bị này',
    {
      label: 'Báo khi xong việc / cần duyệt',
      sub: push.on ? 'đang bật, cả khi đã đóng app' : push.needsInstall ? 'cần mở từ màn hình chính' : push.supported ? 'đang tắt' : 'trình duyệt không hỗ trợ',
      on: push.on,
      run: () => void togglePush(),
    },
    ...(push.on ? [{ label: 'Gửi thông báo thử', run: () => void testPush().catch((err) => showToast('Không gửi được', (err as Error).message, () => {})) }] : []),
    'Dọn dẹp',
    { label: 'Xoá session cũ…', sub: 'không hoạt động quá X ngày, trên mọi máy đang nối', run: () => void cleanOld() },
    { label: 'Chọn nhiều session', sub: 'xoá hoặc chuyển thư mục cùng lúc', run: () => setSelecting(true) },
    // Chỉ trên máy tính: khởi động lại agent từng máy (kéo code mới trước), thay cho việc mở Task Scheduler.
    ...(isMobile() ? [] : ['Agent', ...state.conns.filter((c) => c.base !== null).map((c) => ({
      label: `Khởi động lại agent ${c.machine.name}`,
      sub: c.ok ? 'kéo code mới rồi chạy lại' : 'đang mất kết nối',
      run: () => void restartAgent(c),
    }))]),
  ], 'Hệ thống');
}

// Agent kéo code mới, đóng các session đang mở rồi thoát; vòng lặp run-agent.ps1 bật lại sau ~5 giây, WebSocket tự nối lại.
async function restartAgent(conn: Conn) {
  const open = conn.sessions.filter((s) => s.live).length;
  const note = open ? `\n\n${open} session đang mở trên máy này sẽ bị đóng (lịch sử còn nguyên, gửi tin là chạy tiếp).` : '';
  if (!confirm(`Khởi động lại agent ${conn.machine.name}?${note}`)) return;
  try {
    const r = await api<{ before: string; after: string; pulled: boolean; pullError?: string }>(conn, '/api/agent/restart', { body: {} });
    const code = r.before === r.after ? `vẫn ở ${r.after}` : `${r.before} → ${r.after}`;
    showToast(`Đang khởi động lại ${conn.machine.name}`, r.pulled ? `Code ${code}. Trang tự nối lại sau vài giây.` : `Không kéo được code mới (${r.pullError ?? 'lỗi git'}), chạy lại bản ${r.after}.`, () => {});
    // Máy đang mở trang này: tải lại trang khi agent lên lại để nhận giao diện mới.
    if (conn.base === '') waitAndReload();
  } catch (err) {
    showToast(`Không khởi động lại được ${conn.machine.name}`, (err as Error).message, () => {});
  }
}

function waitAndReload() {
  const started = Date.now();
  const tick = async () => {
    const info = await fetch('/api/info', { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null);
    if (info && info.startedAt > started) return location.reload();
    if (Date.now() - started < 60_000) setTimeout(tick, 2000);
  };
  setTimeout(tick, 4000);
}

async function togglePush() {
  try {
    if (push.on) {
      await disablePush();
      showToast('Đã tắt thông báo', 'Thiết bị này không nhận thông báo đẩy nữa', () => {});
    } else {
      await enablePush();
      showToast('Đã bật thông báo', 'Báo khi session xong lượt hoặc cần duyệt, kể cả khi đóng app', () => {});
    }
  } catch (err) {
    showToast('Chưa bật được thông báo', (err as Error).message, () => {});
  }
}

async function init() {
  setupTheme();
  const res = await fetch('/api/info');
  const info: { self: MachineInfo; machines: MachineInfo[]; modes: string[] } = await res.json();
  state.self = info.self;
  state.modes = info.modes;
  // Máy đang phục vụ trang lên đầu; các máy khác gọi qua địa chỉ tailnet.
  const ordered = [info.self, ...info.machines.filter((m) => m.computer !== info.self.computer)];
  state.conns = ordered.map((m) => ({
    machine: m,
    base: m.computer === info.self.computer ? '' : (m.url ?? null),
    ok: false,
    sessions: [],
    retry: 0,
  }));
  $('machine').textContent = `ở ${info.self.name}`;
  $('machine').title = `Đang mở SessionMon từ máy ${info.self.name}`;
  fillModes($('mode'));
  setupTables($('messages'));
  setupCopy(document.body, (msg) => showToast('Không chép được', msg, () => {}));
  setupTurnHover($('messages'));
  $('themeBtn').onclick = () => openThemeMenu($('themeBtn'));
  $('sysBtn').onclick = () => openSystemMenu($('sysBtn'));

  $('newBtn').onclick = openNewDraft;
  $('usageCard').onclick = openUsagePanel;
  setInterval(renderUsage, 30_000);
  $('newFolderBtn').onclick = () => void newFolder();
  $('selectBtn').onclick = () => setSelecting(!selecting);
  $('selDone').onclick = () => setSelecting(false);
  $('selDelete').onclick = () => void deleteSelected();
  $('selMore').onclick = () => openSelectMenu($('selMore'));
  $('selOld').onclick = () => void cleanOld();
  setupViewSwitch();
  setupSwipe();
  setupViewport();
  $('activityPill').onclick = () => {
    onlyActive = !onlyActive;
    renderSessions();
  };
  document.addEventListener('pointerdown', (e) => {
    if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (selecting && !menuEl && !document.querySelector('dialog[open], #lightbox')) setSelecting(false);
    closeMenu();
  });
  $('chat').addEventListener('scroll', closeMenu);
  $('sessionList').addEventListener('scroll', closeMenu);
  $('newMachine').addEventListener('change', () => {
    const conn = connByName($<HTMLSelectElement>('newMachine').value);
    if (conn && isDraft()) enterDraft(conn);
  });
  $('newCwdBtn').onclick = openCwdPicker;
  $('addPathBtn').onclick = () => toggleAddPath();
  $('addPathSave').onclick = () => void saveNewPath();
  $('addPathInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void saveNewPath();
    }
  });
  $('backBtn').onclick = goBack;
  setupSideToggle();
  $('topMoreBtn').onclick = () => openTopMenu($('topMoreBtn'));
  $('input').addEventListener('focus', () => {
    // Bàn phím điện thoại bật lên làm khung chat thấp lại: giữ tin cuối trong tầm nhìn.
    if (isMobile()) setTimeout(() => ($('chat').scrollTop = $('chat').scrollHeight), 300);
  });
  $<HTMLInputElement>('search').oninput = (e) => {
    state.filter = (e.target as HTMLInputElement).value;
    renderSessions();
  };
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    void send();
  });
  const input = $<HTMLTextAreaElement>('input');
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    // Trên điện thoại Enter là xuống dòng; gửi bằng nút.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      void send();
    }
  });
  const cur = () => state.current;
  $('stopBtn').onclick = () => cur() && api(cur()!.conn, `/api/sessions/${cur()!.id}/interrupt`, { body: {} });
  setupComposerExtras();
  setupSlash();
  setupLinks();
  $('closeBtn').onclick = () => cur() && api(cur()!.conn, `/api/sessions/${cur()!.id}/close`, { body: {} });
  // Ô chọn chế độ trên thanh trên (máy tính): đổi ngay nếu session đang chạy, không thì áp dụng khi gửi tin.
  $<HTMLSelectElement>('mode').onchange = (e) => {
    const c = cur();
    if (!c) return;
    const mode = (e.target as HTMLSelectElement).value;
    const key = sessionKey();
    choices.set(key, { ...(choices.get(key) ?? {}), mode });
    renderComposerMeta();
    if (current()?.live) void api(c.conn, `/api/sessions/${c.id}/mode`, { body: { mode } });
  };

  if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});
  void setupPush((url) => {
    const hash = new URL(url, location.href).hash;
    if (hash && hash !== location.hash) location.hash = hash;
    else openFromHash();
  });
  // Đồng hồ thời gian chạy của các session đang làm.
  setInterval(tickSince, 1000);

  for (const c of state.conns) connect(c);
  renderSessions();
  renderConn();
  setInterval(renderSessions, 60_000);
  // Đợi danh sách của các máy về rồi mới mở session ghi trong link.
  setTimeout(startup, 600);
  window.addEventListener('hashchange', openFromHash);
  window.addEventListener('popstate', openFromHash);
}

void init();


// ---------- Model, effort, context ----------

let meta: SessionMeta = {};
// Lựa chọn model / effort người dùng đặt cho từng session (gửi kèm tin kế tiếp nếu session chưa chạy).
const choices = new Map<string, { model?: string; effort?: Effort; mode?: string }>();
const modelsByMachine = new Map<string, ModelOption[]>();
const EFFORT_LABELS: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

const sessionKey = () => (state.current ? `${state.current.conn.machine.name}:${state.current.id}` : '');

const defaultEffortByMachine = new Map<string, Effort | undefined>();

async function modelsFor(conn: Conn): Promise<ModelOption[]> {
  const hit = modelsByMachine.get(conn.machine.name);
  if (hit) return hit;
  try {
    const r = await api<{ models: ModelOption[]; defaultEffort?: Effort }>(conn, '/api/models');
    modelsByMachine.set(conn.machine.name, r.models);
    defaultEffortByMachine.set(conn.machine.name, r.defaultEffort);
    return r.models;
  } catch {
    return [];
  }
}

// Tên hiện cho một model: lựa chọn "Default" ghi kèm model thật trong ngoặc, lấy từ mô tả
// ("Opus 5.5 with 1M context - Best for…" → "Default (Opus 5.5 with 1M context)").
function modelLabel(m: ModelOption): string {
  if (m.value !== 'default') return m.displayName;
  const inName = /\(([^)]*\d[^)]*)\)\s*$/.exec(m.displayName)?.[1];
  const fromDesc = m.description.split(/\s+[-·—]\s+/)[0].trim();
  return `Default (${inName || fromDesc || 'theo Claude Code'})`;
}

// Effort mặc định của một máy, ghi trong ngoặc.
const defaultEffortLabel = (conn?: Conn) => {
  const e = conn ? defaultEffortByMachine.get(conn.machine.name) : undefined;
  return `Default (${e ? EFFORT_LABELS[e] : 'theo model'})`;
};

// claude-opus-5-5 → "Opus 5.5"; opus[1m] → "Opus 1M".
function prettyModel(id?: string): string {
  if (!id) return 'Model';
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] && m[3].length < 3 ? '.' + m[3] : ''}`;
  const base = id.replace(/\[1m\]$/i, '');
  return base[0].toUpperCase() + base.slice(1) + (/\[1m\]$/i.test(id) ? ' 1M' : '');
}

// Lựa chọn trong danh sách ứng với model hiện tại của session.
function currentOption(models: ModelOption[]): ModelOption | undefined {
  const choice = choices.get(sessionKey());
  if (choice?.model) return models.find((m) => m.value === choice.model);
  const fam = /claude-([a-z]+)/.exec(meta.model ?? '')?.[1];
  return fam ? models.find((m) => m.value.includes(fam) || m.displayName.toLowerCase().includes(fam)) : undefined;
}

function renderComposerMeta() {
  const conn = state.current?.conn;
  const choice = choices.get(sessionKey()) ?? {};
  const models = conn ? (modelsByMachine.get(conn.machine.name) ?? []) : [];
  const chosen = choice.model ? models.find((m) => m.value === choice.model) : undefined;
  const name = chosen ? (chosen.value === 'default' ? modelLabel(chosen) : chosen.displayName) : prettyModel(meta.model);
  const effort = choice.effort ?? meta.effort ?? (conn ? defaultEffortByMachine.get(conn.machine.name) : undefined);
  const mode = choice.mode ?? meta.mode ?? 'default';
  // Chế độ quyền hiện trong nút khi khác "Ask permissions" (mặc định của Claude Code).
  const modeShort: Record<string, string> = { acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan', bypassPermissions: 'Bypass' };
  $('modelLabel').textContent = [name, effort && EFFORT_LABELS[effort], modeShort[mode]].filter(Boolean).join(' · ');
  $<HTMLSelectElement>('mode').value = mode;

  const ctx = meta.context;
  const btn = $('ctxBtn');
  btn.hidden = !ctx;
  if (ctx) {
    const C = 2 * Math.PI * 15;
    const fill = document.getElementById('ctxFill')!;
    fill.setAttribute('stroke-dasharray', `${C}`);
    fill.setAttribute('stroke-dashoffset', `${C * (1 - Math.min(100, ctx.percent) / 100)}`);
    btn.dataset.level = ctx.percent >= 85 ? 'high' : ctx.percent >= 60 ? 'mid' : 'low';
    btn.title = `Context ${ctx.percent}%${ctx.estimated ? ' (ước tính)' : ''}`;
  }
}

// Danh sách gọn: mỗi dòng model (Opus, Fable, Sonnet, Haiku) chỉ giữ bản mới nhất — Claude Code liệt kê bản mới
// trước. Bỏ "Default" khi nó trùng một model đã có. Model đang chọn luôn được giữ để thấy dấu ✓.
let allModels = false;
function shortModels(models: ModelOption[], keep?: ModelOption): ModelOption[] {
  const family = (m: ModelOption) => m.displayName.split(/\s+/)[0].toLowerCase();
  const seen = new Set<string>();
  const out = models.filter((m) => {
    if (m.value === 'default') return false;
    if (seen.has(family(m))) return m === keep;
    seen.add(family(m));
    return true;
  });
  const def = models.find((m) => m.value === 'default');
  if (def && (def === keep || !out.some((m) => modelLabel(def).includes(m.displayName)))) out.unshift(def);
  return out;
}

async function openModelMenu() {
  const cur = state.current;
  if (!cur) return;
  const models = await modelsFor(cur.conn);
  const key = sessionKey();
  const choice = choices.get(key) ?? {};
  const opt = currentOption(models);
  const apply = async (patch: { model?: string; effort?: Effort; mode?: string }) => {
    choices.set(key, { ...choice, ...patch });
    renderComposerMeta();
    // Session đang chạy: đổi ngay. Chưa chạy: gửi kèm tin kế tiếp.
    if (current()?.live) {
      try {
        if (patch.mode) await api(cur.conn, `/api/sessions/${cur.id}/mode`, { body: { mode: patch.mode } });
        else await api(cur.conn, `/api/sessions/${cur.id}/settings`, { body: patch });
      } catch (err) {
        alert((err as Error).message);
      }
    }
  };
  const curMode = choice.mode ?? meta.mode ?? 'default';
  const items: MenuItem[] = ['Chế độ quyền'];
  for (const m of state.modes) items.push({ label: MODE_LABELS[m] ?? m, on: m === curMode, run: () => apply({ mode: m }) });
  items.push('Model');
  if (!models.length) items.push({ label: 'Đang lấy danh sách model…', run: () => {} });
  const shown = allModels ? models : shortModels(models, opt);
  for (const m of shown)
    items.push({ label: modelLabel(m), sub: m.description || undefined, on: m === opt, run: () => apply({ model: m.value }) });
  if (shown.length < models.length)
    items.push({
      label: `Model khác (${models.length - shown.length})…`,
      run: () => {
        allModels = true;
        void openModelMenu();
      },
    });
  allModels = false;
  const efforts = opt?.efforts ?? [];
  if (efforts.length) {
    items.push('Effort');
    const curEffort = choice.effort ?? meta.effort;
    for (const e of efforts) items.push({ label: EFFORT_LABELS[e], on: e === curEffort, run: () => apply({ effort: e }) });
  }
  showMenu($('modelBtn'), items, 'Model và effort');
}

// Bảng nổi (máy tính) / tấm trồi từ đáy (điện thoại) với nội dung tuỳ ý.
function showPanel(anchor: HTMLElement, heading: string, content: HTMLElement) {
  closeMenu();
  const sheet = isMobile();
  const m = document.createElement('div');
  m.className = 'menu panel' + (sheet ? ' sheet' : '');
  m.append(Object.assign(document.createElement('div'), { className: 'menu-title', textContent: heading }), content);
  if (sheet) {
    const backdrop = Object.assign(document.createElement('div'), { className: 'menu-backdrop' });
    backdrop.onclick = closeMenu;
    document.body.append(backdrop);
    m.append(button('Đóng', 'menu-item menu-cancel', closeMenu));
  }
  document.body.append(m);
  if (!sheet) {
    const r = anchor.getBoundingClientRect();
    m.style.left = `${Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${Math.max(8, r.top - m.offsetHeight - 8)}px`;
  }
  menuEl = m;
}

const fmt = (n: number) => n.toLocaleString('vi-VN');

async function openContextPanel() {
  const cur = state.current;
  if (!cur) return;
  const box = document.createElement('div');
  box.className = 'ctx-panel';
  box.textContent = 'Đang tải…';
  showPanel($('ctxBtn'), 'Context', box);
  let ctx: ContextInfo | undefined;
  try {
    ctx = (await api<{ context?: ContextInfo }>(cur.conn, `/api/sessions/${cur.id}/context`)).context;
  } catch (err) {
    box.textContent = (err as Error).message;
    return;
  }
  box.replaceChildren();
  if (!ctx) {
    box.textContent = 'Chưa có số liệu context cho session này.';
    return;
  }
  const head = document.createElement('div');
  head.className = 'ctx-total';
  head.textContent = `${fmt(ctx.used)} / ${fmt(ctx.max)} token · ${ctx.percent}%`;
  const bar = document.createElement('div');
  bar.className = 'ctx-bar';
  bar.append(Object.assign(document.createElement('span'), { style: `width:${Math.min(100, ctx.percent)}%` }));
  box.append(head, bar);
  if (ctx.estimated)
    box.append(
      Object.assign(document.createElement('p'), {
        className: 'ctx-note',
        textContent: 'Ước tính từ lượt trả lời cuối. Khi session đang chạy sẽ có chi tiết từng phần như lệnh /context.',
      }),
    );
  for (const c of (ctx.categories ?? []).filter((c) => c.kind !== 'deferred' && c.tokens > 0)) {
    const row = document.createElement('div');
    row.className = 'ctx-row ' + c.kind;
    const pct = Math.round((c.tokens / ctx.max) * 1000) / 10;
    row.append(
      Object.assign(document.createElement('span'), { className: 'ctx-name', textContent: c.name }),
      Object.assign(document.createElement('span'), { className: 'ctx-num', textContent: `${fmt(c.tokens)} · ${pct}%` }),
      Object.assign(document.createElement('span'), { className: 'ctx-mini', style: `--w:${Math.min(100, pct)}%` }),
    );
    box.append(row);
  }
}

// ---------- Đính kèm tệp, ảnh ----------

interface PendingFile {
  id: string;
  name: string;
  type: string;
  data: string;
  preview?: string;
}
let pendingFiles: PendingFile[] = [];
const API_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_EDGE = 1568;

function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

// Ảnh lớn (hoặc định dạng API không nhận, vd HEIC) được thu nhỏ / đổi sang JPEG ngay trên máy gửi.
async function prepareImage(f: File): Promise<{ blob: Blob; type: string } | null> {
  const okType = API_IMAGE_TYPES.includes(f.type);
  if (f.type === 'image/gif' && f.size < 4.5 * 1024 * 1024) return { blob: f, type: f.type };
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(f);
  } catch {
    return okType && f.size < 4.5 * 1024 * 1024 ? { blob: f, type: f.type } : null;
  }
  const edge = Math.max(bmp.width, bmp.height);
  if (okType && edge <= 2000 && f.size < 3.5 * 1024 * 1024) return { blob: f, type: f.type };
  const scale = Math.min(1, MAX_IMAGE_EDGE / edge);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const type = f.type === 'image/png' ? 'image/png' : 'image/jpeg';
  let blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.88));
  if (blob && blob.size > 4.5 * 1024 * 1024) blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
  return blob ? { blob, type: blob.type || 'image/jpeg' } : null;
}

async function addFiles(list: Iterable<File>) {
  for (const f of list) {
    try {
      if (f.type.startsWith('image/')) {
        const img = await prepareImage(f);
        if (img) {
          pendingFiles.push({ id: crypto.randomUUID(), name: f.name || 'anh.png', type: img.type, data: await blobToBase64(img.blob), preview: URL.createObjectURL(img.blob) });
          continue;
        }
      }
      if (f.size > 30 * 1024 * 1024) throw new Error(`${f.name} lớn quá 30 MB`);
      pendingFiles.push({ id: crypto.randomUUID(), name: f.name || 'tep', type: f.type || 'application/octet-stream', data: await blobToBase64(f) });
    } catch (err) {
      alert((err as Error).message);
    }
  }
  renderTray();
}

function clearPendingFiles() {
  for (const f of pendingFiles) if (f.preview) URL.revokeObjectURL(f.preview);
  pendingFiles = [];
  renderTray();
}

function renderTray() {
  const tray = $('attachTray');
  tray.hidden = !pendingFiles.length;
  tray.replaceChildren(
    ...pendingFiles.map((f) => {
      const chip = document.createElement('div');
      chip.className = 'tray-item' + (f.preview ? ' is-image' : '');
      chip.title = f.name;
      if (f.preview) chip.append(Object.assign(document.createElement('img'), { src: f.preview, alt: f.name }));
      else chip.append(Object.assign(document.createElement('span'), { className: 'tray-name', textContent: `📄 ${f.name}` }));
      const x = button('×', 'tray-remove', () => {
        if (f.preview) URL.revokeObjectURL(f.preview);
        pendingFiles = pendingFiles.filter((p) => p !== f);
        renderTray();
      });
      x.setAttribute('aria-label', `Bỏ ${f.name}`);
      chip.append(x);
      return chip;
    }),
  );
}

// ---------- Nhập bằng giọng nói (Web Speech API, tiếng Việt) ----------
// Giống Claude: chữ hiện ngay trong ô nhập khi đang nói; thanh ghi âm có nút Huỷ, Dừng và Gửi.
// Máy nhận dạng tự ngắt khi im lặng (nhất là iPhone) nên tự bật lại cho đến khi người dùng bấm dừng.

interface VoiceRun {
  rec: any;
  base: string; // chữ có sẵn trong ô trước khi nói
  committed: string; // chữ đã chốt của các lượt nhận dạng trước (khi tự bật lại)
  current: string; // chữ của lượt đang chạy (cả phần tạm)
  wanted: boolean; // còn muốn nghe (chưa bấm dừng)
  startedAt: number;
  timer: number;
  restarts: number;
}

let voice: VoiceRun | null = null;

const SpeechRec = (): any => (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

function joinSpeech(a: string, b: string) {
  if (!a) return b.trimStart();
  if (!b) return a;
  return /\s$/.test(a) || /^\s/.test(b) ? a + b : a + ' ' + b;
}

// Ghép toàn bộ kết quả của lượt hiện tại, dựng lại từ đầu mỗi lần (iOS và Android có lúc gửi lặp hoặc gửi dồn).
function transcriptOf(results: any): string {
  let out = '';
  for (let i = 0; i < results.length; i++) {
    const t: string = results[i][0]?.transcript ?? '';
    if (!t) continue;
    const prev = out.trim();
    const cur = t.trim();
    // Android Chrome (continuous) đôi khi trả kết quả sau chứa luôn kết quả trước.
    if (prev && cur.toLowerCase().startsWith(prev.toLowerCase())) out = t;
    else out = joinSpeech(out, t);
  }
  return out;
}

function renderVoiceText() {
  if (!voice) return;
  const input = $<HTMLTextAreaElement>('input');
  input.value = joinSpeech(voice.base, joinSpeech(voice.committed, voice.current));
  autosize();
  input.scrollTop = input.scrollHeight;
  $('voiceText').textContent = voice.current || voice.committed ? 'Đang nghe…' : 'Hãy nói…';
}

function voiceClock() {
  if (!voice) return;
  const s = Math.floor((Date.now() - voice.startedAt) / 1000);
  $('voiceTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function startRecognizer(run: VoiceRun) {
  const rec = new (SpeechRec())();
  rec.lang = 'vi-VN';
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.onresult = (e: any) => {
    if (voice !== run) return;
    run.current = transcriptOf(e.results);
    renderVoiceText();
  };
  rec.onerror = (e: any) => {
    if (voice !== run) return;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      run.wanted = false;
      alert('Trình duyệt chưa cho dùng micro. Hãy cấp quyền micro cho trang này.');
    } else if (e.error === 'network' || e.error === 'audio-capture') {
      run.wanted = false;
      alert(e.error === 'network' ? 'Nhận dạng giọng nói cần mạng.' : 'Không mở được micro.');
    }
  };
  rec.onend = () => {
    if (voice !== run) return;
    run.committed = joinSpeech(run.committed, run.current);
    run.current = '';
    // Tự ngắt khi im lặng: bật lại nếu người dùng chưa bấm dừng (giới hạn để tránh vòng lặp lỗi).
    if (run.wanted && run.restarts < 50) {
      run.restarts++;
      try {
        startRecognizer(run);
        return;
      } catch {
        /* rơi xuống kết thúc */
      }
    }
    endVoice(false);
  };
  run.rec = rec;
  rec.start();
}

function startVoice() {
  if (voice || !SpeechRec()) return;
  const input = $<HTMLTextAreaElement>('input');
  const run: VoiceRun = { rec: null, base: input.value.replace(/\s+$/, ''), committed: '', current: '', wanted: true, startedAt: Date.now(), timer: 0, restarts: 0 };
  voice = run;
  try {
    startRecognizer(run);
  } catch {
    voice = null;
    return;
  }
  run.timer = window.setInterval(voiceClock, 500);
  voiceClock();
  $('composerBox').classList.add('recording');
  $('voiceBar').hidden = false;
  renderVoiceText();
}

// Kết thúc ghi âm: giữ chữ đã nói trong ô; cancel=true: trả ô về như trước khi nói.
function endVoice(cancel: boolean) {
  const run = voice;
  if (!run) return;
  voice = null;
  run.wanted = false;
  clearInterval(run.timer);
  try {
    run.rec?.abort();
  } catch {
    /* đã dừng */
  }
  const input = $<HTMLTextAreaElement>('input');
  input.value = cancel ? run.base : joinSpeech(run.base, joinSpeech(run.committed, run.current));
  autosize();
  $('composerBox').classList.remove('recording');
  $('voiceBar').hidden = true;
}

// Bấm Dừng: chờ máy nhận dạng chốt nốt câu cuối (tối đa ~1,5 giây) rồi mới kết thúc.
function finishVoice() {
  const run = voice;
  if (!run) return;
  run.wanted = false;
  $('voiceText').textContent = 'Đang chốt chữ…';
  try {
    run.rec.stop();
  } catch {
    endVoice(false);
    return;
  }
  setTimeout(() => voice === run && endVoice(false), 1500);
}

function stopVoice() {
  endVoice(false);
}

function toggleVoice() {
  if (voice) finishVoice();
  else startVoice();
}

function setupComposerExtras() {
  const fileInput = $<HTMLInputElement>('fileInput');
  $('attachBtn').onclick = () => fileInput.click();
  fileInput.onchange = () => {
    if (fileInput.files) void addFiles([...fileInput.files]);
    fileInput.value = '';
  };
  // Dán ảnh (chụp màn hình) thẳng vào ô nhập.
  $('input').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  });
  // Kéo thả tệp vào khung chat (máy tính).
  for (const id of ['chat', 'composerBox']) {
    const el = $(id);
    el.addEventListener('dragover', (e) => {
      if (!state.current || !e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      $('composerBox').classList.add('drop');
    });
    el.addEventListener('dragleave', () => $('composerBox').classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      $('composerBox').classList.remove('drop');
      if (!state.current || !e.dataTransfer?.files.length) return;
      e.preventDefault();
      void addFiles([...e.dataTransfer.files]);
    });
  }
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  $('micBtn').hidden = !SR;
  $('micBtn').onclick = toggleVoice;
  $('voiceCancel').onclick = () => endVoice(true);
  $('voiceStop').onclick = finishVoice;
  $('voiceSend').onclick = () => {
    endVoice(false);
    void send();
  };
  $('modelBtn').onclick = () => void openModelMenu();
  $('ctxBtn').onclick = () => void openContextPanel();
}

// ---------- Link ngoài: mở ở trình duyệt, không mở đè trong app ----------
// App desktop là cửa sổ Chrome/Edge --app ở 127.0.0.1: nhờ agent của máy này mở bằng trình duyệt mặc định.
// Nơi khác (PWA điện thoại, tab trình duyệt): mở tab mới.
const isDesktopApp = () => location.hostname === '127.0.0.1' || location.hostname === 'localhost';

function setupLinks() {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || a.hasAttribute('download')) return;
    let url: URL;
    try {
      url = new URL(a.href, location.href);
    } catch {
      return;
    }
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return;
    if (url.origin === location.origin && url.protocol !== 'mailto:') return;
    e.preventDefault();
    openExternal(url.href);
  });
}

// PWA cài lên màn hình chính (chế độ standalone): link cùng địa chỉ với app (vd /api/file/... của báo cáo HTML)
// bị mở ngay trong app, không có thanh trình duyệt nên không quay về được. Phải đẩy sang app trình duyệt bằng
// scheme riêng của nó. iOS không cho web app biết trình duyệt mặc định, nên người dùng chọn một lần (nhớ trên thiết bị,
// đổi trong menu Hệ thống). Android: intent tới Chrome.
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const needsBrowserApp = () => isStandalone() && !isDesktopApp() && isIOS();

const BROWSER_KEY = 'sessionmon:browser';
const IOS_BROWSERS: { id: string; label: string; href: (u: URL) => string }[] = [
  { id: 'safari', label: 'Safari', href: (u) => 'x-safari-' + u.href },
  { id: 'chrome', label: 'Chrome', href: (u) => u.href.replace(/^http/, 'googlechrome') },
  { id: 'edge', label: 'Edge', href: (u) => 'microsoft-edge-' + u.href },
  { id: 'firefox', label: 'Firefox', href: (u) => 'firefox://open-url?url=' + encodeURIComponent(u.href) },
  { id: 'brave', label: 'Brave', href: (u) => 'brave://open-url?url=' + encodeURIComponent(u.href) },
];

function chosenBrowser() {
  try {
    return IOS_BROWSERS.find((b) => b.id === localStorage.getItem(BROWSER_KEY));
  } catch {
    return undefined;
  }
}

function setBrowser(id: string) {
  try {
    localStorage.setItem(BROWSER_KEY, id);
  } catch {}
}

// Mục chọn trình duyệt (dùng ở menu Hệ thống và lần đầu mở link). after: chạy sau khi chọn.
function browserItems(after?: () => void): MenuItem[] {
  const cur = chosenBrowser()?.id;
  return IOS_BROWSERS.map((b) => ({ label: b.label, on: b.id === cur, run: () => (setBrowser(b.id), after?.()) }));
}

function appLinkFor(href: string): string | null {
  const url = new URL(href);
  if (!isStandalone() || url.origin !== location.origin || !/^https?:$/.test(url.protocol)) return null;
  if (isIOS()) {
    const b = chosenBrowser();
    return b ? b.href(url) : null;
  }
  if (/Android/i.test(navigator.userAgent)) {
    const fallback = encodeURIComponent(url.href);
    return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=${url.protocol.slice(0, -1)};package=com.android.chrome;S.browser_fallback_url=${fallback};end`;
  }
  return null;
}

// anchor: nút vừa bấm, để hiện menu chọn trình duyệt cạnh nó (lần đầu, trên iPhone).
function openExternal(href: string, anchor?: HTMLElement) {
  if (!isDesktopApp()) {
    const sameOrigin = new URL(href).origin === location.origin;
    if (needsBrowserApp() && sameOrigin && !chosenBrowser()) {
      showMenu(anchor ?? $('sysBtn'), ['Nhớ trên máy này, đổi lại trong menu Hệ thống', ...browserItems(() => openExternal(href))], 'Mở bằng trình duyệt');
      return;
    }
    const target = appLinkFor(href);
    if (target) location.href = target;
    else window.open(href, '_blank', 'noopener');
    return;
  }
  fetch('/api/open-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: href }) })
    .then((r) => {
      if (!r.ok) throw new Error();
    })
    .catch(() => window.open(href, '_blank', 'noopener'));
}

// ---------- Lệnh slash: gõ "/" ở đầu tin thì sổ danh sách lệnh của session ----------

const commandsBySession = new Map<string, SlashCommandInfo[]>();
let slashItems: SlashCommandInfo[] = [];
let slashSel = 0;

// Session mới (id rỗng): lấy lệnh theo thư mục đã chọn.
const commandsKey = (conn: Conn, id: string) => `${conn.machine.name}:${id || 'cwd:' + newCwd}`;

async function commandsFor(conn: Conn, id: string): Promise<SlashCommandInfo[]> {
  const key = commandsKey(conn, id);
  const hit = commandsBySession.get(key);
  if (hit) return hit;
  const q = id ? `session=${encodeURIComponent(id)}` : `cwd=${encodeURIComponent(newCwd)}`;
  const r = await api<{ commands: SlashCommandInfo[] }>(conn, `/api/commands?${q}`);
  commandsBySession.set(key, r.commands);
  return r.commands;
}

// Đang gõ tên lệnh: tin bắt đầu bằng "/" và con trỏ còn trong từ đầu tiên.
function slashQuery(): string | null {
  const t = $<HTMLTextAreaElement>('input');
  const caret = t.selectionStart ?? t.value.length;
  const head = t.value.slice(0, caret);
  return /^\/\S*$/.test(head) ? head.slice(1).toLowerCase() : null;
}

function hideSlash() {
  $('slashMenu').hidden = true;
  slashItems = [];
}

async function updateSlash() {
  const q = slashQuery();
  const cur = state.current;
  const menu = $('slashMenu');
  if (q === null || !cur) return hideSlash();
  const key = commandsKey(cur.conn, cur.id);
  if (!commandsBySession.has(key)) {
    menu.hidden = false;
    menu.replaceChildren(Object.assign(document.createElement('div'), { className: 'slash-empty', textContent: 'Đang tải danh sách lệnh…' }));
    try {
      await commandsFor(cur.conn, cur.id);
    } catch (err) {
      menu.replaceChildren(Object.assign(document.createElement('div'), { className: 'slash-empty', textContent: (err as Error).message }));
      return;
    }
    if (slashQuery() === null) return hideSlash();
  }
  const all = commandsBySession.get(key) ?? [];
  const hit = (c: SlashCommandInfo) => [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase());
  // Khớp đầu tên lên trước, rồi khớp giữa tên / mô tả. Cùng mức khớp: lệnh của bạn và dự án,
  // rồi lệnh có sẵn của Claude Code, cuối cùng là skill của plugin (tên dạng "plugin:skill").
  const origin = (c: SlashCommandInfo) => (c.builtin ? 1 : c.name.includes(':') ? 2 : 0);
  const rank = (c: SlashCommandInfo) =>
    (hit(c).some((n) => n.startsWith(q!)) ? 0 : hit(c).some((n) => n.includes(q!)) ? 1 : 2) * 3 + origin(c);
  slashItems = all
    .filter((c) => !q || hit(c).some((n) => n.includes(q)) || c.description.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .slice(0, 60);
  slashSel = 0;
  renderSlash();
}

function renderSlash() {
  const menu = $('slashMenu');
  menu.hidden = false;
  if (!slashItems.length) {
    menu.replaceChildren(Object.assign(document.createElement('div'), { className: 'slash-empty', textContent: 'Không có lệnh khớp' }));
    return;
  }
  menu.replaceChildren(
    ...slashItems.map((c, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'slash-item' + (i === slashSel ? ' on' : '');
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(i === slashSel));
      const line = document.createElement('span');
      line.className = 'slash-line';
      line.append(Object.assign(document.createElement('b'), { textContent: '/' + c.name }));
      if (c.argumentHint) line.append(Object.assign(document.createElement('span'), { className: 'slash-arg', textContent: c.argumentHint }));
      if (c.builtin) line.append(Object.assign(document.createElement('span'), { className: 'slash-tag', textContent: 'có sẵn' }));
      b.append(line);
      if (c.description) b.append(Object.assign(document.createElement('span'), { className: 'slash-desc', textContent: c.description }));
      // pointerdown + preventDefault: chọn mà ô nhập không mất focus (bàn phím điện thoại không bị đóng).
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.onclick = () => chooseSlash(c);
      return b;
    }),
  );
  menu.querySelector('.slash-item.on')?.scrollIntoView({ block: 'nearest' });
}

function chooseSlash(c: SlashCommandInfo) {
  const t = $<HTMLTextAreaElement>('input');
  const rest = t.value.replace(/^\/\S*\s?/, '');
  t.value = `/${c.name} ${rest}`;
  const pos = c.name.length + 2;
  t.setSelectionRange(pos, pos);
  t.focus();
  autosize();
  hideSlash();
}

function setupSlash() {
  const t = $<HTMLTextAreaElement>('input');
  t.addEventListener('input', () => void updateSlash());
  t.addEventListener('click', () => void updateSlash());
  t.addEventListener('blur', () => setTimeout(hideSlash, 150));
  // Bắt phím trước bộ xử lý Enter-để-gửi.
  t.addEventListener(
    'keydown',
    (e) => {
      if ($('slashMenu').hidden || !slashItems.length) {
        if (e.key === 'Escape') hideSlash();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        slashSel = (slashSel + (e.key === 'ArrowDown' ? 1 : -1) + slashItems.length) % slashItems.length;
        renderSlash();
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (e.isComposing) return;
        chooseSlash(slashItems[slashSel]);
      } else if (e.key === 'Escape') hideSlash();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
  $('slashBtn').addEventListener('pointerdown', (e) => e.preventDefault());
  $('slashBtn').onclick = () => {
    if (!t.value.startsWith('/')) t.value = '/' + t.value;
    t.focus();
    t.setSelectionRange(1, 1);
    autosize();
    void updateSlash();
  };
}
