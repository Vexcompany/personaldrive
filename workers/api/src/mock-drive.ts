/**
 * In-memory Google Drive v3 simulator used ONLY when `env.MOCK_DRIVE === "true"`
 * (local preview without Google Cloud credentials, and integration tests).
 *
 * Mirrors Google Drive semantics closely:
 *   - Folder cascade on trash / restore / permanent delete
 *   - `appProperties` storage (setting a key to `null` deletes that key)
 *   - Resumable upload sessions (`startResumableUpload` + `forwardChunk` 308/200)
 *   - Media byte streaming with HTTP `Range` support (206 Partial Content)
 */

import type { DriveFile, PermissionInfo, StorageInfo } from "./google";
import { HttpError } from "./google";

interface StoredEntry {
  id: string;
  name: string;
  mimeType: string;
  size: string | null;
  parents: string[];
  thumbnailLink: string | null;
  webViewLink: string | null;
  modifiedTime: string;
  createdTime: string;
  trashed: boolean;
  appProperties: Record<string, string>;
  permissions: PermissionInfo[];
  bytes: Uint8Array;
}

interface MockUploadSession {
  id: string;
  filename: string;
  mimeType: string;
  totalBytes: number;
  parentId: string;
  chunks: Uint8Array[];
  receivedBytes: number;
  driveFileId: string | null;
}

const files = new Map<string, StoredEntry>();
const sessions = new Map<string, MockUploadSession>();
let seq = 1;

function nextId(prefix = "drv"): string {
  return `${prefix}_${seq++}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureRoot(rootId: string): void {
  if (!files.has(rootId)) {
    const now = new Date().toISOString();
    files.set(rootId, {
      id: rootId,
      name: "Root",
      mimeType: "application/vnd.google-apps.folder",
      size: null,
      parents: [],
      thumbnailLink: null,
      webViewLink: `https://drive.google.com/drive/folders/${rootId}`,
      modifiedTime: now,
      createdTime: now,
      trashed: false,
      appProperties: {},
      permissions: [],
      bytes: new Uint8Array(0),
    });
  }
}

export function resetMockDrive(): void {
  files.clear();
  sessions.clear();
  seq = 1;
}

function toDriveFile(e: StoredEntry): DriveFile {
  return {
    id: e.id,
    name: e.name,
    mimeType: e.mimeType,
    size: e.size,
    parents: [...e.parents],
    thumbnailLink: e.thumbnailLink,
    webViewLink: e.webViewLink,
    modifiedTime: e.modifiedTime,
    createdTime: e.createdTime,
    trashed: e.trashed,
    appProperties: { ...e.appProperties },
  };
}

function setTrashedRecursive(id: string, trashed: boolean): void {
  const entry = files.get(id);
  if (!entry) return;
  entry.trashed = trashed;
  entry.modifiedTime = new Date().toISOString();
  if (entry.mimeType === "application/vnd.google-apps.folder") {
    for (const child of files.values()) {
      if (child.parents.includes(id)) {
        setTrashedRecursive(child.id, trashed);
      }
    }
  }
}

function deleteRecursive(id: string): void {
  const entry = files.get(id);
  if (!entry) return;
  if (entry.mimeType === "application/vnd.google-apps.folder") {
    for (const child of [...files.values()]) {
      if (child.parents.includes(id)) {
        deleteRecursive(child.id);
      }
    }
  }
  files.delete(id);
}

