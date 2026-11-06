// Đọc toàn bộ lịch sử một session từ tệp .jsonl của Claude Code, kể cả phần trước các lần thu gọn (compact).
//
// getSessionMessages của SDK chỉ trả chuỗi tin sau lần compact gần nhất, nên ảnh, video và tin cũ biến mất.
// Ở đây đi ngược từ tin cuối theo parentUuid; tới mốc compact (parentUuid rỗng) thì đi tiếp theo
// logicalParentUuid. Nhánh đã bị sửa / tua lại không nằm trên chuỗi nên vẫn bị bỏ như Claude Code.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { statSync } from 'node:fs';

export interface TranscriptEntry {
  uuid: string;
  message: unknown;
  at?: number;
}

const cache = new Map<string, { mtime: number; size: number; entries: TranscriptEntry[] }>();

function findFile(sessionId: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const root = join(homedir(), '.claude', 'projects');
  for (const rel of new Bun.Glob(`*/${sessionId}.jsonl`).scanSync({ cwd: root, onlyFiles: true })) return join(root, rel);
  return null;
}

// Trả null khi không tìm thấy tệp (để người gọi quay về SDK).
export async function readTranscript(sessionId: string): Promise<TranscriptEntry[] | null> {
  const file = findFile(sessionId);
  if (!file) return null;
  const st = statSync(file);
  const hit = cache.get(sessionId);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.entries;

  const byUuid = new Map<string, any>();
  let leaf: any = null;
  for (const line of (await Bun.file(file).text()).split('\n')) {
    if (!line) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e?.uuid) continue;
    byUuid.set(e.uuid, e);
    if ((e.type === 'user' || e.type === 'assistant') && !e.isSidechain) leaf = e;
  }

  const chain: any[] = [];
  const seen = new Set<string>();
  for (let e = leaf; e && !seen.has(e.uuid); ) {
    seen.add(e.uuid);
    chain.push(e);
    const next = e.parentUuid ?? e.logicalParentUuid;
    e = next ? byUuid.get(next) : null;
  }
  chain.reverse();

  const entries = chain
    .filter((e) => (e.type === 'user' || e.type === 'assistant') && e.message && !e.isMeta && !e.isSidechain && !e.isCompactSummary)
    .map((e) => {
      const at = Date.parse(e.timestamp);
      return { uuid: e.uuid as string, message: e.message, ...(Number.isFinite(at) ? { at } : {}) };
    });
  cache.set(sessionId, { mtime: st.mtimeMs, size: st.size, entries });
  // Giữ cache nhỏ: chỉ vài session gần nhất.
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return entries;
}

// Tệp và thư mục của một session trong ~/.claude/projects: <dự án>/<id>.jsonl và <dự án>/<id>/ (subagent, kết quả tool).
export function sessionFiles(id: string): string[] {
  const root = join(homedir(), '.claude', 'projects');
  const out: string[] = [];
  for (const pattern of [`*/${id}.jsonl`, `*/${id}`])
    for (const rel of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: false })) out.push(join(root, rel));
  return out;
}

// Chuyển vào Thùng rác của Windows (khôi phục được), không xoá hẳn. Đường dẫn đi qua biến môi trường nên không bị chèn lệnh.
export async function recycle(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const script = [
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    '$ErrorActionPreference = "Stop"',
    'foreach ($p in ($env:CLAUDEMON_RECYCLE -split "`n")) {',
    '  if (-not $p) { continue }',
    '  if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, "OnlyErrorDialogs", "SendToRecycleBin") }',
    '  elseif (Test-Path -LiteralPath $p) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, "OnlyErrorDialogs", "SendToRecycleBin") }',
    '}',
  ].join('\n');
  const p = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], {
    stdout: 'ignore',
    stderr: 'pipe',
    env: { ...process.env, CLAUDEMON_RECYCLE: paths.join('\n') },
  });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(err.trim().split('\n')[0] || `powershell thoát mã ${code}`);
}
