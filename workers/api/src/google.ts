/**
 * Google Drive API helpers — runs server-side only inside the Worker.
 * The browser never sees Google OAuth tokens.
 */

import type { Env } from "./env";
import { mockDrive } from "./mock-drive";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

export type HttpErrorCode =
  | "INVALID_LOGIN_PAYLOAD"
  | "INVALID_CREDENTIALS"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "FOLDER_LOCKED"
  | "NAME_TAKEN"
  | "INVALID_PAYLOAD"
  | "MISSING_QUERY_PARAM"
  | "DRIVE_ERROR"
  | "INTERNAL_ERROR"
  | "NOT_FOUND"
  | "MISSING_CONFIG"
  | "CONFIG_ERROR"
  | "ITEM_IN_TRASH";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: HttpErrorCode,
    message: string,
    public extra?: { lockedFolderId?: string; lockedFolderName?: string; spaceId?: string }
  ) {
    super(message);
    this.name = "HttpError";
  }
}

interface TokenCacheEntry {
  key: string;
  accessToken: string;
  expiresAt: number;
}

let cachedToken: TokenCacheEntry | null = null;

function isMock(env: Partial<Env>): boolean {
  return env.MOCK_DRIVE === "true";
}

function mockRoot(env: Partial<Env>): string {
  return env.GOOGLE_DRIVE_ROOT || "mock_root";
}

