// Thông báo đẩy (Web Push) tới điện thoại và máy tính khi session xong lượt hoặc cần duyệt, kể cả khi app đã đóng.
//
// Thiết bị đăng ký với agent của máy phục vụ trang (origin của PWA), vì đăng ký gắn với origin và khoá VAPID của
// agent đó. Agent này theo dõi sự kiện của chính nó và của các máy khác (nối WebSocket tới agent máy khác như
// giao diện vẫn làm), rồi gửi thông báo cho mọi thiết bị đã đăng ký, trừ thiết bị đang mở app trên màn hình.
import webpush, { type PushSubscription } from 'web-push';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { MachineInfo, ServerEvent, SessionSummary } from './protocol.ts';

interface Keys {
  publicKey: string;
  privateKey: string;
}

interface Sub {
  subscription: PushSubscription;
  device: string;
  addedAt: number;
}

export interface PushPayload {
  title: string;
  body: string;
  // Gộp thông báo cùng session (cái mới thay cái cũ).
  tag: string;
  // Mở app tại đây khi bấm (vd /#Z/<sessionId>).
  url: string;
}

// Thiết bị báo "đang mở app trên màn hình" mỗi 25 giây; quá hạn này coi như đã rời app.
const PRESENCE_MS = 60_000;

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} giây`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} phút ${s % 60} giây` : `${m} phút`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} giờ ${m % 60} phút` : `${h} giờ`;
}

export class PushHub {
  private keys: Keys;
  private subs = new Map<string, Sub>();
  private presence = new Map<string, number>();
  private peerSessions = new Map<string, SessionSummary[]>();
  private peers = new Map<string, WebSocket>();
  // Yêu cầu duyệt đã báo (agent phát lại yêu cầu đang chờ mỗi khi nối lại WebSocket).
  private asked = new Set<string>();

  constructor(
    private keysFile: string,
    private subsFile: string,
    private self: MachineInfo,
    private others: MachineInfo[],
    // Tiêu đề hiển thị (tên tự đặt trong thư viện, không thì tên Claude Code).
    private titleOf: (machine: string, id: string, fallback?: string) => string,
    private localSessions: () => Promise<SessionSummary[]>,
  ) {
    if (existsSync(keysFile)) this.keys = JSON.parse(readFileSync(keysFile, 'utf8'));
    else {
      this.keys = webpush.generateVAPIDKeys();
      writeFileSync(keysFile, JSON.stringify(this.keys, null, 2));
    }
    if (existsSync(subsFile)) {
      try {
        for (const s of JSON.parse(readFileSync(subsFile, 'utf8')) as Sub[]) this.subs.set(s.subscription.endpoint, s);
      } catch {}
    }
    this.syncPeers();
  }

  get publicKey() {
    return this.keys.publicKey;
  }

  has(endpoint: string) {
    return this.subs.has(endpoint);
  }

  subscribe(subscription: PushSubscription, device: string) {
    if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) throw new Error('Đăng ký không hợp lệ');
    if (!/^https:\/\//.test(subscription.endpoint)) throw new Error('Endpoint không hợp lệ');
    this.subs.set(subscription.endpoint, { subscription, device: device.slice(0, 80), addedAt: Date.now() });
    this.save();
    this.syncPeers();
  }

  unsubscribe(endpoint: string) {
    if (this.subs.delete(endpoint)) this.save();
    this.presence.delete(endpoint);
    this.syncPeers();
  }

  setPresence(endpoint: string, visible: boolean) {
    if (visible) this.presence.set(endpoint, Date.now());
    else this.presence.delete(endpoint);
  }

  async test(endpoint: string) {
    const s = this.subs.get(endpoint);
    if (!s) throw new Error('Thiết bị này chưa bật thông báo');
    await this.sendOne(s, { title: 'SessionMon', body: `Thông báo từ máy ${this.self.name} đã chạy.`, tag: 'sessionmon-test', url: '/' });
  }

  // Sự kiện của chính máy này (gọi từ broadcast của agent).
  onLocal(e: ServerEvent) {
    void this.onEvent(this.self.name, e, true);
  }

  private async onEvent(machine: string, e: ServerEvent, local: boolean) {
    if (e.type === 'sessions') {
      if (!local) this.peerSessions.set(machine, e.sessions);
      return;
    }
    if (!this.subs.size || (e.type !== 'result' && e.type !== 'permission')) return;
    if (e.type === 'permission') {
      if (this.asked.has(e.ask.requestId)) return;
      this.asked.add(e.ask.requestId);
      if (this.asked.size > 500) this.asked.delete(this.asked.values().next().value!);
    }
    const sessionId = e.type === 'result' ? e.sessionId : e.ask.sessionId;
    const list = local ? await this.localSessions() : (this.peerSessions.get(machine) ?? []);
    const title = this.titleOf(machine, sessionId, list.find((s) => s.id === sessionId)?.title);
    const base = { tag: `${machine}:${sessionId}`, url: `/#${encodeURIComponent(machine)}/${sessionId}` };
    let p: PushPayload;
    if (e.type === 'result') {
      // Bị ngắt (người dùng bấm dừng) thì không báo.
      if (!e.ok && e.error === 'error_during_execution') return;
      const took = e.durationMs ? ` · làm trong ${formatDuration(e.durationMs)}` : '';
      p = e.ok
        ? { ...base, title: `✓ Xong: ${title}`, body: `Máy ${machine}${took}` }
        : { ...base, title: `⚠ Lỗi: ${title}`, body: `Máy ${machine} · ${e.error ?? 'không rõ'}` };
    } else {
      const tool = e.ask.toolName;
      const what =
        tool === 'AskUserQuestion' ? 'Claude đang hỏi' : tool === 'ExitPlanMode' ? 'Cần duyệt kế hoạch' : `Cần duyệt: ${tool.replace(/^mcp__.+?__/, '')}`;
      p = { ...base, title: `${what} · ${title}`, body: `Máy ${machine}${e.ask.title ? ' · ' + e.ask.title : ''}` };
    }
    await this.send(p);
  }

  private async send(p: PushPayload) {
    const now = Date.now();
    await Promise.all(
      [...this.subs.values()].map((s) => {
        // Thiết bị đang mở app thì giao diện tự báo trong app.
        if (now - (this.presence.get(s.subscription.endpoint) ?? 0) < PRESENCE_MS) return;
        return this.sendOne(s, p).catch(() => {});
      }),
    );
  }

  private async sendOne(s: Sub, p: PushPayload) {
    try {
      await webpush.sendNotification(s.subscription, JSON.stringify(p), {
        vapidDetails: { subject: this.self.url ?? 'mailto:sessionmon@example.com', ...this.keys },
        TTL: 6 * 3600,
        urgency: 'high',
        topic: p.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(-32),
      });
    } catch (err: any) {
      // Thiết bị đã gỡ app hoặc tắt quyền: bỏ đăng ký.
      if (err?.statusCode === 404 || err?.statusCode === 410) this.unsubscribe(s.subscription.endpoint);
      else console.log(`[push] gửi tới ${s.device} lỗi: ${err?.statusCode ?? ''} ${err?.body ?? err?.message ?? err}`);
      throw err;
    }
  }

  private save() {
    writeFileSync(this.subsFile, JSON.stringify([...this.subs.values()], null, 2));
  }

  // Chỉ nối tới agent máy khác khi có thiết bị đăng ký.
  private syncPeers() {
    const want = this.subs.size > 0 && !!this.self.url;
    for (const m of this.others) {
      if (!m.url) continue;
      if (want && !this.peers.has(m.name)) this.connectPeer(m, 0);
      if (!want && this.peers.has(m.name)) {
        const ws = this.peers.get(m.name)!;
        this.peers.delete(m.name);
        ws.close();
      }
    }
  }

  private connectPeer(m: MachineInfo, retry: number) {
    // Agent máy kia chỉ nhận Origin là địa chỉ tailnet của các máy trong machines.json.
    const ws = new WebSocket(m.url!.replace(/^http/, 'ws') + '/ws', { headers: { origin: this.self.url! } } as any);
    this.peers.set(m.name, ws);
    ws.onopen = () => (retry = 0);
    ws.onmessage = (ev) => {
      try {
        void this.onEvent(m.name, JSON.parse(String(ev.data)) as ServerEvent, false);
      } catch {}
    };
    ws.onclose = () => {
      if (this.peers.get(m.name) !== ws) return;
      this.peers.delete(m.name);
      this.peerSessions.delete(m.name);
      setTimeout(() => {
        if (this.subs.size && !this.peers.has(m.name)) this.connectPeer(m, retry + 1);
      }, Math.min(60_000, 2000 * 2 ** retry));
    };
  }
}
