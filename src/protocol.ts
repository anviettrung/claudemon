// Kiểu dữ liệu chung giữa claudemon-agent và giao diện web.

// Ảnh nằm trong tin (base64): agent giữ ở bộ nhớ, giao diện tải qua url (tương đối với agent).
export interface MediaRef {
  url: string;
  mediaType: string;
}

// Tệp Claude gửi cho người dùng bằng tool SendUserFile; agent phục vụ từ ổ đĩa.
export interface FileRef {
  name: string;
  path: string;
  url: string;
  // html: báo cáo HTML, giao diện cho xem ngay trong app hoặc mở bằng trình duyệt.
  kind: 'image' | 'video' | 'html' | 'other';
  exists: boolean;
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'image'; image: MediaRef }
  | { type: 'files'; toolUseId: string; caption?: string; files: FileRef[] }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; text: string; isError: boolean; images?: MediaRef[] };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  blocks: Block[];
  // Lúc gửi / nhận (epoch ms); tin cũ không đọc được giờ thì để trống.
  at?: number;
}

export type LiveState = 'idle' | 'running' | 'requires_action';

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  gitBranch?: string;
  lastModified: number;
  createdAt?: number;
  // Có tiến trình do agent này giữ (đang chạy hoặc đang chờ tin tiếp theo).
  live: boolean;
  state: LiveState;
  // Tệp lịch sử vừa được nơi khác (Claude desktop, CLI) ghi vào gần đây.
  elsewhere: boolean;
  // Lượt đang chạy bắt đầu lúc nào (epoch ms), để đếm thời gian chạy.
  turnStartedAt?: number;
}

export interface PermissionAsk {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  canAlwaysAllow: boolean;
}

export interface MachineInfo {
  name: string;
  computer: string;
  host?: string;
  // Địa chỉ HTTPS để máy khác / điện thoại vào: `url` trong machines.json, hoặc https://<host>.<tailnet>.ts.net khi dùng
  // Tailscale. Không có thì máy chỉ dùng được tại chỗ.
  url?: string;
}

// Cách sắp xếp session do người dùng đặt, đồng bộ giữa các máy qua nhánh git `claudemon-library`.
export interface LibraryFolder {
  name: string;
  order: number;
  deleted?: boolean;
  updatedAt: number;
}

export interface LibraryEntry {
  folder?: string | null;
  tags?: string[];
  pinned?: boolean;
  // Tên tự đặt; để trống thì dùng tiêu đề của Claude Code.
  title?: string;
  updatedAt: number;
}

// Thư mục làm việc người dùng tự thêm cho một máy, để chọn nhanh khi mở session mới.
export interface LibraryPath {
  machine: string;
  path: string;
  deleted?: boolean;
  updatedAt: number;
}

// Dự án (nhóm theo tên thư mục làm việc, gộp giữa các máy): tên hiển thị tự đặt.
// Khoá: tên thư mục viết thường, hoặc "scratch" cho phiên không thư mục.
export interface LibraryProject {
  name?: string;
  updatedAt: number;
}

// Dự án tự tạo: một tên, một mã (đầu mã task, vd MSO) và các thư mục gốc trên từng máy. Session có thư mục
// làm việc nằm trong (hoặc đúng bằng) một thư mục gốc thì thuộc dự án đó, dù thư mục mỗi máy tên khác nhau.
export interface ProjectRoot {
  machine: string;
  path: string;
}

export interface LibraryProjectDef {
  name: string;
  code: string;
  roots: ProjectRoot[];
  order: number;
  deleted?: boolean;
  updatedAt: number;
}

