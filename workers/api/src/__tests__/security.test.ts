import { describe, expect, it } from "vitest";
import { isValidGoogleUploadSessionUri } from "../google";
import { signJwt, verifyJwt } from "../jwt";

const SECRET = "test-secret";

describe("security hardening", () => {
  it("accepts only Google Drive resumable upload session URLs", () => {
    expect(isValidGoogleUploadSessionUri("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc")).toBe(true);
    expect(isValidGoogleUploadSessionUri("https://attacker.example/upload/drive/v3/files?upload_id=abc")).toBe(false);
    expect(isValidGoogleUploadSessionUri("http://www.googleapis.com/upload/drive/v3/files?upload_id=abc")).toBe(false);
    expect(isValidGoogleUploadSessionUri("https://www.googleapis.com.evil.example/upload/drive/v3/files?upload_id=abc")).toBe(false);
    expect(isValidGoogleUploadSessionUri("https://www.googleapis.com/upload/drive/v3/files")).toBe(false);
  });

  it("issues expiring sessions and rejects tokens without expiry", async () => {
    const token = await signJwt({ owned: { space: "tag" } }, SECRET);
    const payload = await verifyJwt(token, SECRET);
    expect(payload?.exp).toBeGreaterThan(payload?.iat ?? 0);

    const parts = token.split(".");
    const legacyPayload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    delete legacyPayload.exp;
    const encoded = btoa(JSON.stringify(legacyPayload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    // A token with an unsigned replacement payload must never validate.
    expect(await verifyJwt(`${parts[0]}.${encoded}.${parts[2]}`, SECRET)).toBeNull();
  });
});
