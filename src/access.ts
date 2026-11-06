// Ai được vào agent/sidecar. Tiến trình chỉ nghe ở 127.0.0.1; máy khác và điện thoại vào qua một lớp chuyển tiếp HTTPS
// (Tailscale Serve, Cloudflare Tunnel, reverse proxy khác). Lớp đó phải cho biết người dùng là ai, và chỉ đúng `owner`
// trong machines.json được vào. Chọn lớp bằng `access.mode` trong machines.json:
// - tailscale (mặc định): header `Tailscale-User-Login` do `tailscale serve` gắn.
// - cloudflare: Cloudflare Tunnel + Cloudflare Access. Kiểm chữ ký JWT `Cf-Access-Jwt-Assertion` (hoặc cookie
//   `CF_Authorization`) theo khoá công khai của team, đúng `aud`, còn hạn, rồi so email.
// - proxy: reverse proxy bất kỳ đã tự xác thực người dùng (oauth2-proxy, Authelia, ngrok OAuth...) và gắn email vào
//   header `access.userHeader`. Proxy phải ghi đè header đó, không để client tự gửi.
// - local: không cho truy cập từ xa, chỉ dùng trên chính máy.
// Request đến thẳng từ chính máy (Host là localhost, không có header chuyển tiếp) luôn được nhận.

export type AccessMode = 'tailscale' | 'cloudflare' | 'proxy' | 'local';

export interface AccessConfig {
  mode?: AccessMode;
  /** mode proxy: tên header chứa email người dùng đã xác thực, vd X-Forwarded-Email. */
  userHeader?: string;
  /** mode cloudflare: tên miền team (vd myteam.cloudflareaccess.com) và Application Audience (AUD) tag. */
  cloudflare?: { teamDomain?: string; aud?: string };
}

const FORWARD_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'tailscale-user-login'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function accessMode(cfg?: AccessConfig): AccessMode {
  const m = cfg?.mode ?? 'tailscale';
  return (['tailscale', 'cloudflare', 'proxy', 'local'] as const).includes(m) ? m : 'local';
}

/** Request đến thẳng từ chính máy này, không qua lớp chuyển tiếp nào. */
export function isLocal(req: Request): boolean {
  if (FORWARD_HEADERS.some((h) => req.headers.has(h))) return false;
  const host = req.headers.get('host') ?? '';
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOCAL_HOSTS.has(name.toLowerCase());
}

// --- Cloudflare Access: kiểm JWT RS256 ----------------------------------------------------------------
const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
let jwks: { at: number; keys: Map<string, CryptoKey> } | null = null;

async function cfKey(teamDomain: string, kid: string): Promise<CryptoKey | undefined> {
  const fresh = jwks && Date.now() - jwks.at < 3600_000;
  if (!fresh || !jwks!.keys.has(kid)) {
    if (jwks && Date.now() - jwks.at < 30_000) return jwks.keys.get(kid); // kid lạ: không tải lại liên tục
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
    const body = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
    const keys = new Map<string, CryptoKey>();
    for (const k of body.keys ?? []) {
      if (k.kty !== 'RSA') continue;
      keys.set(k.kid, await crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    }
    jwks = { at: Date.now(), keys };
  }
  return jwks!.keys.get(kid);
}

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

async function cloudflareEmail(req: Request, cf: AccessConfig['cloudflare']): Promise<string | null> {
  if (!cf?.teamDomain || !cf.aud) return null;
  const token = req.headers.get('cf-access-jwt-assertion') ?? cookie(req, 'CF_Authorization');
  if (!token) return null;
  try {
    const [h, p, s] = token.split('.');
    const header = JSON.parse(new TextDecoder().decode(b64url(h)));
    if (header.alg !== 'RS256') return null;
    const key = await cfKey(cf.teamDomain, header.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64url(p)));
    const auds: string[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(cf.aud)) return null;
    if (claims.iss !== `https://${cf.teamDomain}`) return null;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
    return typeof claims.email === 'string' ? claims.email : null;
  } catch {
    return null;
  }
}

/** Email người dùng mà lớp chuyển tiếp xác nhận, hoặc null. */
export async function remoteUser(req: Request, cfg?: AccessConfig): Promise<string | null> {
  switch (accessMode(cfg)) {
    case 'tailscale':
      return req.headers.get('tailscale-user-login');
    case 'cloudflare':
      return cloudflareEmail(req, cfg?.cloudflare);
    case 'proxy':
      return cfg?.userHeader ? req.headers.get(cfg.userHeader) : null;
    default:
      return null;
  }
}

/** Được vào không: request từ chính máy, hoặc lớp chuyển tiếp xác nhận đúng chủ tài khoản. */
export async function isAllowed(req: Request, owner: string, cfg?: AccessConfig): Promise<boolean> {
  if (isLocal(req)) return true;
  const user = await remoteUser(req, cfg);
  return !!user && user.trim().toLowerCase() === owner.trim().toLowerCase();
}

/** Origin của trang gọi tới: localhost, hoặc đúng địa chỉ HTTPS của một máy trong danh sách. */
export function isOriginAllowed(req: Request, machineUrls: (string | undefined)[]): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (LOCAL_HOSTS.has(u.hostname)) return true;
    return machineUrls.some((m) => {
      if (!m) return false;
      try {
        return new URL(m).origin === u.origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
