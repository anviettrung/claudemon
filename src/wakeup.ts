// Đánh thức cửa sổ 5 giờ của Claude.
//
// Cửa sổ 5 giờ chỉ bắt đầu đếm khi có tin nhắn đầu tiên. Agent gửi một request tí hon (Haiku, max_tokens 1,
// nội dung ".") ngay khi cửa sổ cũ hết, để đồng hồ luôn chạy. Request đó vừa là "poke" vừa là "probe": header
// `anthropic-ratelimit-unified-*` của nó trả về % đã dùng và giờ reset chính xác của cửa sổ 5 giờ và 7 ngày.
//
// Mốc neo hằng ngày: 5 giờ không chia hết 24 nên nhịp trôi muộn ~1 tiếng mỗi ngày. Luật: không bao giờ MỞ cửa
// sổ mới trong giờ nghỉ (quietFrom → mốc poke = dailyResetAt − windowHours). Lần poke đầu sau giờ nghỉ rơi đúng
// mốc, nên ngày nào cũng reset đúng dailyResetAt.
//
// Khác ai-wake-up: khi cửa sổ đã hết mà đang trong giờ nghỉ thì KHÔNG probe (probe chính là poke, sẽ mở cửa sổ).
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { UsageInfo, UsagePhase } from './protocol.ts';

export interface WakeConfig {
  enabled?: boolean;
  // Giờ muốn cửa sổ reset mỗi ngày ("10:30"); bỏ trống thì poke ngay khi reset, không có giờ nghỉ.
  dailyResetAt?: string;
  quietFrom?: string;
  windowHours?: number;
  probeModel?: string;
}

interface Snapshot {
  fetchedAt: number;
  fiveHour: number | null;
  resetsAt: number | null;
  weekly: number | null;
  weeklyResetsAt: number | null;
  status: string | null;
}

interface Saved {
  snap?: Snapshot;
  lastPoke?: { at: number; ok: boolean; why: string };
}

const BUFFER_MS = 20_000; // đợi thêm sau mốc reset cho chắc
const RETRY_MS = 2 * 60_000; // probe lỗi thì thử lại sau 2 phút
const TTL_WATCHED = 2 * 60_000; // có người đang xem: làm mới số mỗi 2 phút
const TTL_IDLE = 5 * 60_000; // không ai xem: 5 phút như ai-wake-up
const TICK_MS = 15_000;
const DAY_MIN = 24 * 60;

// "10:30", "7", "5:30am" -> phút trong ngày; sai thì null.
export function parseTimeOfDay(text?: string): number | null {
  const m = /^(\d{1,2})(?::(\d{1,2}))?\s*([ap]m)?$/i.exec((text ?? '').trim());
  if (!m) return null;
  let h = Number(m[1]);
  const i = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === 'am') h = h === 12 ? 0 : h;
    else if (h !== 12) h += 12;
  }
  if (h > 23 || i > 59) return null;
  return h * 60 + i;
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const minuteOf = (ms: number) => {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
};

interface Schedule {
  resetAt: number;
  pokeAt: number;
  quietFrom: number;
}

