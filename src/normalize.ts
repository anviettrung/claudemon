// Đổi tin nhắn của Claude Code (từ transcript hoặc từ luồng SDK) sang dạng Block gọn cho giao diện.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import type { Block, ChatMessage, FileRef, MediaRef, SlashCommandInfo } from './protocol.ts';

const MAX_RESULT_CHARS = 20_000;

// ---------- Ảnh base64 trong tin: giữ ở bộ nhớ, phát qua /api/media/<id> ----------
// id là băm của nội dung, nên đọc lại transcript (vd sau khi agent khởi động lại) cho ra đúng id cũ.

const MEDIA_LIMIT_BYTES = 300 * 1024 * 1024;
const media = new Map<string, { type: string; data: Buffer }>();
let mediaBytes = 0;

function putMedia(mediaType: string, b64: string): MediaRef {
  const id = createHash('sha1').update(b64).digest('hex').slice(0, 24);
  const hit = media.get(id);
  if (hit) {
    // Dùng lại thì đưa xuống cuối Map (mới dùng gần đây).
    media.delete(id);
    media.set(id, hit);
  } else {
    const data = Buffer.from(b64, 'base64');
    media.set(id, { type: mediaType, data });
    mediaBytes += data.length;
    for (const [k, v] of media) {
      if (mediaBytes <= MEDIA_LIMIT_BYTES) break;
      media.delete(k);
      mediaBytes -= v.data.length;
    }
  }
  return { url: `/api/media/${id}`, mediaType };
}

export function getMedia(id: string) {
  return media.get(id);
}

function imageRef(c: any): MediaRef | null {
  const src = c?.source;
  if (src?.type === 'base64' && typeof src.data === 'string') return putMedia(src.media_type || 'image/png', src.data);
  return null;
}

// ---------- Tệp gửi bằng SendUserFile: chỉ phục vụ tệp có tên trong transcript ----------

const files = new Map<string, string>();

function fileRef(raw: string, cwd?: string): FileRef {
  const path = isAbsolute(raw) || !cwd ? raw : resolve(cwd, raw);
  const token = createHash('sha1').update(path.toLowerCase()).digest('hex').slice(0, 24);
  files.set(token, path);
  const name = basename(path);
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const kind = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext)
    ? 'image'
    : ['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext)
      ? 'video'
      : ['html', 'htm'].includes(ext)
        ? 'html'
        : 'other';
  return { name, path, url: `/api/file/${token}/${encodeURIComponent(name)}`, kind, exists: existsSync(path) };
}

export function filePath(token: string) {
  return files.get(token);
}

// ---------------------------------------------------------------------------------------------------

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) => (c?.type === 'text' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

// cwd: thư mục làm việc của session, để đổi đường dẫn tương đối trong SendUserFile thành tuyệt đối.
export function toBlocks(content: unknown, cwd?: string): Block[] {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const c of content as any[]) {
    switch (c?.type) {
      case 'text':
        if (c.text?.trim()) blocks.push({ type: 'text', text: c.text });
        break;
      case 'thinking':
        if (c.thinking?.trim()) blocks.push({ type: 'thinking', text: c.thinking });
        break;
      case 'image': {
        const image = imageRef(c);
        if (image) blocks.push({ type: 'image', image });
        break;
      }
      case 'tool_use':
      case 'server_tool_use':
        if ((c.name === 'SendUserFile' || c.name === 'mcp__claudemon__send_user_file') && Array.isArray(c.input?.files)) {
          blocks.push({
            type: 'files',
            toolUseId: c.id,
            caption: typeof c.input.caption === 'string' ? c.input.caption : undefined,
            files: c.input.files.filter((f: unknown) => typeof f === 'string').map((f: string) => fileRef(f, cwd)),
          });
        } else blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
        break;
      case 'tool_result': {
        let text = resultText(c.content);
        if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + '\n… (đã cắt bớt)';
        const images = Array.isArray(c.content) ? c.content.map(imageRef).filter((x: MediaRef | null): x is MediaRef => !!x) : [];
        blocks.push({ type: 'tool_result', toolUseId: c.tool_use_id, text, isError: !!c.is_error, ...(images.length ? { images } : {}) });
        break;
      }
    }
  }
  return blocks;
}

// message có dạng MessageParam / BetaMessage: { role, content }.
export function toChatMessage(id: string, message: any, cwd?: string, at?: number): ChatMessage | null {
  const role = message?.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const blocks = toBlocks(message.content, cwd);
  if (!blocks.length) return null;
  return at ? { id, role, blocks, at } : { id, role, blocks };
}

// ---------- Lệnh slash ----------

// Lệnh MCP được Claude Code liệt kê với tên hiển thị "Server Name:prompt (MCP)", nhưng gõ thì phải là
// "/mcp__<server, ký tự lạ thành _>__<prompt>". Mô tả skill có hậu tố "(user)" / "(project)" thì bỏ cho gọn.
export function toCommandInfo(c: any): SlashCommandInfo {
  let name: string = c.name ?? '';
  const mcp = /^(.+?):(.+?)\s*\(MCP\)$/.exec(name);
  if (mcp) name = `mcp__${mcp[1].replace(/[^\w-]/g, '_')}__${mcp[2].trim()}`;
  const description = String(c.description ?? '').replace(/\s*\((user|project|plugin)\)\s*$/i, '');
  return { name, description, argumentHint: c.argumentHint || undefined, aliases: c.aliases, builtin: c.builtin };
}