// pending: tạm gác / đang chờ việc khác, vẫn tính là chưa xong.
export const TASK_STATUSES = ['todo', 'doing', 'pending', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

// Ảnh của task: blob trong nhánh claudemon-library (thư mục images/), gọi bằng mã SHA-1 của blob.
export interface TaskImage {
  sha: string;
  type: string;
  name?: string;
}

// Task của một dự án. Mã hiển thị: <mã dự án>-<num>, vd MSO-12.
export interface LibraryTask {
  project: string;
  num: number;
  title: string;
  body: string;
  images: TaskImage[];
  status: TaskStatus;
  // Task cũ chưa có thì coi là 'medium'.
  priority?: TaskPriority;
  // Phiên bản dự kiến ra (chữ tự do, vd 1.4.0). Rỗng = chưa định.
  version?: string;
  createdAt: number;
  deleted?: boolean;
  updatedAt: number;
}

// Checklist mẫu của một dự án, vd "Verify trước khi release". Mỗi mục có id riêng; mục heading chỉ là tiêu đề nhóm, không kiểm.
export interface ChecklistItem {
  id: string;
  text: string;
  heading?: boolean;
}

export interface LibraryChecklist {
  project: string;
  name: string;
  // Hướng dẫn thêm cho Claude khi verify (lệnh build, chỗ cần xem...).
  notes: string;
  items: ChecklistItem[];
  createdAt: number;
  deleted?: boolean;
  updatedAt: number;
}

// Một lượt chạy checklist (vd cho phiên bản 1.4.0): chụp lại tên, hướng dẫn và các mục của mẫu lúc tạo,
// nên sửa mẫu về sau không làm đổi lượt cũ.
export interface LibraryChecklistRun {
  project: string;
  checklist: string;
  name: string;
  notes: string;
  items: ChecklistItem[];
  version?: string;
  createdAt: number;
  deleted?: boolean;
  updatedAt: number;
}

// pass: đạt, fail: lỗi, skip: không tự kiểm được / bỏ qua, todo: chưa kiểm (đặt lại).
export const CHECK_RESULTS = ['pass', 'fail', 'skip', 'todo'] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

// Kết quả của một mục trong một lượt chạy. Khoá: "<id lượt chạy>:<id mục>". Tách riêng từng mục để Claude (máy chạy
// session) và người dùng (máy khác) cùng đánh dấu các mục khác nhau mà khi gộp không đè nhau.
export interface LibraryCheckResult {
  run: string;
  item: string;
  result: CheckResult;
  note?: string;
  by: 'claude' | 'user';
  // "<tên máy>:<sessionId>" của session đã báo kết quả (khi by = claude).
  session?: string;
  updatedAt: number;
}

export interface Library {
  version: 1;
  folders: Record<string, LibraryFolder>;
  // Khoá: "<tên máy>:<sessionId>"
  sessions: Record<string, LibraryEntry>;
  // Khoá: "<tên máy>:<đường dẫn viết thường>"
  paths: Record<string, LibraryPath>;
  projects: Record<string, LibraryProject>;
  // Khoá: id ngẫu nhiên
  projectDefs: Record<string, LibraryProjectDef>;
  tasks: Record<string, LibraryTask>;
  checklists: Record<string, LibraryChecklist>;
  checklistRuns: Record<string, LibraryChecklistRun>;
  checkResults: Record<string, LibraryCheckResult>;
}

export type SyncState = 'ok' | 'pending' | 'error' | 'offline';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export interface ModelOption {
  value: string;
  displayName: string;
  description: string;
  efforts: Effort[];
}

export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  builtin?: boolean;
}

export interface ContextCategory {
  name: string;
  tokens: number;
  kind: 'used' | 'free' | 'buffer' | 'deferred';
}

// Mức dùng context: chính xác (lấy từ Claude Code) khi session đang chạy, ước tính từ lượt cuối khi chưa chạy.
export interface ContextInfo {
  used: number;
  max: number;
  percent: number;
  estimated: boolean;
  categories?: ContextCategory[];
}

export interface SessionMeta {
  model?: string;
  effort?: Effort;
  mode?: string;
  context?: ContextInfo;
}

// Tệp đính kèm gửi từ trình duyệt (base64). Ảnh đi thẳng vào tin; tệp khác được lưu ra đĩa và báo đường dẫn.
export interface Attachment {
  name: string;
  type: string;
  data: string;
}

// Hạn mức Claude của tài khoản đăng nhập trên máy, kèm trạng thái tự đánh thức cửa sổ 5 giờ (src/wakeup.ts).
// active: cửa sổ đang mở · blocked: cạn hạn mức · idle: cửa sổ hết, sắp poke · quiet: cửa sổ hết, giữ tới mốc
// unknown: chưa đọc được số · off: tắt trong machines.json
export type UsagePhase = 'active' | 'blocked' | 'idle' | 'quiet' | 'unknown' | 'off';

export interface UsageInfo {
  provider: 'claude';
  enabled: boolean;
  // accountUuid, để gộp các máy đăng nhập cùng tài khoản.
  account?: string;
  email?: string;
  phase: UsagePhase;
  fetchedAt?: number;
  // Phần trăm đã dùng; mốc reset là epoch ms.
  fiveHour?: number;
  resetsAt?: number;
  weekly?: number;
  weeklyResetsAt?: number;
  status?: string;
  error?: string;
  lastPoke?: { at: number; ok: boolean };
  nextPokeAt?: number;
  schedule?: { resetAt: string; pokeAt: string; quietFrom: string; quietNow: boolean };
}

// Agent -> trình duyệt, qua WebSocket.
export type ServerEvent =
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'message'; sessionId: string; message: ChatMessage }
  | { type: 'state'; sessionId: string; state: LiveState; live: boolean; turnStartedAt?: number }
  | { type: 'permission'; ask: PermissionAsk }
  | { type: 'permission_done'; sessionId: string; requestId: string }
  | { type: 'result'; sessionId: string; ok: boolean; error?: string; costUsd?: number; durationMs?: number }
  | { type: 'error'; sessionId?: string; error: string }
  | { type: 'library'; library: Library; sync: SyncState; syncError?: string }
  | { type: 'meta'; sessionId: string; meta: SessionMeta }
  | { type: 'usage'; usage: UsageInfo };

// Kết quả xoá session: tệp lịch sử chuyển vào Thùng rác của máy đó (khôi phục được).
export interface DeleteResult {
  deleted: string[];
  failed: { id: string; error: string }[];
}

export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'] as const;
export type UiPermissionMode = (typeof PERMISSION_MODES)[number];
