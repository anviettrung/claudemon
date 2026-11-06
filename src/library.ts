// Cách sắp xếp session (thư mục, nhãn, ghim, tên tự đặt), đồng bộ giữa các máy qua nhánh git riêng.
//
// Nhánh `sessionmon-library` của chính kho sessionmon chứa library.json và images/ (ảnh của task). Agent đọc và ghi nhánh đó bằng lệnh git
// cấp thấp (hash-object, mktree, commit-tree, push), không đụng thư mục làm việc hay nhánh main, nên bộ
// kéo bản mới (nút Khởi động lại agent) không bao giờ thấy thay đổi chưa commit hay lệch nhánh vì SessionMon.
// Hai máy cùng sửa: gộp theo từng bản ghi, bản có updatedAt mới hơn thắng.
import { existsSync } from 'node:fs';
import type { Library, SyncState } from './protocol.ts';

const BRANCH = 'sessionmon-library';
const REMOTE_REF = `refs/remotes/origin/${BRANCH}`;
const FILE = 'library.json';
const POLL_MS = 60_000;
const PUSH_DELAY_MS = 1500;

// Các nhóm bản ghi trong library.json; mỗi nhóm gộp theo từng bản ghi.
const KEYS = ['folders', 'sessions', 'paths', 'projects', 'projectDefs', 'tasks', 'checklists', 'checklistRuns', 'checkResults'] as const;

export const emptyLibrary = (): Library => ({
  version: 1,
  folders: {},
  sessions: {},
  paths: {},
  projects: {},
  projectDefs: {},
  tasks: {},
  checklists: {},
  checklistRuns: {},
  checkResults: {},
});

// Mốc thời gian cho một lần sửa: luôn lớn hơn mốc đang có, để lần sửa sau thắng kể cả khi đồng hồ
// máy này chậm hơn máy vừa ghi bản trước (đồng hồ Z và M từng lệch nhau 5 phút).
export const nextStamp = (prev?: number) => Math.max(Date.now(), (prev ?? 0) + 1);

// Gộp hai bản: mỗi bản ghi lấy bản có updatedAt lớn hơn.
export function mergeLibrary(a: Library, b: Library): Library {
  const pick = <T extends { updatedAt: number }>(x: Record<string, T> = {}, y: Record<string, T> = {}) => {
    const out: Record<string, T> = { ...x };
    for (const [k, v] of Object.entries(y)) if (!out[k] || v.updatedAt > out[k].updatedAt) out[k] = v;
    return out;
  };
  const out = emptyLibrary() as any;
  for (const k of KEYS) out[k] = pick((a as any)[k], (b as any)[k]);
  return out;
}

// JSON có thứ tự khoá cố định để so sánh và để diff trong git dễ đọc.
function stable(lib: Library): string {
  const sort = (o: Record<string, unknown> = {}) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y)));
  const out: Record<string, unknown> = { version: 1 };
  for (const k of KEYS) out[k] = sort((lib as any)[k]);
  return JSON.stringify(out, null, 2) + '\n';
}

function parse(text: string): Library {
  try {
    const j = JSON.parse(text);
    const out = emptyLibrary() as any;
    for (const k of KEYS) out[k] = j[k] ?? {};
    return out;
  } catch {
    return emptyLibrary();
  }
}

const SHA = /^[0-9a-f]{40}$/;

// Ảnh mà các task còn dùng; đưa vào thư mục images/ của cây commit để push mang theo blob.
function imagesOf(lib: Library): string[] {
  const out = new Set<string>();
  for (const t of Object.values(lib.tasks ?? {})) if (!t.deleted) for (const i of t.images ?? []) if (SHA.test(i.sha)) out.add(i.sha);
  return [...out].sort();
}

export class LibraryStore {
  lib: Library = emptyLibrary();
  sync: SyncState = 'pending';
  syncError?: string;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private busy: Promise<void> = Promise.resolve();

  constructor(
    private repo: string,
    private machine: string,
    private cachePath: string,
    private onChange: () => void,
  ) {}

  async init() {
    if (existsSync(this.cachePath)) this.lib = parse(await Bun.file(this.cachePath).text());
    const remote = await this.readRef(REMOTE_REF);
    if (remote) this.lib = mergeLibrary(this.lib, remote);
    setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  // Sửa thư viện; fn đặt updatedAt cho bản ghi nó đổi. Lưu cache ngay, đẩy lên git sau một nhịp ngắn.
  async update(fn: (lib: Library) => void) {
    fn(this.lib);
    await Bun.write(this.cachePath, stable(this.lib));
    this.setSync('pending');
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.serial(() => this.push()), PUSH_DELAY_MS);
  }

  // Kéo bản mới từ máy khác; nếu máy này có thay đổi chưa đẩy thì đẩy luôn.
  poll() {
    return this.serial(async () => {
      if (!(await this.fetch())) return;
      const remote = (await this.readRef(REMOTE_REF)) ?? emptyLibrary();
      const merged = mergeLibrary(this.lib, remote);
      if (stable(merged) !== stable(this.lib)) {
        this.lib = merged;
        await Bun.write(this.cachePath, stable(this.lib));
        this.onChange();
      }
      if (stable(merged) !== stable(remote) || !(await this.hasImages(REMOTE_REF, merged))) await this.push();
      else this.setSync('ok');
    });
  }

