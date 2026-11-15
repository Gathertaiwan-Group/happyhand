import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";

/**
 * 從一個公開網址抓圖（MCP 的 upload_image_from_url 用）。
 *
 * 設計照小時光書店 src/server/mcp/remote-image.ts 移植。抓回來的位元組之後交給
 * lib/admin/media-image.ts 的 processImage()（跟後台上傳同一支），這裡只負責「安全地抓」。
 *
 * ── SSRF ──────────────────────────────────────────────────────────────────
 * 網址是呼叫端（AI，可能被網頁內容注入）給的，所以：
 *   · 只收 https、預設 443、不帶帳密；主機名本身是 localhost／.local／.internal 直接擋
 *   · 主機名解析出來的**每一個**位址都必須是公開位址（擋 127.0.0.1／10.x／
 *     169.254.169.254 雲端 metadata，以及 IPv4-mapped／NAT64／6to4 這些把 IPv4 包在
 *     IPv6 裡的寫法）
 *   · **連線釘在驗過的那個 IP 上**（擋 DNS rebinding：驗的時候是公開 IP、連的時候變 127.0.0.1）
 *   · redirect 自己跟、每一跳重新解析重新檢查、最多 3 跳
 *   · 邊讀邊數，超過上限立刻斷線（不信 Content-Length）；15 秒逾時
 *   · 回應內容不信 Content-Type，交給呼叫端做 magic bytes 與 sharp 檢查
 */

export class RemoteImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteImageError";
  }
}

const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

/* ------------------------------------------------------------ 位址判斷 */

function isPrivateV4(p: number[]): boolean {
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local / 雲端 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (p[2] === 0 || p[2] === 2)) return true;
  if (a === 192 && b === 88 && p[2] === 99) return true; // 6to4 relay anycast（已廢止）
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && p[2] === 100) return true;
  if (a === 203 && b === 0 && p[2] === 113) return true;
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/**
 * IPv6 → 16 個 byte。支援 `::` 縮寫與結尾的點分 IPv4（`::ffff:127.0.0.1`）。
 * 去掉 zone id（`fe80::1%en0`）。格式不對回 null。
 */
export function parseIPv6(address: string): number[] | null {
  let s = address.toLowerCase().replace(/^\[|\]$/g, "");
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  let tail: number[] = [];
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const q = v4[2].split(".").map(Number);
    if (q.some((n) => !Number.isInteger(n) || n > 255)) return null;
    tail = [(q[0] << 8) | q[1], (q[2] << 8) | q[3]];
    s = v4[1].endsWith("::") ? v4[1] : v4[1].slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toHextets = (part: string) =>
    part === "" ? [] : part.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  const head = toHextets(halves[0]);
  const rest = halves.length === 2 ? toHextets(halves[1]) : [];
  const total = head.length + rest.length + tail.length;
  let hextets: number[];
  if (halves.length === 2) {
    if (total > 7) return null;
    hextets = [...head, ...new Array(8 - total).fill(0), ...rest, ...tail];
  } else {
    if (total !== 8) return null;
    hextets = [...head, ...tail];
  }
  if (hextets.some((h) => Number.isNaN(h))) return null;
  const bytes: number[] = [];
  for (const h of hextets) bytes.push(h >> 8, h & 0xff);
  return bytes;
}

function isPrivateV6(b: number[]): boolean {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const v4At = (i: number) => isPrivateV4(b.slice(i, i + 4));
  // ::/128、::1/128、以及整個 ::/96（IPv4-compatible，已廢止）
  if (zero(0, 12)) return true;
  // ::ffff:0:0/96 IPv4-mapped、::ffff:0:0:0/96 IPv4-translated —— 看裡面的 IPv4
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4At(12);
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && zero(10, 12)) return v4At(12);
  // 64:ff9b::/96 NAT64：看裡面的 IPv4；64:ff9b:1::/48 local-use NAT64 一律擋
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (zero(4, 12)) return v4At(12);
    return true;
  }
  // 2002::/16 6to4：第 2–5 byte 是 IPv4
  if (b[0] === 0x20 && b[1] === 0x02) return v4At(2);
  // 2001:0::/32 Teredo —— 一律擋
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true;
  // 2001:db8::/32 文件用
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;
  // 100::/64 discard
  if (b[0] === 0x01 && b[1] === 0x00 && zero(2, 8)) return true;
  if ((b[0] & 0xfe) === 0xfc) return true; // ULA fc00::/7
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // link-local fe80::/10
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // site-local fec0::/10
  if (b[0] === 0xff) return true; // multicast
  return false;
}

