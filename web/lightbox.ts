// Ảnh bấm để xem cỡ lớn: lớp phủ tối, chuyển ảnh, phóng to và kéo xem.

export function makeZoomable(el: HTMLElement, open: () => void) {
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.title = 'Bấm để xem cỡ lớn';
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
}

// Lớp phủ xem ảnh cỡ lớn: chạm ra ngoài, nút ×, phím Esc để đóng; ← → hoặc vuốt để chuyển ảnh.
let lightboxReturn: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;
export function openLightbox(items: { src: string; caption: string }[], index: number, from: HTMLElement) {
  closeLightbox();
  lightboxReturn = from;
  let i = index;
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.id = 'lightbox';
  lb.setAttribute('role', 'dialog');
  lb.setAttribute('aria-modal', 'true');
  const img = document.createElement('img');
  const cap = document.createElement('div');
  cap.className = 'lightbox-caption';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lightbox-close';
  close.textContent = '×';
  close.onclick = closeLightbox;
  close.setAttribute('aria-label', 'Đóng');
  const show = () => {
    img.src = items[i].src;
    img.alt = items[i].caption || 'Ảnh';
    cap.textContent = [items[i].caption, items.length > 1 ? `${i + 1}/${items.length}` : ''].filter(Boolean).join(' · ');
  };
  img.draggable = false;

  // Phóng to: chụm hai ngón, cuộn chuột, chạm/bấm đúp. Đã phóng to thì kéo để xem chỗ khác, chưa thì vuốt ngang để chuyển ảnh.
  let scale = 1, tx = 0, ty = 0;
  const center = () => {
    const r = img.getBoundingClientRect();
    return { x: r.left + r.width / 2 - tx, y: r.top + r.height / 2 - ty };
  };
  const maxScale = () => Math.max(4, (img.naturalWidth / img.clientWidth) * 2, (img.naturalHeight / img.clientHeight) * 2);
  const apply = () => {
    if (scale <= 1.01) scale = 1;
    const c = center();
    for (const [axis, size, view] of [['x', img.clientWidth * scale, lb.clientWidth], ['y', img.clientHeight * scale, lb.clientHeight]] as const) {
      const c0 = c[axis];
      const t = size <= view ? 0 : Math.min(size / 2 - c0, Math.max(view - c0 - size / 2, axis === 'x' ? tx : ty));
      if (axis === 'x') tx = t;
      else ty = t;
    }
    img.style.transform = scale === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`;
    lb.classList.toggle('zoomed', scale > 1);
  };
  // Giữ điểm ảnh q (toạ độ tính từ tâm ảnh, chưa nhân scale) nằm dưới điểm p trên màn hình.
  const anchorAt = (p: { x: number; y: number }) => {
    const c = center();
    return { x: (p.x - c.x - tx) / scale, y: (p.y - c.y - ty) / scale };
  };
  const zoomTo = (s: number, p: { x: number; y: number }, q = anchorAt(p)) => {
    const c = center();
    scale = Math.min(maxScale(), Math.max(1, s));
    tx = p.x - c.x - scale * q.x;
    ty = p.y - c.y - scale * q.y;
    apply();
  };
  const reset = () => {
    scale = 1;
    tx = ty = 0;
    apply();
  };

  const step = (d: number) => {
    if (items.length < 2) return;
    i = (i + d + items.length) % items.length;
    reset();
    show();
  };
  lb.append(img, cap, close);
  let moved = false;
  lb.addEventListener('click', (e) => {
    if (e.target === lb && !moved) closeLightbox();
  });

  const pts = new Map<number, { x: number; y: number }>();
  let start = { x: 0, y: 0 }, pinch: { dist: number; scale: number; q: { x: number; y: number } } | null = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  const mid = () => {
    const [a, b] = [...pts.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  lb.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.lightbox-close')) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      start = { x: e.clientX, y: e.clientY };
      moved = false;
    } else if (pts.size === 2) {
      const m = mid();
      pinch = { dist: m.dist || 1, scale, q: anchorAt(m) };
      moved = true;
    }
  });
  lb.addEventListener('pointermove', (e) => {
    const prev = pts.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pts.set(e.pointerId, cur);
    if (Math.hypot(cur.x - start.x, cur.y - start.y) > 8) moved = true;
    if (pts.size === 2 && pinch) {
      const m = mid();
      zoomTo((pinch.scale * m.dist) / pinch.dist, m, pinch.q);
    } else if (pts.size === 1 && scale > 1) {
      tx += cur.x - prev.x;
      ty += cur.y - prev.y;
      apply();
    }
  });
  const up = (e: PointerEvent) => {
    if (!pts.delete(e.pointerId)) return;
    if (pts.size) {
      // Nhấc một ngón sau khi chụm: ngón còn lại tiếp tục kéo.
      pinch = null;
      return;
    }
    const wasPinch = !!pinch;
    pinch = null;
    if (e.type === 'pointercancel' || wasPinch) return;
    const dx = e.clientX - start.x;
    if (!moved) {
      const now = Date.now();
      if (now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        lastTap.t = 0;
        if (scale > 1) reset();
        // Phóng tới mức ảnh lấp đầy chiều còn hở (ảnh dài mảnh thì cao bằng màn hình), ít nhất 2.5 lần.
        else zoomTo(Math.max(2.5, lb.clientWidth / img.clientWidth, lb.clientHeight / img.clientHeight), { x: e.clientX, y: e.clientY });
      } else lastTap = { t: now, x: e.clientX, y: e.clientY };
    } else if (scale === 1 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - start.y)) step(dx < 0 ? 1 : -1);
  };
  lb.addEventListener('pointerup', up);
  lb.addEventListener('pointercancel', up);
  lb.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomTo(scale * Math.exp(-e.deltaY * 0.002), { x: e.clientX, y: e.clientY });
  }, { passive: false });
  // Nghe phím ở document: bấm chuột vào ảnh làm focus rời lớp phủ, nghe trên lớp phủ thì Esc mất tác dụng.
  onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);
  show();
  document.body.append(lb);
  close.focus();
}

export function closeLightbox() {
  const lb = document.getElementById('lightbox');
  if (!lb) return;
  lb.remove();
  if (onKey) document.removeEventListener('keydown', onKey);
  onKey = null;
  lightboxReturn?.focus();
  lightboxReturn = null;
}
