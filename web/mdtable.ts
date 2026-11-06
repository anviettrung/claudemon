// Bảng markdown dễ đọc trên mọi cỡ màn.
// - Màn rộng: bảng thường, có hàng tiêu đề, cột ngắn không gãy dòng, cột dài có bề rộng tối thiểu (cuộn ngang khi chật).
// - Màn hẹp (điện thoại): bảng nhiều cột, chữ dài chuyển thành thẻ, mỗi dòng một thẻ; cột đầu làm tiêu đề,
//   các cột còn lại xếp dọc kèm nhãn là tên cột. Nút ở góc chuyển qua lại giữa thẻ và bảng.
// Chọn dạng nào là do CSS (container query trên .md-table) quyết định theo bề rộng thật của khung chat.

const SHORT = 18; // cột có ô dài nhất ≤ SHORT ký tự: không gãy dòng
const TINY = 8; // cột rất ngắn (vd "M", "12%"): ở dạng thẻ, nhãn và giá trị chung một hàng
const LONG = 40; // cột có ô dài hơn LONG ký tự: bề rộng tối thiểu để không bị bóp còn một chữ mỗi dòng
const BADGE = 5; // cột đầu ngắn hơn (vd "#", "0.1"): làm huy hiệu đứng trước cột thứ hai trong tiêu đề thẻ

const len = (el: Element) => (el.textContent ?? '').trim().length;

function enhance(table: HTMLTableElement) {
  const head = table.tHead?.rows[0];
  const labels = head ? [...head.cells].map((c) => (c.textContent ?? '').trim()) : [];
  const rows = [...table.querySelectorAll('tr')];
  const cols = Math.max(0, ...rows.map((r) => r.cells.length));
  const maxLen = Array.from({ length: cols }, (_, i) => Math.max(0, ...rows.map((r) => (r.cells[i] ? len(r.cells[i]) : 0))));
  const total = maxLen.reduce((a, b) => a + b, 0);
  const badge = cols >= 3 && maxLen[0] <= BADGE;

  for (const r of rows) {
    [...r.cells].forEach((c, i) => {
      if (maxLen[i] <= SHORT) c.classList.add('nw');
      if (maxLen[i] <= TINY) c.classList.add('tiny');
      if (maxLen[i] > LONG) c.classList.add('long');
      if (c.tagName !== 'TD') return;
      if (labels[i]) c.dataset.label = labels[i];
      if (badge ? i <= 1 : i === 0) c.classList.add(badge && i === 0 ? 'cb' : 'ct');
    });
  }

  const box = document.createElement('div');
  box.className = 'md-table';
  // Đủ nhiều cột và đủ nhiều chữ thì trên màn hẹp mới đáng đổi sang thẻ; bảng số liệu ngắn vẫn để dạng bảng.
  if (cols >= 3 && total > 48) {
    box.classList.add('wide', 'cards');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'md-table-toggle';
    btn.textContent = 'Xem dạng bảng';
    box.append(btn);
  }
  const scroll = document.createElement('div');
  scroll.className = 'md-table-scroll';
  table.replaceWith(box);
  scroll.append(table);
  box.append(scroll);
}

// Nhận HTML đã qua DOMPurify, trả về HTML có bảng đã bọc và gắn nhãn.
export function enhanceTables(html: string): string {
  if (!html.includes('<table')) return html;
  const t = document.createElement('template');
  t.innerHTML = html;
  t.content.querySelectorAll('table').forEach((x) => enhance(x as HTMLTableElement));
  return t.innerHTML;
}

// Nút chuyển thẻ ↔ bảng; gắn một lần lên khung tin vì nội dung tin được vẽ lại bằng innerHTML.
export function setupTables(root: HTMLElement) {
  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.md-table-toggle');
    const box = btn?.parentElement;
    if (!btn || !box) return;
    const cards = box.classList.toggle('cards');
    btn.textContent = cards ? 'Xem dạng bảng' : 'Xem dạng thẻ';
  });
}

// Vuốt chuyển màn không bắt đầu trong bảng đang cuộn ngang được (dạng thẻ thì không cuộn, vuốt bình thường).
export function inScrollableTable(t: HTMLElement): boolean {
  const s = t.closest('.md-table-scroll');
  return !!s && s.scrollWidth > s.clientWidth + 1;
}
