/**
 * lib/admin/remote-image.ts（MCP upload_image_from_url 的 SSRF 防線）與
 * lib/admin/media.ts#sniffImageFormat 的單元測試。
 *
 * 跑法（repo 根目錄）：
 *
 *   echo "" > /tmp/empty.js
 *   node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     apps/web/lib/admin/remote-image.test.ts --bundle --platform=node --format=esm \
 *     --alias:@=./apps/web --alias:server-only=/tmp/empty.js --outfile=/tmp/remote-image.test.mjs
 *   node --test /tmp/remote-image.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertUrlShape,
  fetchRemoteImage,
  isBlockedHostname,
  isPrivateAddress,
  resolvePublic,
  RemoteImageError,
} from "./remote-image";
import { sniffImageFormat } from "./media";

test("內網、本機、保留位址一律視為不可連", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // 雲端 metadata
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "::ffff:127.0.0.1", // IPv4-mapped
    "::ffff:7f00:1",
    "64:ff9b::a9fe:a9fe", // NAT64 包 169.254.169.254
    "2002:7f00:0001::1", // 6to4 包 127.0.0.1
    "fc00::1",
    "fd12:3456::1",
    "fe80::1%en0",
    "2001:db8::1",
    "not-an-ip",
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("網址形狀：只收 https、443、不帶帳密、不收內部主機名", () => {
  const bad = [
    "http://example.com/a.jpg",
    "file:///etc/passwd",
    "ftp://example.com/a.jpg",
    "https://user:pw@example.com/a.jpg",
    "https://example.com:8443/a.jpg",
    "https://localhost/a.jpg",
    "https://foo.localhost/a.jpg",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://printer.local/a.jpg",
    "https://127.0.0.1/a.jpg",
    "https://[::1]/a.jpg",
    "https://169.254.169.254/latest/meta-data/",
    "https://0x7f000001/a.jpg", // URL 會把它正規化成 127.0.0.1
    "https://2130706433/a.jpg",
    "not a url",
  ];
  for (const u of bad) assert.throws(() => assertUrlShape(u), RemoteImageError, u);
  assert.equal(assertUrlShape("https://images.example.com/a.jpg").hostname, "images.example.com");
  assert.equal(isBlockedHostname("example.com"), false);
});

test("DNS：解析出來只要有一個是內網位址就整個拒絕（含 rebinding 式的混合回應）", async () => {
  const resolver = (addrs: string[]) => async () => addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  await assert.rejects(resolvePublic("evil.example", resolver(["93.184.216.34", "127.0.0.1"])), RemoteImageError);
  await assert.rejects(resolvePublic("evil.example", resolver(["::ffff:10.0.0.1"])), RemoteImageError);
  await assert.rejects(resolvePublic("evil.example", resolver([])), RemoteImageError);
  await assert.rejects(
    resolvePublic("evil.example", async () => {
      throw new Error("ENOTFOUND");
    }),
    /查不到主機/,
  );
  assert.deepEqual(await resolvePublic("ok.example", resolver(["93.184.216.34"])), { address: "93.184.216.34", family: 4 });
});

test("fetchRemoteImage：內網網址在連線前就被擋", async () => {
  await assert.rejects(fetchRemoteImage("https://127.0.0.1/x.png", 1024), /內網或本機/);
  await assert.rejects(fetchRemoteImage("http://example.com/x.png", 1024), /https/);
});

test("magic bytes：只認 JPEG／PNG／WebP", () => {
  const b = (...xs: number[]) => new Uint8Array([...xs, ...new Array(16).fill(0)]);
  assert.equal(sniffImageFormat(b(0xff, 0xd8, 0xff, 0xe0)), "jpeg");
  assert.equal(sniffImageFormat(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "png");
  assert.equal(sniffImageFormat(b(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)), "webp");
  const enc = (s: string) => new TextEncoder().encode(s);
  assert.equal(sniffImageFormat(enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniffImageFormat(enc("<!doctype html><html></html>")), null);
  assert.equal(sniffImageFormat(enc("GIF89a....")), null);
  assert.equal(sniffImageFormat(b(0x49, 0x49, 0x2a, 0x00)), null); // TIFF
  assert.equal(sniffImageFormat(new Uint8Array([0xff, 0xd8])), null);
});