export function resolveSchedule(cfg: WakeConfig): Schedule | null {
  const resetAt = parseTimeOfDay(cfg.dailyResetAt);
  if (resetAt === null) return null;
  const hours = cfg.windowHours && cfg.windowHours > 0 && cfg.windowHours < 24 ? cfg.windowHours : 5;
  const pokeAt = (((resetAt - Math.round(hours * 60)) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  const quietFrom = parseTimeOfDay(cfg.quietFrom ?? '00:00') ?? 0;
  return { resetAt, pokeAt, quietFrom };
}

// Giờ nghỉ chạy từ quietFrom tới (không gồm) mốc poke, được vắt qua nửa đêm.
export function inQuiet(s: Schedule | null, ms: number): boolean {
  if (!s || s.quietFrom === s.pokeAt) return false;
  const t = minuteOf(ms);
  return s.quietFrom < s.pokeAt ? t >= s.quietFrom && t < s.pokeAt : t >= s.quietFrom || t < s.pokeAt;
}

export function nextAnchor(s: Schedule, ms: number): number {
  const d = new Date(ms);
  d.setHours(Math.floor(s.pokeAt / 60), s.pokeAt % 60, 0, 0);
  if (d.getTime() <= ms) d.setDate(d.getDate() + 1);
  return d.getTime();
}

async function readJson(path: string): Promise<any> {
  try {
    return await Bun.file(path).json();
  } catch {
    return null;
  }
}

export class ClaudeWaker {
  private saved: Saved = {};
  private sched: Schedule | null;
  private busy: Promise<void> | null = null;
  private backoffUntil = 0;
  private lastError: string | undefined;
  private account: { id?: string; email?: string } = {};

  constructor(
    private cfg: WakeConfig,
    private statePath: string,
    private claudePath: string | undefined,
    private watched: () => boolean,
    private onChange: (u: UsageInfo) => void,
  ) {
    this.sched = resolveSchedule(cfg);
  }

  get enabled() {
    return this.cfg.enabled !== false;
  }

  async init() {
    this.saved = (await readJson(this.statePath)) ?? {};
    await this.readAccount();
    if (!this.enabled) return;
    const s = this.sched;
    console.log(
      s
        ? `[wakeup] claude: reset ${hhmm(s.resetAt)} mỗi ngày, poke ${hhmm(s.pokeAt)}, nghỉ ${hhmm(s.quietFrom)}–${hhmm(s.pokeAt)}`
        : '[wakeup] claude: không có mốc neo, poke ngay khi reset',
    );
    setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  private async readAccount() {
    const j = await readJson(resolve(homedir(), '.claude.json'));
    this.account = { id: j?.oauthAccount?.accountUuid, email: j?.oauthAccount?.emailAddress };
  }

  isActive() {
    return this.active(Date.now());
  }

  private active(now: number) {
    const r = this.saved.snap?.resetsAt;
    return !!r && now < r + BUFFER_MS;
  }

  // Hết hạn mức tuần thì poke cũng vô ích tới khi tuần lật.
  private weeklySpent(now: number) {
    const s = this.saved.snap;
    return !!s && (s.weekly ?? 0) >= 100 && !!s.weeklyResetsAt && s.weeklyResetsAt > now;
  }

  private async tick() {
    if (this.busy || !this.enabled) return;
    const now = Date.now();
    if (now < this.backoffUntil) return;
    const snap = this.saved.snap;
    if (this.active(now)) {
      // Cửa sổ đang mở: probe không mở thêm gì, chỉ làm mới số.
      if (!snap || now - snap.fetchedAt >= (this.watched() ? TTL_WATCHED : TTL_IDLE)) await this.run('refresh');
      return;
    }
    if (this.weeklySpent(now)) return;
    // Cửa sổ đã hết (hoặc chưa biết): trong giờ nghỉ thì giữ lại tới mốc, ngoài giờ nghỉ thì mở ngay.
    if (inQuiet(this.sched, now)) return;
    const last = this.saved.lastPoke;
    if (last && now - last.at < (last.ok ? 60_000 : RETRY_MS)) return;
    const why = snap?.resetsAt ? `cửa sổ hết lúc ${new Date(snap.resetsAt).toLocaleTimeString('vi-VN')}` : 'chưa có cửa sổ';
    await this.run('poke', why);
  }

  // Probe (cũng là poke). Chạy một lần một lúc; lỗi thì giữ số cũ, không bịa số mới.
  run(kind: 'refresh' | 'poke', why = 'tay'): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      const opening = !this.active(Date.now());
      const r = await this.probe(true);
      const now = Date.now();
      if ('error' in r) {
        this.lastError = r.error;
        this.backoffUntil = now + (r.error.startsWith('Không có token') ? 10 * RETRY_MS : RETRY_MS);
        console.log(`[wakeup] claude: probe lỗi (${kind}): ${r.error}`);
      } else {
        this.lastError = undefined;
        this.backoffUntil = 0;
        this.saved.snap = r;
        // Probe xong mà vẫn không thấy cửa sổ mở (header lạ): đừng gọi lại mỗi 15 giây.
        if (!this.active(now)) this.backoffUntil = now + RETRY_MS;
      }
      if (opening) {
        // Cửa sổ còn gần đủ 5 giờ nghĩa là chính request này vừa mở nó; còn ít hơn là nơi khác đã mở sẵn.
        const windowMs = (this.cfg.windowHours || 5) * 3600_000;
        const fresh = !('error' in r) && !!r.resetsAt && r.resetsAt - now > windowMs - 5 * 60_000;
        if ('error' in r || fresh) this.saved.lastPoke = { at: now, ok: fresh, why };
        if (!('error' in r))
          console.log(
            `[wakeup] claude: ${fresh ? `poke (${why})` : 'cửa sổ đã mở sẵn'} → ${r.fiveHour ?? '?'}%, reset ${r.resetsAt ? new Date(r.resetsAt).toLocaleString('vi-VN') : '?'}`,
          );
      }
      await Bun.write(this.statePath, JSON.stringify(this.saved, null, 2)).catch(() => {});
      this.onChange(this.info());
    })().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async probe(allowRefresh: boolean): Promise<Snapshot | { error: string }> {
    let token: string | undefined;
    const cred = await readJson(resolve(homedir(), '.claude', '.credentials.json'));
    token = cred?.claudeAiOauth?.accessToken;
    if (!token) return { error: 'Không có token OAuth trong ~/.claude/.credentials.json' };
    let res: Response;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-client-platform': 'claude_cli',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.cfg.probeModel || 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: '.' }],
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      return { error: `Không gọi được API: ${(err as Error).message}` };
    }
    void res.body?.cancel();
    const snap = parseHeaders(res.headers);
    if (snap) {
      if (res.status === 429) snap.status = 'rejected';
      return snap;
    }
    // Token hết hạn: chỉ CLI làm mới được. Cho nó chạy một lượt thật (ghi lại .credentials.json) rồi probe lại.
    if (res.status === 401 && allowRefresh && this.claudePath) {
      console.log('[wakeup] claude: token hết hạn, nhờ claude -p làm mới');
      const p = Bun.spawn([this.claudePath, '-p', '.', '--no-session-persistence', '--model', 'haiku'], {
        stdout: 'ignore',
        stderr: 'ignore',
        stdin: 'ignore',
      });
      const timer = setTimeout(() => p.kill(), 120_000);
      await p.exited;
      clearTimeout(timer);
      await this.readAccount();
      return this.probe(false);
    }
    return { error: res.status === 429 ? 'Hết hạn mức (429, không có header)' : `API trả ${res.status} không kèm số liệu` };
  }

  info(): UsageInfo {
    const now = Date.now();
    const s = this.saved.snap;
    const sched = this.sched;
    const quietNow = inQuiet(sched, now);
    let phase: UsagePhase;
    if (!this.enabled) phase = 'off';
    else if (this.active(now)) phase = s?.status === 'rejected' ? 'blocked' : 'active';
    else if (this.weeklySpent(now)) phase = 'blocked';
    else if (!s && this.lastError) phase = 'unknown';
    else phase = quietNow ? 'quiet' : 'idle';

    // Lần tự poke kế tiếp: hết cửa sổ (+đệm), dời tới mốc nếu rơi vào giờ nghỉ.
    let nextPokeAt: number | undefined;
    if (phase === 'active' || phase === 'blocked' || phase === 'quiet' || phase === 'idle') {
      let t = phase === 'blocked' && this.weeklySpent(now) ? s!.weeklyResetsAt! : this.active(now) ? s!.resetsAt! + BUFFER_MS : now;
      if (sched && inQuiet(sched, t)) t = nextAnchor(sched, t);
      nextPokeAt = t;
    }
    return {
      provider: 'claude',
      enabled: this.enabled,
      account: this.account.id,
      email: this.account.email,
      phase,
      fetchedAt: s?.fetchedAt,
      fiveHour: s?.fiveHour ?? undefined,
      resetsAt: s?.resetsAt ?? undefined,
      weekly: s?.weekly ?? undefined,
      weeklyResetsAt: s?.weeklyResetsAt ?? undefined,
      status: s?.status ?? undefined,
      error: this.lastError,
      lastPoke: this.saved.lastPoke ? { at: this.saved.lastPoke.at, ok: this.saved.lastPoke.ok } : undefined,
      nextPokeAt,
      schedule: sched ? { resetAt: hhmm(sched.resetAt), pokeAt: hhmm(sched.pokeAt), quietFrom: hhmm(sched.quietFrom), quietNow } : undefined,
    };
  }
}

function parseHeaders(h: Headers): Snapshot | null {
  const num = (k: string) => {
    const v = h.get(`anthropic-ratelimit-unified-${k}`);
    return v === null || v === '' || isNaN(Number(v)) ? null : Number(v);
  };
  const u5 = num('5h-utilization');
  const r5 = num('5h-reset') ?? num('reset');
  if (u5 === null && r5 === null) return null;
  const u7 = num('7d-utilization');
  const r7 = num('7d-reset');
  const pct = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 10);
  return {
    fetchedAt: Date.now(),
    fiveHour: pct(u5),
    resetsAt: r5 === null ? null : r5 * 1000,
    weekly: pct(u7),
    weeklyResetsAt: r7 === null ? null : r7 * 1000,
    status: h.get('anthropic-ratelimit-unified-5h-status') ?? h.get('anthropic-ratelimit-unified-status'),
  };
}
