// Nút chép (copy) trong khung chat.
// - Khối code: nút "Copy" ở góc trên phải, chép đúng chữ trong khối (giữ tab, xuống dòng: dán TSV lên Google Sheet vẫn đúng cột).
// - Cả tin của Claude: nút nhỏ cạnh giờ trả lời xong, chép Markdown gốc của mọi đoạn chữ trong lượt.
// Điện thoại hay mở ClaudeMon qua http trong tailnet (không phải ngữ cảnh an toàn) nên navigator.clipboard có thể không có:
// khi đó (hoặc khi nó từ chối) dùng textarea ẩn + document.execCommand('copy'). Cả hai hỏng thì báo lỗi.

const DONE_MS = 1500;

function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  // font 16px: iOS không phóng to trang khi chọn; nằm trong màn để iOS chịu chọn, nhưng trong suốt.
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px;white-space:pre';
  const active = document.activeElement as HTMLElement | null;
  const sel = document.getSelection();
  const prev = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  document.body.append(ta);
  ta.focus({ preventScroll: true });
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  if (prev && sel) {
    sel.removeAllRanges();
    sel.addRange(prev);
  }
  active?.focus?.({ preventScroll: true });
  return ok;
}

// Chép chữ; ném lỗi (thông báo tiếng Việt) nếu cả hai cách đều hỏng.
export async function copyText(text: string): Promise<void> {
  let why = 'trình duyệt không cho dùng clipboard (trang không chạy HTTPS)';
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      why = (err as Error)?.message || 'trình duyệt từ chối quyền clipboard';
    }
  }
  if (legacyCopy(text)) return;
  throw new Error(`${why[0].toUpperCase()}${why.slice(1)}. Giữ ngón tay (hoặc kéo chuột) để chọn chữ rồi chép tay.`);
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
const DONE_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

// Bọc mọi <pre> trong HTML (đã qua DOMPurify) bằng khung có nút Copy. Nút nằm ngoài vùng cuộn ngang của <pre>,
// và <pre> chừa một dải trên cùng cho nút, nên nút không bao giờ che chữ.
export function enhanceCode(html: string): string {
  if (!html.includes('<pre')) return html;
  const t = document.createElement('template');
  t.innerHTML = html;
  t.content.querySelectorAll('pre').forEach((pre) => {
    const box = document.createElement('div');
    box.className = 'code-box';
    const lang = /(?:^|\s)language-([\w+#.-]+)/.exec(pre.querySelector('code')?.className ?? '')?.[1];
    if (lang) box.append(Object.assign(document.createElement('span'), { className: 'code-lang', textContent: lang }));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.textContent = 'Copy';
    btn.title = 'Chép khối code';
    pre.replaceWith(box);
    box.append(btn, pre);
  });
  return t.innerHTML;
}

// Nút chép cả tin; text là Markdown gốc.
const msgText = new WeakMap<HTMLElement, string>();
export function messageCopyButton(text: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-copy';
  btn.innerHTML = COPY_ICON;
  btn.title = 'Chép cả tin (Markdown)';
  btn.setAttribute('aria-label', 'Chép cả tin');
  msgText.set(btn, text);
  return btn;
}

const timers = new WeakMap<HTMLElement, number>();
function flash(btn: HTMLElement, ok: boolean) {
  const isMsg = btn.classList.contains('msg-copy');
  clearTimeout(timers.get(btn));
  btn.classList.toggle('done', ok);
  btn.classList.toggle('fail', !ok);
  if (isMsg) {
    btn.innerHTML = ok ? DONE_ICON : COPY_ICON;
    btn.setAttribute('aria-label', ok ? 'Đã chép' : 'Không chép được');
  } else btn.textContent = ok ? 'Đã chép' : 'Lỗi';
  timers.set(
    btn,
    window.setTimeout(() => {
      btn.classList.remove('done', 'fail');
      if (isMsg) {
        btn.innerHTML = COPY_ICON;
        btn.setAttribute('aria-label', 'Chép cả tin');
      } else btn.textContent = 'Copy';
    }, DONE_MS),
  );
}

// Chữ trong khối code đúng như hiển thị; marked thêm một dấu xuống dòng ở cuối, bỏ đi.
const codeText = (box: Element) => (box.querySelector('pre')?.textContent ?? '').replace(/\n$/, '');

// Máy tính: rê chuột lên bất kỳ phần nào của một lượt trả lời (chữ, nhóm tool, tệp) thì hiện nút chép ở cuối lượt đó.
// root là khung chứa các tin (#messages); dòng cuối lượt là .msg.turn, tin của người dùng (.msg-user) mở lượt mới.
export function setupTurnHover(root: HTMLElement) {
  let hot: Element | null = null;
  const set = (el: Element | null) => {
    if (hot === el) return;
    hot?.classList.remove('hot');
    hot = el;
    hot?.classList.add('hot');
  };
  root.addEventListener('mouseover', (e) => {
    let m: Element | null = e.target as Element;
    while (m && m.parentElement !== root) m = m.parentElement;
    while (m && !m.classList.contains('turn')) m = m.querySelector('.msg-user') ? null : m.nextElementSibling;
    set(m);
  });
  root.addEventListener('mouseleave', () => set(null));
}

// Gắn một lần lên khung chứa (nội dung tin vẽ lại bằng innerHTML nên dùng uỷ quyền sự kiện).
export function setupCopy(root: HTMLElement, onError: (message: string) => void) {
  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.code-copy, .msg-copy');
    if (!btn || !root.contains(btn)) return;
    e.preventDefault();
    e.stopPropagation();
    const text = btn.classList.contains('msg-copy') ? msgText.get(btn) : btn.parentElement ? codeText(btn.parentElement) : undefined;
    if (text === undefined) return;
    copyText(text).then(
      () => flash(btn, true),
      (err) => {
        flash(btn, false);
        onError((err as Error).message);
      },
    );
  });
}
