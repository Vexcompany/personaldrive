/**
 * Minimal HS256 JWT implementation using Web Crypto.
 *
 * Supports multi-space sessions in a single compact Bearer token:
 *   - `owned`: map of spaceId -> ownerTag (spaces where client is Owner)
 *   - `unlocked`: map of folderId -> lockTag (locked spaces/subfolders unlocked as Viewer)
 */

import { b64urlDecode, b64urlEncode } from "./crypto";

export interface JwtPayload {
  sub?: string;
  /** Map of spaceId -> ownerTag */
  owned?: Record<string, string>;
  /** Map of folderId -> lockTag */
  unlocked?: Record<string, string>;
  iat: number;
  exp?: number;
}

const encoder = new TextEncoder();
const MAX_ENTRIES = 60;

function trimMap(map: Record<string, string> | undefined): Record<string, string> {
  if (!map) return {};
  const entries = Object.entries(map);
  if (entries.length <= MAX_ENTRIES) return Object.fromEntries(entries);
  return Object.fromEntries(entries.slice(entries.length - MAX_ENTRIES));
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signJwt(
  payload: Omit<JwtPayload, "iat" | "exp">,
  secret: string,
  ttlSeconds?: number
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const full: JwtPayload = {
    ...payload,
    owned: trimMap(payload.owned),
    unlocked: trimMap(payload.unlocked),
    iat: now,
  };
  if (typeof ttlSeconds === "number" && Number.isFinite(ttlSeconds)) {
    full.exp = now + ttlSeconds;
  }
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = b64urlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = b64urlEncode(encoder.encode(JSON.stringify(full)));
  const data = encoder.encode(`${headerB64}.${payloadB64}`);
  const key = await importKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  const sigBuf = new ArrayBuffer(sig.byteLength);
  new Uint8Array(sigBuf).set(sig);
  return `${headerB64}.${payloadB64}.${b64urlEncode(new Uint8Array(sigBuf))}`;
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const key = await importKey(secret);
  const data = encoder.encode(`${headerB64}.${payloadB64}`);
  let expectedBytes: Uint8Array;
  try {
    expectedBytes = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  const sigBuf = new ArrayBuffer(expectedBytes.byteLength);
  new Uint8Array(sigBuf).set(expectedBytes);
  const ok = await crypto.subtle.verify("HMAC", key, sigBuf, data);
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))) as JwtPayload;
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return null;
    return {
      ...payload,
      owned: payload.owned && typeof payload.owned === "object" ? payload.owned : {},
      unlocked: payload.unlocked && typeof payload.unlocked === "object" ? payload.unlocked : {},
    };
  } catch {
    return null;
  }
}
