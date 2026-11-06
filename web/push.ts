// Thông báo đẩy trên thiết bị này (src/push.ts ở agent): đăng ký với agent của máy phục vụ trang, báo cho agent biết
// lúc đang mở app trên màn hình để khỏi đẩy trùng với thẻ báo trong app.

export const push = {
  supported: false,
  on: false,
  endpoint: '',
  // iPhone / iPad chỉ nhận thông báo đẩy khi mở ClaudeMon từ màn hình chính (PWA đã cài).
  needsInstall: false,
};

async function post(path: string, body: unknown) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

async function serverKey(endpoint = ''): Promise<{ publicKey: string; subscribed: boolean }> {
  const res = await fetch(`/api/push/key?endpoint=${encodeURIComponent(endpoint)}`);
  if (!res.ok) throw new Error('Agent chưa hỗ trợ thông báo đẩy');
  return res.json();
}

function keyBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i]);

function deviceName(): string {
  const ua = navigator.userAgent;
  const kind = /iPhone/.test(ua) ? 'iPhone' : /iPad|Macintosh.*Mobile/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Thiết bị';
  const app = matchMedia('(display-mode: standalone)').matches ? 'app' : 'trình duyệt';
  return `${kind} (${app})`;
}

function sendPresence(visible: boolean) {
  if (!push.on) return;
  const body = JSON.stringify({ endpoint: push.endpoint, visible });
  // Rời app: dùng sendBeacon để kịp gửi trước khi trang bị treo.
  if (!visible && navigator.sendBeacon?.('/api/push/presence', new Blob([body], { type: 'application/json' }))) return;
  void fetch('/api/push/presence', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

const visibleNow = () => document.visibilityState === 'visible';

export async function setupPush(onOpen: (url: string) => void) {
  const ios = /iPhone|iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  push.needsInstall = ios && !matchMedia('(display-mode: standalone)').matches;
  push.supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!('serviceWorker' in navigator)) return;
  // Bấm thông báo khi app đang mở: service worker nhờ trang mở đúng session.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open' && typeof e.data.url === 'string') onOpen(e.data.url);
  });
  document.addEventListener('visibilitychange', () => sendPresence(visibleNow()));
  window.addEventListener('pagehide', () => sendPresence(false));
  window.addEventListener('focus', () => sendPresence(true));
  setInterval(() => visibleNow() && sendPresence(true), 25_000);
  if (!push.supported) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub || Notification.permission !== 'granted') return;
    const { publicKey, subscribed } = await serverKey(sub.endpoint);
    if (!sameKey(sub.options.applicationServerKey, keyBytes(publicKey))) {
      // Agent đổi khoá (vd cài lại): đăng ký lại bằng khoá mới.
      await sub.unsubscribe();
      await enablePush();
      return;
    }
    if (!subscribed) await post('/api/push/subscribe', { subscription: sub.toJSON(), device: deviceName() });
    push.on = true;
    push.endpoint = sub.endpoint;
    sendPresence(visibleNow());
  } catch {}
}

export async function enablePush() {
  if (push.needsInstall) throw new Error('Trên iPhone: chia sẻ → Thêm vào màn hình chính, rồi mở ClaudeMon từ đó để bật thông báo');
  if (!push.supported) throw new Error('Trình duyệt này không hỗ trợ thông báo đẩy');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Chưa cho phép thông báo. Bật lại trong cài đặt của trình duyệt / điện thoại');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await serverKey();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource }));
  await post('/api/push/subscribe', { subscription: sub.toJSON(), device: deviceName() });
  push.on = true;
  push.endpoint = sub.endpoint;
  sendPresence(visibleNow());
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  const endpoint = sub?.endpoint ?? push.endpoint;
  await sub?.unsubscribe().catch(() => {});
  if (endpoint) await post('/api/push/unsubscribe', { endpoint }).catch(() => {});
  push.on = false;
  push.endpoint = '';
}

export async function testPush() {
  await post('/api/push/test', { endpoint: push.endpoint });
}