  private serial(job: () => Promise<void>) {
    this.busy = this.busy.then(job).catch((err) => this.setSync('error', (err as Error).message));
    return this.busy;
  }

  private setSync(s: SyncState, error?: string) {
    if (this.sync === s && this.syncError === error) return;
    this.sync = s;
    this.syncError = error;
    this.onChange();
  }

  private async push() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const base = await this.revParse(REMOTE_REF);
      const remote = base ? ((await this.readRef(base)) ?? emptyLibrary()) : emptyLibrary();
      const merged = mergeLibrary(remote, this.lib);
      this.lib = merged;
      await Bun.write(this.cachePath, stable(merged));
      if (base && stable(merged) === stable(remote) && (await this.hasImages(base, merged))) return this.setSync('ok');

      const commit = await this.commit(merged, base);
      const r = await this.git(['push', '--quiet', 'origin', `${commit}:refs/heads/${BRANCH}`]);
      if (r.code === 0) {
        await this.git(['update-ref', REMOTE_REF, commit]);
        this.onChange();
        return this.setSync('ok');
      }
      // Máy khác vừa đẩy trước: kéo về, gộp lại, thử lại.
      if (!(await this.fetch())) return;
    }
    this.setSync('error', 'Đẩy library.json thất bại sau 3 lần');
  }

  // Lưu ảnh của task vào kho git (chưa thuộc commit nào; lần push sau đưa vào images/). Trả mã SHA-1 của blob.
  async storeImage(bytes: Uint8Array): Promise<string> {
    const r = await this.git(['hash-object', '-w', '--stdin'], bytes);
    const sha = r.out.trim();
    if (r.code !== 0 || !SHA.test(sha)) throw new Error(`git hash-object: ${r.err.trim()}`);
    return sha;
  }

  // Đọc ảnh theo mã blob. Chưa có (máy khác vừa tạo task, chưa kéo về) thì kéo nhánh về rồi thử lại một lần.
  async readImage(sha: string): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!SHA.test(sha)) return null;
    for (let i = 0; i < 2; i++) {
      const p = Bun.spawn(['git', '-C', this.repo, 'cat-file', 'blob', sha], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
      const [buf, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), p.exited]);
      if (code === 0) return new Uint8Array(buf);
      if (i === 0) await this.poll();
    }
    return null;
  }

  // Cây ở ref đã có đủ ảnh mà lib cần chưa.
  private async hasImages(ref: string, lib: Library): Promise<boolean> {
    const want = imagesOf(lib);
    if (!want.length) return true;
    const r = await this.git(['ls-tree', '--name-only', `${ref}:images`]);
    if (r.code !== 0) return false;
    const have = new Set(r.out.split('\n').map((x) => x.trim()));
    return want.every((s) => have.has(s));
  }

  private async commit(lib: Library, parent: string | null): Promise<string> {
    const blob = (await this.git(['hash-object', '-w', '--stdin'], stable(lib))).out.trim();
    let entries = `100644 blob ${blob}\t${FILE}\n`;
    // Chỉ đưa vào cây những ảnh có sẵn trong kho máy này (ảnh máy khác tạo đã về theo lần fetch).
    const want = imagesOf(lib);
    if (want.length) {
      const check = await this.git(['cat-file', '--batch-check'], want.join('\n') + '\n');
      const ok = check.out.split('\n').filter((l) => / blob \d+$/.test(l.trim())).map((l) => l.split(' ')[0]);
      if (ok.length) {
        const sub = (await this.git(['mktree'], ok.map((s) => `100644 blob ${s}\t${s}`).join('\n') + '\n')).out.trim();
        entries += `040000 tree ${sub}\timages\n`;
      }
    }
    const tree = (await this.git(['mktree'], entries)).out.trim();
    const args = ['commit-tree', tree, '-m', `sessionmon: cập nhật library từ máy ${this.machine}`];
    if (parent) args.push('-p', parent);
    const r = await this.git(args);
    if (r.code !== 0) throw new Error(`git commit-tree: ${r.err.trim()}`);
    return r.out.trim();
  }

  // Trả false khi không fetch được (mất mạng); nhánh chưa có trên remote thì vẫn tính là được.
  private async fetch(): Promise<boolean> {
    // --no-write-fetch-head: fetch này chạy định kỳ, đừng ghi chồng FETCH_HEAD của lần pull đang chạy song song.
    const r = await this.git(['fetch', '--quiet', '--no-write-fetch-head', 'origin', `+refs/heads/${BRANCH}:${REMOTE_REF}`]);
    if (r.code === 0) return true;
    if (/couldn't find remote ref/i.test(r.err)) {
      await this.git(['update-ref', '-d', REMOTE_REF]);
      return true;
    }
    this.setSync('offline', r.err.trim().split('\n')[0]);
    return false;
  }

  private async revParse(ref: string): Promise<string | null> {
    const r = await this.git(['rev-parse', '--verify', '--quiet', ref]);
    return r.code === 0 ? r.out.trim() : null;
  }

  private async readRef(ref: string): Promise<Library | null> {
    const r = await this.git(['show', `${ref}:${FILE}`]);
    return r.code === 0 ? parse(r.out) : null;
  }

  private async git(args: string[], stdin?: string | Uint8Array) {
    const p = Bun.spawn(['git', '-C', this.repo, ...args], {
      stdin: stdin === undefined ? 'ignore' : typeof stdin === 'string' ? new TextEncoder().encode(stdin) : stdin,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  }
}
