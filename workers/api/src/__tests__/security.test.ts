import { describe, expect, it } from "vitest";
import { isValidGoogleUploadSessionUri } from "../google";
import { signJwt, verifyJwt } from "../jwt";

const SECRET = "test-secret";
const b64url = (value: string) => btoa(value).replace(/=/g, "").replace(/\\+/g, "-").replace(/\\//g, "_");

describe("security hardening", () => {
  it("accepts only Google Drive resumable upload session URLs", () => {
    expect(isValidGoogleUploadSessionUri("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc")).toBe(true);
    expect(isValidGoogleUploadSessionUri("https://attacker.example/upload/drive/v3/files?upload_id=abc")).toBe(false);
    expect(isValidGoogleUploadSessionUri("http://www.googleapis.com/upload/drive/v3/files?upload_id=abc")).toBe(false);
    expect(isValidGoogleUploadSessionUri("https://www.googleapis.com.evil.example/upload/drive/v3/files?upload_id=abc")).toBe(false);
    expect(isValidGoogleUploadSessionUri("https://www.googleapis.com/upload/drive/v3/files")).toBe(false);
  });

  it("issues 12-hour sessions and rejects signed tokens without expiry", async () => {
    const token = await signJwt({ owned: { space: "tag" } }, SECRET);
    const payload = await verifyJwt(token, SECRET);
    expect(payload?.exp).toBeGreaterThan(payload?.iat ?? 0);
    expect((payload!.exp! - payload!.iat)).toBe(12 * 60 * 60);

    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64url(JSON.stringify({ iat: Math.floor(Date.now() / 1000), owned: { space: "tag" } }));
    const data = new TextEncoder().encode(`${header}.${body}`);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
    const sig = b64url(String.fromCharCode(...signature));
    expect(await verifyJwt(`${header}.${body}.${sig}`, SECRET)).toBeNull();
  });
});
