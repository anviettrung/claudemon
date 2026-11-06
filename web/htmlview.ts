// Xem tệp HTML (báo cáo Claude gửi bằng send_user_file) ngay trong app: lớp phủ có thanh tiêu đề và khung iframe.
// Iframe chạy trong sandbox không cùng origin, nên trang báo cáo không gọi được API của agent.
// Đóng bằng nút ×, phím Esc (khi focus ở ngoài khung trang) hoặc nút Quay lại của điện thoại.

let returnTo: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;

export interface HtmlDoc {
  src: string;
  name: string;
  path: string;
}

export function openHtmlViewer(doc: HtmlDoc, from: HTMLElement | null, openExternal: (url: string, from?: HTMLElement) => void) {
  closeHtmlViewer();
  returnTo = from;
  const box = document.createElement('div');
  box.className = 'htmlview';
  box.id = 'htmlview';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', doc.name);

  const bar = document.createElement('div');
  bar.className = 'htmlview-bar';
  const title = document.createElement('div');
  title.className = 'htmlview-title';
  title.append(
    Object.assign(document.createElement('b'), { textContent: doc.name }),
    Object.assign(document.createElement('span'), { textContent: doc.path }),
  );
  title.title = doc.path;
  const btn = (label: string, cls: string, run: () => void, tip: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.title = tip;
    b.setAttribute('aria-label', tip);
    b.onclick = run;
    return b;
  };
  const absolute = new URL(doc.src, location.href).href;
  const reload = btn('⟳', 'icon-btn htmlview-btn', () => (frame.src = doc.src), 'Tải lại');
  const ext = btn('Mở bằng trình duyệt ↗', 'ghost-btn htmlview-ext', () => openExternal(absolute, ext), 'Mở bằng trình duyệt');
  const close = btn('×', 'icon-btn htmlview-btn htmlview-close', closeHtmlViewer, 'Đóng');
  bar.append(title, reload, ext, close);

  const frame = document.createElement('iframe');
  frame.className = 'htmlview-frame';
  frame.title = doc.name;
  frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-forms allow-downloads');
  frame.referrerPolicy = 'no-referrer';
  frame.src = doc.src;

  box.append(bar, frame);
  document.body.append(box);
  onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeHtmlViewer();
    }
  };
  document.addEventListener('keydown', onKey, true);
  // Nút Quay lại (điện thoại, chuột) đóng trình xem thay vì rời trang.
  history.pushState({ htmlview: true }, '');
  window.addEventListener('popstate', onPop);
  close.focus();
}

function onPop() {
  closeHtmlViewer(true);
}

export function closeHtmlViewer(fromPop = false) {
  const box = document.getElementById('htmlview');
  if (!box) return;
  box.remove();
  if (onKey) document.removeEventListener('keydown', onKey, true);
  onKey = null;
  window.removeEventListener('popstate', onPop);
  if (!fromPop && history.state?.htmlview) history.back();
  returnTo?.focus();
  returnTo = null;
}

export const htmlViewerOpen = () => !!document.getElementById('htmlview');
