// Theme giao diện: kiểu (Claude / Retro / Aero) và sáng / tối (theo máy hoặc chọn tay), nhớ trên từng thiết bị.
// Đặt data-style và data-scheme trên <html>; CSS đọc hai thuộc tính này (style.css, theme-retro.css, theme-aero.css).
// index.html có một đoạn script nhỏ làm đúng việc này trước khi trang vẽ, để không nháy theme cũ.

export type ThemeStyle = 'claude' | 'retro' | 'aero';
const STYLES: ThemeStyle[] = ['claude', 'retro', 'aero'];
export type ThemeScheme = 'auto' | 'light' | 'dark';
export interface ThemePref {
  style: ThemeStyle;
  scheme: ThemeScheme;
}

const KEY = 'claudemon:theme';
const dark = matchMedia('(prefers-color-scheme: dark)');

// LUẬT MÉP TRÊN: mỗi theme (và mỗi bản sáng / tối) chỉ có MỘT màu mép trên, dùng cho thanh trạng thái điện thoại,
// thanh tiêu đề cửa sổ app (meta theme-color), và là màu mép trên của MỌI màn: danh sách, chat (điện thoại), cả trang
// (máy tính). Lý do: iPhone lấy màu thanh trạng thái một lần lúc mở app, không đổi theo theme-color khi chuyển màn,
// nên chỉ một màu chung mới luôn liền với tai thỏ. Thêm theme mới: khai màu ở đây (và bản sao trong index.html),
// rồi làm cho mép trên mỗi màn đúng màu đó trong CSS của theme.
//   Claude: --bg.  Retro: đỉnh nền hoàng hôn (--sunset); màn chat điện thoại có dải nền hoàng hôn trên thanh tiêu đề.
//   Aero: đỉnh bầu trời (--sky-top); thanh tiêu đề màn chat điện thoại bắt đầu đúng màu này.
export const BAR: Record<ThemeStyle, Record<'light' | 'dark', string>> = {
  claude: { light: '#f5f4ef', dark: '#262624' },
  retro: { light: '#2d1b69', dark: '#07021a' },
  aero: { light: '#2f9fe6', dark: '#020c1c' },
};

function applyBar() {
  const root = document.documentElement;
  const bar = BAR[root.dataset.style as ThemeStyle]?.[root.dataset.scheme as 'light' | 'dark'];
  if (bar) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bar);
}

export function themePref(): ThemePref {
  let p: Partial<ThemePref> = {};
  try {
    p = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {}
  return {
    style: STYLES.includes(p.style as ThemeStyle) ? (p.style as ThemeStyle) : 'claude',
    scheme: p.scheme === 'light' || p.scheme === 'dark' ? p.scheme : 'auto',
  };
}

export function applyTheme() {
  const p = themePref();
  const scheme = p.scheme === 'auto' ? (dark.matches ? 'dark' : 'light') : p.scheme;
  const root = document.documentElement;
  root.dataset.style = p.style;
  root.dataset.scheme = scheme;
  applyBar();
}

export function setThemePref(patch: Partial<ThemePref>) {
  localStorage.setItem(KEY, JSON.stringify({ ...themePref(), ...patch }));
  applyTheme();
}

// Cửa sổ app trên máy tính (PWA, manifest có display_override window-controls-overlay): trình duyệt bỏ thanh tiêu đề
// xám mặc định, app tự vẽ dải tiêu đề theo theme; nút _ □ × của hệ thống nằm đè góc phải, nền vùng đó là theme-color.
// Người dùng có thể tắt / bật lại bằng nút mũi tên trên thanh, nên theo dõi geometrychange.
function setupTitlebar() {
  const wco = (navigator as Navigator & { windowControlsOverlay?: EventTarget & { visible: boolean } }).windowControlsOverlay;
  if (!wco) return;
  const sync = () => document.documentElement.classList.toggle('wco', wco.visible);
  sync();
  wco.addEventListener('geometrychange', sync);
}

export function setupTheme() {
  applyTheme();
  setupTitlebar();
  dark.addEventListener('change', applyTheme);
}
