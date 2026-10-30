/**
 * Password hashing (PBKDF2-HMAC-SHA256 via Web Crypto) and Google Drive
 * `appProperties` metadata helpers.
 *
 * Google Drive enforces <= 124 UTF-8 bytes per (key + value) in `appProperties`
 * and <= 30 properties per file. Every property below is 12–48 bytes total:
 *   - pd_vis : "public" | "locked"        (12 bytes)
 *   - pd_oh  : 43-char base64url hash     (48 bytes) — owner password hash
 *   - pd_os  : 22-char base64url salt     (27 bytes) — owner password salt
 *   - pd_lh  : 43-char base64url hash     (48 bytes) — folder/visitor lock hash
 *   - pd_ls  : 22-char base64url salt     (27 bytes) — folder/visitor lock salt
 *   - pd_cat : 10-char unix epoch seconds (16 bytes) — creation timestamp
 */

import type { FolderVisibility } from "@personaldrive/shared";

const PBKDF2_ITERATIONS = 50_000;
const encoder = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = (input + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function generateSalt(): string {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return b64urlEncode(salt);
}

export async function hashPassword(password: string, saltB64: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const saltBytes = b64urlDecode(saltB64);
  const saltBuf = new ArrayBuffer(saltBytes.byteLength);
  new Uint8Array(saltBuf).set(saltBytes);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBuf,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  return b64urlEncode(new Uint8Array(bits));
}

export async function verifyPassword(
  password: string,
  saltB64: string | undefined | null,
  expectedHashB64: string | undefined | null
): Promise<boolean> {
  if (!saltB64 || !expectedHashB64) return false;
  const computed = await hashPassword(password, saltB64);
  return constantTimeEqual(computed, expectedHashB64);
}

export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) {
    const hash = await crypto.subtle.digest("SHA-256", bb);
    void hash.byteLength;
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// ── Folder appProperties helpers ───────────────────────────────────────────

export type AppProps = Record<string, string> | undefined | null;

export function getFolderVisibility(props: AppProps): FolderVisibility {
  return props?.pd_vis === "locked" ? "locked" : "public";
}

export function isFolderLockedProp(props: AppProps): boolean {
  return getFolderVisibility(props) === "locked";
}

/**
 * Tag embedded in Owner JWTs so changing the owner password immediately
 * invalidates all previously issued Owner tokens for that space.
 */
export function getOwnerTag(props: AppProps): string {
  return (props?.pd_os ?? "legacy").slice(0, 8);
}

/**
 * Tag embedded in Viewer unlock JWTs so changing a folder's lock password
 * immediately invalidates all previously issued Viewer unlock tokens for it.
 */
export function getLockTag(props: AppProps): string {
  if (props?.pd_ls) return props.pd_ls.slice(0, 8);
  if (props?.pd_os) return props.pd_os.slice(0, 8);
  return "open";
}

export function hasSeparateVisitorPassword(props: AppProps): boolean {
  return Boolean(props?.pd_lh && props?.pd_ls);
}