export async function getAccessToken(env: Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "GOOGLE_REFRESH_TOKEN">): Promise<string> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    throw new HttpError(500, "MISSING_CONFIG", "Google OAuth credentials are not configured.");
  }
  const cacheKey = `${env.GOOGLE_CLIENT_ID}:${env.GOOGLE_REFRESH_TOKEN.slice(0, 12)}`;
  if (cachedToken && cachedToken.key === cacheKey && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new HttpError(res.status, "CONFIG_ERROR", `Google token exchange failed: ${text}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    key: cacheKey,
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3500) * 1000,
  };
  return data.access_token;
}

async function authedFetch(url: string, init: RequestInit, env: Env): Promise<Response> {
  const token = await getAccessToken(env);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

const FILE_FIELDS =
  "files(id,name,mimeType,size,parents,thumbnailLink,webViewLink,modifiedTime,createdTime,trashed,appProperties)";
const FILE_FIELDS_SINGLE =
  "id,name,mimeType,size,parents,thumbnailLink,webViewLink,modifiedTime,createdTime,trashed,appProperties";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: string | null;
  parents: string[];
  thumbnailLink: string | null;
  webViewLink: string | null;
  modifiedTime: string | null;
  createdTime?: string | null;
  trashed: boolean;
  appProperties?: Record<string, string>;
}

export async function findFolder(env: Env, parentId: string, name: string): Promise<DriveFile | null> {
  if (isMock(env)) return mockDrive.findFolder(mockRoot(env), parentId, name);
  const safeName = typeof name === "string" ? name : "";
  const q = `mimeType='application/vnd.google-apps.folder' and name='${safeName.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=${FILE_FIELDS}`;
  const res = await authedFetch(url, { method: "GET" }, env);
  if (!res.ok) throw new HttpError(res.status, "DRIVE_ERROR", await res.text());
  const data = (await res.json()) as { files: DriveFile[] };
  return data.files[0] ?? null;
}

export async function createFolder(
  env: Env,
  parentId: string,
  name: string,
  appProperties?: Record<string, string>
): Promise<DriveFile> {
  if (isMock(env)) return mockDrive.createFolder(mockRoot(env), parentId, name, appProperties);
  const payload: Record<string, unknown> = {
    name,
    mimeType: "application/vnd.google-apps.folder",
    parents: [parentId],
  };
  if (appProperties && Object.keys(appProperties).length > 0) {
    payload.appProperties = appProperties;
  }
  const res = await authedFetch(
    `${DRIVE_API}/files?fields=${FILE_FIELDS_SINGLE}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    env
  );
  if (!res.ok) throw new HttpError(res.status, "DRIVE_ERROR", await res.text());
  return (await res.json()) as DriveFile;
}

export async function ensureFolder(
  env: Env,
  parentId: string,
  name: string,
  appProperties?: Record<string, string>
): Promise<DriveFile> {
  const existing = await findFolder(env, parentId, name);
  if (existing) return existing;
  return createFolder(env, parentId, name, appProperties);
}

export async function listChildren(env: Env, folderId: string | null, includeTrashed = false): Promise<DriveFile[]> {
  if (isMock(env)) return mockDrive.listChildren(mockRoot(env), folderId, includeTrashed);
  const trashedFilter = includeTrashed ? "" : " and trashed=false";
  const q = folderId ? `'${folderId}' in parents${trashedFilter}` : `'root' in parents${trashedFilter}`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=${FILE_FIELDS}&pageSize=1000&orderBy=folder,name`;
  const res = await authedFetch(url, { method: "GET" }, env);
  if (!res.ok) throw new HttpError(res.status, "DRIVE_ERROR", await res.text());
  const data = (await res.json()) as { files: DriveFile[] };
  return data.files ?? [];
}

export async function getFile(env: Env, fileId: string): Promise<DriveFile> {
  if (isMock(env)) return mockDrive.getFile(mockRoot(env), fileId);
  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS_SINGLE}`;
  const res = await authedFetch(url, { method: "GET" }, env);
  if (!res.ok) {
    const code = res.status === 404 ? "NOT_FOUND" : "DRIVE_ERROR";
    throw new HttpError(res.status, code, await res.text());
  }
  return (await res.json()) as DriveFile;
}

export async function updateFileMetadata(
  env: Env,
  fileId: string,
  patch: { name?: string; trashed?: boolean; appProperties?: Record<string, string | null> }
): Promise<DriveFile> {
  if (isMock(env)) return mockDrive.updateFileMetadata(mockRoot(env), fileId, patch);
  const res = await authedFetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS_SINGLE}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
    env
  );
  if (!res.ok) throw new HttpError(res.status, "DRIVE_ERROR", await res.text());
  return (await res.json()) as DriveFile;
}

export async function deleteFile(env: Env, fileId: string): Promise<void> {
  if (isMock(env)) {
    mockDrive.deleteFile(mockRoot(env), fileId);
    return;
  }
  const res = await authedFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, { method: "DELETE" }, env);
  if (!res.ok && res.status !== 204) {
    const code = res.status === 404 ? "NOT_FOUND" : "DRIVE_ERROR";
    throw new HttpError(res.status, code, await res.text());
  }
}

export async function trashFile(env: Env, fileId: string): Promise<DriveFile> {
  return updateFileMetadata(env, fileId, { trashed: true });
}

export async function restoreFile(env: Env, fileId: string): Promise<DriveFile> {
  return updateFileMetadata(env, fileId, { trashed: false });
}

export async function renameFile(env: Env, fileId: string, name: string): Promise<DriveFile> {
  return updateFileMetadata(env, fileId, { name });
}

export async function listTrashed(env: Env): Promise<DriveFile[]> {
  if (isMock(env)) return mockDrive.listTrashed(mockRoot(env));
  const q = `trashed=true`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=${FILE_FIELDS}&pageSize=1000&orderBy=folder,name`;
  const res = await authedFetch(url, { method: "GET" }, env);
  if (!res.ok) throw new HttpError(res.status, "DRIVE_ERROR", await res.text());
  const data = (await res.json()) as { files: DriveFile[] };
  return data.files ?? [];
}

export async function searchTrashed(env: Env, query: string): Promise<DriveFile[]> {
  if (isMock(env)) return mockDrive.searchDrive(mockRoot(env), query, true);
  const safe = query.replace(/'/g, "\\'");
  const q = `name contains '${safe}' and trashed=true`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=${FILE_FIELDS}&pageSize=200&orderBy=folder,name`;
  const res = await authedFetch(url, { method: "GET" }, env);
  if (!res.ok) throw new HttpError(res.status, "DRIVE_ERROR", await res.text());
  const data = (await res.json()) as { files: DriveFile[] };
  return data.files ?? [];
}

export async function fetchMedia(env: Env, fileId: string, range?: string | null): Promise<Response> {
  if (isMock(env)) return mockDrive.fetchMedia(mockRoot(env), fileId, range);
  const token = await getAccessToken(env);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (range) headers.Range = range;
  const res = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, {
    method: "GET",
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new HttpError(res.status, "DRIVE_ERROR", text || `Drive media request failed with ${res.status}`);
  }
  return res;
}

export async function searchDrive(env: Env, query: string): Promise<DriveFile[]> {
  if (isMock(env)) return mockDrive.searchDrive(mockRoot(env), query, false);
  const safe = query.replace(/'/g, "\\'");
  const q = `name contains '${safe}' and trashed = false`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=${FILE_FIELDS}&pageSize=200&orderBy=folder,name`;
  const res = await authedFetch(url, { method: "GET" }, env);
  if (!res.ok) throw new HttpError(res.status, "DRIVE_ERROR", await res.text());
  const data = (await res.json()) as { files: DriveFile[] };
  return data.files ?? [];
}

export interface PermissionInfo {
  id: string | null;
  type: string | null;
  role: string | null;
  allowFileDiscovery: boolean | null;
}

export async function listPermissions(env: Env, fileId: string): Promise<PermissionInfo[]> {
  if (isMock(env)) return mockDrive.listPermissions(mockRoot(env), fileId);
  const res = await authedFetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions?fields=permissions(id,type,role,allowFileDiscovery)`,
    { method: "GET" },
    env
  );
  if (!res.ok) throw new HttpError(res.status, "DRIVE_ERROR", await res.text());
  const data = (await res.json()) as {
    permissions?: Array<{ id?: string; type?: string; role?: string; allowFileDiscovery?: boolean }>;
  };
  return (data.permissions ?? []).map((p) => ({
    id: p.id ?? null,
    type: p.type ?? null,
    role: p.role ?? null,
    allowFileDiscovery: p.allowFileDiscovery ?? null,
  }));
}

export async function revokePublicPermissions(env: Env, fileId: string): Promise<void> {
  if (isMock(env)) return;
  const permissions = await listPermissions(env, fileId);
  for (const permission of permissions) {
    if (permission.type !== "anyone" || !permission.id) continue;
    const response = await authedFetch(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permission.id)}`,
      { method: "DELETE" },
      env
    );
    if (!response.ok && response.status !== 404) {
      throw new HttpError(response.status, "DRIVE_ERROR", await response.text());
    }
  }
}

