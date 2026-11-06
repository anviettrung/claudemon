// Chụp màn hình giao diện SessionMon (thường là bản xem trước scripts/ui-preview.ts) bằng Chrome headless qua DevTools
// Protocol: giả lập đúng cỡ điện thoại, sáng / tối, từng theme.
//   bun run scripts/ui-shots.ts [thư mục ra] [url]
// Mặc định: url http://127.0.0.1:7430/#Z/s1, thư mục ra %TEMP%\sessionmon-shots.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const out = process.argv[2] ?? join(tmpdir(), 'sessionmon-shots');
const url = process.argv[3] ?? 'http://127.0.0.1:7430/#Z/s1';
mkdirSync(out, { recursive: true });

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find((p) => Bun.file(p).size > 0);
if (!chrome) throw new Error('Không thấy Chrome hay Edge');
const dbg = 9339;
const proc = Bun.spawn([chrome, '--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${dbg}`,
  `--user-data-dir=${join(tmpdir(), 'sessionmon-shots-profile')}`, 'about:blank'], { stdout: 'ignore', stderr: 'ignore' });

let page: { webSocketDebuggerUrl: string } | undefined;
for (let i = 0; i < 50 && !page; i++) {
  await Bun.sleep(200);
  page = await fetch(`http://127.0.0.1:${dbg}/json/list`).then((r) => r.json()).then((l: any[]) => l.find((t) => t.type === 'page')).catch(() => undefined);
}
if (!page) throw new Error('Chrome không mở cổng debug');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const waiting = new Map<number, (v: any) => void>();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && waiting.has(m.id)) waiting.get(m.id)!(m.result ?? m.error);
};
const cdp = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((r) => {
    const id = ++seq;
    waiting.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const js = (expression: string) => cdp('Runtime.evaluate', { expression, awaitPromise: true });

const devices = {
  phone: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
  pc: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
};
const themes = (process.env.SHOT_THEMES ?? 'claude,retro,aero').split(',');
const schemes = ['light', 'dark'];

await cdp('Page.enable');
for (const [dname, dev] of Object.entries(devices)) {
  await cdp('Emulation.setDeviceMetricsOverride', dev);
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: dev.mobile });
  for (const theme of themes) {
    for (const scheme of schemes) {
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await cdp('Page.navigate', { url });
      await Bun.sleep(400);
      await js(`localStorage.setItem('sessionmon:theme', JSON.stringify({ style: '${theme}', scheme: 'auto' }))`);
      await cdp('Page.reload');
      await Bun.sleep(1500);
      const shots = dev.mobile ? ['chat', 'list'] : ['chat'];
      for (const screen of shots) {
        if (screen === 'list') {
          await js(`document.getElementById('backBtn').click()`);
          await Bun.sleep(600);
        }
        // SHOT_EVAL: đoạn JS chạy trước khi chụp (vd mở một menu) để xem trạng thái khác.
        if (process.env.SHOT_EVAL && screen === 'chat') {
          await js(process.env.SHOT_EVAL);
          await Bun.sleep(400);
        }
        const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
        const file = join(out, `${dname}-${theme}-${scheme}-${screen}.png`);
        await Bun.write(file, Buffer.from(data, 'base64'));
        console.log(file);
      }
    }
  }
}
ws.close();
proc.kill();
