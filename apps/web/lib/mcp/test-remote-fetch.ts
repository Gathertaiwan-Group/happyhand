/**
 * content-tools-flow.test.ts 專用：頂替 @/lib/admin/remote-image（不連網）。
 *
 * 網址形狀檢查（https、內網、帳密）沿用真的 assertUrlShape —— 但這個檔被 alias 成
 * @/lib/admin/remote-image 之後不能再從同一路徑 import，所以這裡只做最小的模擬：
 * 測試把「網址 → 回應」放進 globalThis.__remote，沒放的網址一律當成連不上。
 * 真正的 SSRF 防護由 remote-image.test.ts 與 content-tools.test.ts 驗證。
 */

export class RemoteImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteImageError";
  }
}

export type FetchedImage = { bytes: Buffer; finalUrl: string };

type Remote = { calls: string[]; files: Record<string, { bytes: Buffer; finalUrl?: string }> };

export function remote(): Remote {
  const g = globalThis as unknown as { __remote?: Remote };
  g.__remote ??= { calls: [], files: {} };
  return g.__remote;
}

export async function fetchRemoteImage(raw: string, maxBytes: number): Promise<FetchedImage> {
  const r = remote();
  r.calls.push(raw);
  if (!raw.startsWith("https://")) throw new RemoteImageError("只接受 https:// 開頭的圖片網址");
  const f = r.files[raw];
  if (!f) throw new RemoteImageError("抓圖失敗：對方回 404");
  if (f.bytes.byteLength > maxBytes) throw new RemoteImageError("圖片太大");
  return { bytes: f.bytes, finalUrl: f.finalUrl ?? raw };
}