/** 這個位址是不是內網／本機／保留位址。不是合法 IP 一律當成不可連。 */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isPrivateV4(address.split(".").map(Number));
  if (kind === 6) {
    const b = parseIPv6(address);
    if (!b) return true;
    return isPrivateV6(b);
  }
  return true;
}

/** 主機名本身就明顯是內部的（不必解析 DNS 就能擋）。 */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (isIP(h)) return isPrivateAddress(h);
  return false;
}

export function assertUrlShape(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RemoteImageError("網址格式不正確");
  }
  if (url.protocol !== "https:") throw new RemoteImageError("只接受 https:// 開頭的圖片網址");
  if (url.username || url.password) throw new RemoteImageError("網址不可以帶帳號密碼");
  if (url.port && url.port !== "443") throw new RemoteImageError("只接受預設的 443 連接埠");
  if (isBlockedHostname(url.hostname)) throw new RemoteImageError("不接受內網或本機位址");
  return url;
}

type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

/** DNS 查詢不受 AbortController 控制（getaddrinfo 卡住時整體逾時蓋不到），自己包一層。 */
const DNS_TIMEOUT_MS = 5_000;

const defaultResolver: Resolver = (host) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("dns timeout")), DNS_TIMEOUT_MS);
    lookup(host, { all: true, verbatim: true }).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });

/** 解析主機名並驗證**每一個**位址都是公開位址，回第一個（之後連線就釘在它上面）。 */
export async function resolvePublic(
  hostname: string,
  resolver: Resolver = defaultResolver,
): Promise<{ address: string; family: number }> {
  const host = hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new RemoteImageError(`查不到主機 ${hostname}`);
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new RemoteImageError("不接受內網或本機位址");
  }
  return addresses[0];
}

/* ---------------------------------------------------------------- 抓取 */

type Hop = { status: number; location: string | null; body: Uint8Array | null };

function tooLarge(maxBytes: number) {
  return new RemoteImageError(
    `圖片超過上限 ${Math.round(maxBytes / 1024 / 1024)}MB。請提供較小的版本（長邊 2000px 以內的 JPEG／WebP 最理想）。`,
  );
}

/**
 * 一跳 HTTPS GET，連線**釘在已驗證的那個位址上**：`lookup` 選項讓 socket 用我們
 * 驗過的 IP，而不是再解析一次 DNS（那一次可能被 rebinding 成 127.0.0.1）。
 * TLS 的 SNI／憑證驗證仍然用原本的主機名。
 */
function getPinned(
  url: URL,
  pinned: { address: string; family: number },
  maxBytes: number,
  signal: AbortSignal,
): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "GET",
        signal,
        headers: { accept: "image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.1" },
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          if (opts && opts.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
          else cb(null, pinned.address, pinned.family);
        }) as never,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, location: (res.headers.location as string | undefined) ?? null, body: null });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          resolve({ status, location: null, body: null });
          return;
        }
        const declared = Number(res.headers["content-length"] ?? "0");
        if (declared > maxBytes) {
          res.destroy();
          reject(tooLarge(maxBytes));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.byteLength;
          if (total > maxBytes) {
            res.destroy();
            reject(tooLarge(maxBytes));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status, location: null, body: new Uint8Array(Buffer.concat(chunks)) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export type FetchedImage = { bytes: Buffer; finalUrl: string };

export async function fetchRemoteImage(raw: string, maxBytes: number): Promise<FetchedImage> {
  let url = assertUrlShape(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let hop: Hop | null = null;
    for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
      const pinned = await resolvePublic(url.hostname);
      hop = await getPinned(url, pinned, maxBytes, controller.signal);
      if (hop.status >= 300 && hop.status < 400) {
        if (!hop.location) throw new RemoteImageError(`圖片網址轉址了但沒有目的地（${hop.status}）`);
        url = assertUrlShape(new URL(hop.location, url).href);
        hop = null;
        continue;
      }
      break;
    }
    if (!hop) throw new RemoteImageError("轉址太多次（超過 3 次）");
    if (!hop.body) throw new RemoteImageError(`抓圖失敗：對方回 ${hop.status}`);
    if (hop.body.byteLength === 0) throw new RemoteImageError("圖片是空的");
    return { bytes: Buffer.from(hop.body), finalUrl: url.href };
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || controller.signal.aborted)) {
      throw new RemoteImageError("抓圖逾時（超過 15 秒）");
    }
    if (err instanceof RemoteImageError) throw err;
    // 不把原始錯誤（ECONNREFUSED x.x.x.x、TLS 細節）回給呼叫端：那等於多給一個探測內網的訊號。
    console.error("[remote-image] 抓圖失敗", err);
    throw new RemoteImageError("抓圖失敗：連不上對方伺服器，或對方的憑證不正確。請確認網址可以在瀏覽器直接打開。");
  } finally {
    clearTimeout(timer);
  }
}