export const mockDrive = {
  findFolder(rootId: string, parentId: string, name: string): DriveFile | null {
    ensureRoot(rootId);
    for (const f of files.values()) {
      if (
        !f.trashed &&
        f.mimeType === "application/vnd.google-apps.folder" &&
        f.parents.includes(parentId) &&
        f.name.toLowerCase() === name.toLowerCase()
      ) {
        return toDriveFile(f);
      }
    }
    return null;
  },

  createFolder(
    rootId: string,
    parentId: string,
    name: string,
    appProperties?: Record<string, string>
  ): DriveFile {
    ensureRoot(rootId);
    const id = nextId("fld");
    const now = new Date().toISOString();
    const entry: StoredEntry = {
      id,
      name,
      mimeType: "application/vnd.google-apps.folder",
      size: null,
      parents: [parentId],
      thumbnailLink: null,
      webViewLink: `https://drive.google.com/drive/folders/${id}`,
      modifiedTime: now,
      createdTime: now,
      trashed: false,
      appProperties: { ...(appProperties ?? {}) },
      permissions: [],
      bytes: new Uint8Array(0),
    };
    files.set(id, entry);
    return toDriveFile(entry);
  },

  listChildren(rootId: string, folderId: string | null, includeTrashed = false): DriveFile[] {
    ensureRoot(rootId);
    const targetParent = folderId ?? rootId;
    const out: DriveFile[] = [];
    for (const f of files.values()) {
      if (!f.parents.includes(targetParent)) continue;
      if (!includeTrashed && f.trashed) continue;
      out.push(toDriveFile(f));
    }
    out.sort((a, b) => {
      const af = a.mimeType === "application/vnd.google-apps.folder" ? 0 : 1;
      const bf = b.mimeType === "application/vnd.google-apps.folder" ? 0 : 1;
      if (af !== bf) return af - bf;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    return out;
  },

  getFile(rootId: string, fileId: string): DriveFile {
    ensureRoot(rootId);
    const f = files.get(fileId);
    if (!f) throw new HttpError(404, "NOT_FOUND", `File not found: ${fileId}`);
    return toDriveFile(f);
  },

  updateFileMetadata(
    rootId: string,
    fileId: string,
    patch: { name?: string; trashed?: boolean; appProperties?: Record<string, string | null> }
  ): DriveFile {
    ensureRoot(rootId);
    const f = files.get(fileId);
    if (!f) throw new HttpError(404, "NOT_FOUND", `File not found: ${fileId}`);
    if (typeof patch.name === "string") f.name = patch.name;
    if (typeof patch.trashed === "boolean") {
      setTrashedRecursive(fileId, patch.trashed);
    }
    if (patch.appProperties) {
      for (const [k, v] of Object.entries(patch.appProperties)) {
        if (v === null) delete f.appProperties[k];
        else f.appProperties[k] = v;
      }
    }
    f.modifiedTime = new Date().toISOString();
    return toDriveFile(f);
  },

  deleteFile(rootId: string, fileId: string): void {
    ensureRoot(rootId);
    if (!files.has(fileId)) throw new HttpError(404, "NOT_FOUND", `File not found: ${fileId}`);
    deleteRecursive(fileId);
  },

  listTrashed(rootId: string): DriveFile[] {
    ensureRoot(rootId);
    return [...files.values()].filter((f) => f.trashed).map(toDriveFile);
  },

  searchDrive(rootId: string, query: string, trashed = false): DriveFile[] {
    ensureRoot(rootId);
    const q = query.toLowerCase();
    return [...files.values()]
      .filter((f) => f.id !== rootId && f.trashed === trashed && f.name.toLowerCase().includes(q))
      .map(toDriveFile);
  },

  listPermissions(rootId: string, fileId: string): PermissionInfo[] {
    ensureRoot(rootId);
    const f = files.get(fileId);
    if (!f) throw new HttpError(404, "NOT_FOUND", `File not found: ${fileId}`);
    return [...f.permissions];
  },

  ensurePublicPermission(rootId: string, fileId: string): DriveFile {
    ensureRoot(rootId);
    const f = files.get(fileId);
    if (!f) throw new HttpError(404, "NOT_FOUND", `File not found: ${fileId}`);
    if (!f.permissions.some((p) => p.type === "anyone" && p.role === "reader")) {
      f.permissions.push({ id: "anyoneWithLink", type: "anyone", role: "reader", allowFileDiscovery: false });
    }
    return toDriveFile(f);
  },

  moveFile(rootId: string, fileId: string, newParentId: string): DriveFile {
    ensureRoot(rootId);
    const f = files.get(fileId);
    if (!f) throw new HttpError(404, "NOT_FOUND", `File not found: ${fileId}`);
    f.parents = [newParentId];
    f.modifiedTime = new Date().toISOString();
    return toDriveFile(f);
  },

  fetchMedia(rootId: string, fileId: string, range?: string | null): Response {
    ensureRoot(rootId);
    const f = files.get(fileId);
    if (!f) throw new HttpError(404, "NOT_FOUND", `File not found: ${fileId}`);
    const total = f.bytes.byteLength;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        const start = Math.min(Number(m[1]), Math.max(0, total - 1));
        const end = m[2] ? Math.min(Number(m[2]), total - 1) : Math.max(0, total - 1);
        const slice = f.bytes.slice(start, end + 1);
        const buf = new ArrayBuffer(slice.byteLength);
        new Uint8Array(buf).set(slice);
        return new Response(buf, {
          status: 206,
          headers: {
            "Content-Type": f.mimeType,
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Content-Length": String(slice.byteLength),
          },
        });
      }
    }
    const buf = new ArrayBuffer(f.bytes.byteLength);
    new Uint8Array(buf).set(f.bytes);
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": f.mimeType,
        "Accept-Ranges": "bytes",
        "Content-Length": String(total),
      },
    });
  },

  startResumableUpload(
    rootId: string,
    args: { filename: string; mimeType: string; size: number; parentId: string | null }
  ): { sessionUri: string; totalBytes: number } {
    ensureRoot(rootId);
    const id = nextId("ses");
    const sessionUri = `mock://upload/${id}`;
    const parentId = args.parentId ?? rootId;
    if (args.size === 0) {
      const fileId = commitUploadedBytes(parentId, args.filename, args.mimeType, new Uint8Array(0));
      sessions.set(sessionUri, {
        id,
        filename: args.filename,
        mimeType: args.mimeType,
        totalBytes: 0,
        parentId,
        chunks: [],
        receivedBytes: 0,
        driveFileId: fileId,
      });
    } else {
      sessions.set(sessionUri, {
        id,
        filename: args.filename,
        mimeType: args.mimeType,
        totalBytes: args.size,
        parentId,
        chunks: [],
        receivedBytes: 0,
        driveFileId: null,
      });
    }
    return { sessionUri, totalBytes: args.size };
  },

  forwardChunk(args: {
    sessionUri: string;
    start: number;
    end: number;
    total: number;
    mimeType: string;
    body: ArrayBuffer;
  }): { acknowledged: number; finished: boolean; driveFileId: string | null } {
    const ses = sessions.get(args.sessionUri);
    if (!ses) throw new HttpError(404, "NOT_FOUND", "Upload session not found.");
    const chunk = new Uint8Array(args.body);
    ses.chunks.push(chunk);
    ses.receivedBytes += chunk.byteLength;
    if (ses.receivedBytes >= args.total) {
      const merged = new Uint8Array(ses.receivedBytes);
      let offset = 0;
      for (const c of ses.chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }
      const fileId = commitUploadedBytes(ses.parentId, ses.filename, ses.mimeType, merged);
      ses.driveFileId = fileId;
      return { acknowledged: args.total, finished: true, driveFileId: fileId };
    }
    return { acknowledged: ses.receivedBytes, finished: false, driveFileId: null };
  },

  getStorageInfo(): StorageInfo {
    let used = 0;
    for (const f of files.values()) {
      if (f.size) used += Number(f.size);
    }
    const limit = 15 * 1024 * 1024 * 1024; // 15 GB
    return { limit, usage: used, workspaceUsage: used };
  },
};

function commitUploadedBytes(
  parentId: string,
  filename: string,
  mimeType: string,
  bytes: Uint8Array
): string {
  const id = nextId("fil");
  const now = new Date().toISOString();
  let thumbnailLink: string | null = null;
  if (mimeType.startsWith("image/") && bytes.byteLength > 0 && bytes.byteLength <= 2 * 1024 * 1024) {
    let bin = "";
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    thumbnailLink = `data:${mimeType};base64,${btoa(bin)}`;
  }
  files.set(id, {
    id,
    name: filename,
    mimeType,
    size: String(bytes.byteLength),
    parents: [parentId],
    thumbnailLink,
    webViewLink: `https://drive.google.com/file/d/${id}/view`,
    modifiedTime: now,
    createdTime: now,
    trashed: false,
    appProperties: {},
    permissions: [],
    bytes,
  });
  return id;
}