export async function moveFile(env: Env, fileId: string, newParentId: string): Promise<DriveFile> {
  if (isMock(env)) return mockDrive.moveFile(mockRoot(env), fileId, newParentId);
  const file = await getFile(env, fileId);
  const oldParents = (file.parents ?? []).join(",");
  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?addParents=${encodeURIComponent(newParentId)}&removeParents=${encodeURIComponent(oldParents)}&fields=${FILE_FIELDS_SINGLE}`;
  const res = await authedFetch(
    url,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" },
    env
  );
  if (!res.ok) throw new HttpError(res.status, "DRIVE_ERROR", await res.text());
  return (await res.json()) as DriveFile;
}

export interface SubtreeEntry {
  path: string;
  data: Uint8Array;
}

export async function collectSubtree(
  env: Env,
  folderId: string,
  prefix: string,
  canTraverseFolder?: (folder: DriveFile) => boolean
): Promise<SubtreeEntry[]> {
  const children = await listChildren(env, folderId);
  const out: SubtreeEntry[] = [];
  for (const child of children) {
    const rel = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.mimeType === "application/vnd.google-apps.folder") {
      if (canTraverseFolder && !canTraverseFolder(child)) {
        // Skip locked subfolders that a visitor has not unlocked
        continue;
      }
      out.push({ path: `${rel}/`, data: new Uint8Array(0) });
      out.push(...(await collectSubtree(env, child.id, rel, canTraverseFolder)));
    } else {
      try {
        const media = await fetchMedia(env, child.id);
        const buf = await media.arrayBuffer();
        out.push({ path: rel, data: new Uint8Array(buf) });
      } catch {
        // Skip unfetchable Google-native files
      }
    }
  }
  return out;
}

export async function ensurePublicPermission(env: Env, fileId: string): Promise<DriveFile> {
  if (isMock(env)) return mockDrive.ensurePublicPermission(mockRoot(env), fileId);
  const permissions = await listPermissions(env, fileId);
  const alreadyPublic = permissions.some((p) => p.type === "anyone" && p.role === "reader");
  if (!alreadyPublic) {
    const createRes = await authedFetch(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "reader", type: "anyone", allowFileDiscovery: false }),
      },
      env
    );
    if (!createRes.ok) throw new HttpError(createRes.status, "DRIVE_ERROR", await createRes.text());
  }
  const file = await getFile(env, fileId);
  if (!file.webViewLink) {
    throw new HttpError(500, "INTERNAL_ERROR", "Drive did not return a webViewLink.");
  }
  return file;
}

export async function startResumableUpload(
  env: Env,
  args: { filename: string; mimeType: string; size: number; parentId: string | null }
): Promise<{ sessionUri: string; totalBytes: number }> {
  if (isMock(env)) return mockDrive.startResumableUpload(mockRoot(env), args);
  const metadata: Record<string, unknown> = { name: args.filename, mimeType: args.mimeType };
  if (args.parentId) metadata.parents = [args.parentId];
  const res = await authedFetch(
    `${DRIVE_UPLOAD}/files?uploadType=resumable`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": args.mimeType,
        "X-Upload-Content-Length": String(args.size),
      },
      body: JSON.stringify(metadata),
    },
    env
  );
  if (!res.ok) throw new HttpError(res.status, "DRIVE_ERROR", await res.text());
  const sessionUri = res.headers.get("Location");
  if (!sessionUri) throw new HttpError(500, "INTERNAL_ERROR", "Drive did not return a Location header.");
  return { sessionUri, totalBytes: args.size };
}

export async function forwardChunk(
  env: Env,
  args: {
    sessionUri: string;
    start: number;
    end: number;
    total: number;
    mimeType: string;
    body: ArrayBuffer;
  }
): Promise<{ acknowledged: number; finished: boolean; driveFileId: string | null }> {
  if (isMock(env)) return mockDrive.forwardChunk(args);
  const token = await getAccessToken(env);
  const res = await fetch(args.sessionUri, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": args.mimeType,
      "Content-Range": `bytes ${args.start}-${args.end - 1}/${args.total}`,
    },
    body: args.body,
  });
  if (res.status === 308) {
    const range = res.headers.get("Range");
    if (range) {
      const m = /bytes=0-(\d+)/.exec(range);
      if (m) {
        const acknowledged = Number(m[1]) + 1;
        if (acknowledged >= args.total) {
          const finalRes = await fetch(args.sessionUri, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Range": `bytes */${args.total}`,
            },
          });
          if (finalRes.status === 200 || finalRes.status === 201) {
            const body = (await finalRes.json().catch(() => null)) as { id?: string } | null;
            return { acknowledged: args.total, finished: true, driveFileId: body?.id ?? null };
          }
        }
        return { acknowledged, finished: false, driveFileId: null };
      }
    }
    return { acknowledged: args.end, finished: false, driveFileId: null };
  }
  if (res.status === 200 || res.status === 201) {
    const body = (await res.json().catch(() => null)) as { id?: string } | null;
    return { acknowledged: args.total, finished: true, driveFileId: body?.id ?? null };
  }
  throw new HttpError(res.status, "DRIVE_ERROR", await res.text());
}

export interface StorageInfo {
  limit: number;
  usage: number;
  workspaceUsage: number;
}

export async function getStorageInfo(env: Env): Promise<StorageInfo> {
  if (isMock(env)) return mockDrive.getStorageInfo();
  const res = await authedFetch(`${DRIVE_API}/about?fields=storageQuota`, { method: "GET" }, env);
  if (!res.ok) throw new HttpError(res.status, "DRIVE_ERROR", await res.text());
  const data = (await res.json()) as {
    storageQuota?: {
      limit?: string;
      usage?: string;
      usageInDrive?: string;
    };
  };
  const q = data.storageQuota ?? {};
  return {
    limit: Number(q.limit) || 0,
    usage: Number(q.usage) || 0,
    workspaceUsage: Number(q.usageInDrive) || Number(q.usage) || 0,
  };
}
