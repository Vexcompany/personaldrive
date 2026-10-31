"use client";

import type {
  ApiErrorCode,
  CreateFolderRequest,
  CreateSpaceRequest,
  CreateSpaceResponse,
  DriveFile,
  DriveFolder,
  FinishUploadRequest,
  FinishUploadResponse,
  ListFilesResponse,
  ListSpacesResponse,
  LogoutSpaceResponse,
  MoveRequest,
  MoveResponse,
  PreviewResponse,
  RenameRequest,
  SearchResponse,
  SessionInfo,
  ShareRequest,
  ShareResponse,
  ShareStatusResponse,
  StartUploadRequest,
  StartUploadResponse,
  StorageResponse,
  TrashDeleteForeverRequest,
  TrashDeleteForeverResponse,
  TrashListResponse,
  TrashRequest,
  TrashResponse,
  TrashRestoreRequest,
  TrashRestoreResponse,
  TrashSearchResponse,
  UnlockRequest,
  UnlockResponse,
  UpdateFolderSecurityRequest,
  UpdateFolderSecurityResponse,
} from "@personaldrive/shared";

/**
 * Defaults to `/api` (proxied to `http://127.0.0.1:8787` via Next.js rewrites in dev/preview).
 * In production (Vercel + Cloudflare Workers), set `NEXT_PUBLIC_API_URL` to your Worker URL
 * (e.g. `https://personaldrive-api.<subdomain>.workers.dev`).
 */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "/api").replace(/\/+$/, "");

export function resolveApiUrl(pathOrUrl: string): string {
  if (/^(https?:|data:|blob:)/i.test(pathOrUrl)) return pathOrUrl;
  return `${API_URL}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
}

export const MAX_BATCH = 20;

export interface BatchProgress {
  total: number;
  done: number;
  failed: string[];
  succeeded: string[];
  running: boolean;
}

export async function batchOperation(
  ids: string[],
  fn: (batchIds: string[]) => Promise<{ succeeded: number; failed: string[] }>,
  onProgress?: (progress: BatchProgress) => void
): Promise<BatchProgress> {
  const progress: BatchProgress = { total: ids.length, done: 0, failed: [], succeeded: [], running: true };
  onProgress?.(progress);

  for (let i = 0; i < ids.length; i += MAX_BATCH) {
    const chunk = ids.slice(i, i + MAX_BATCH);
    try {
      const res = await fn(chunk);
      progress.succeeded.push(...chunk.slice(0, res.succeeded));
      progress.failed.push(...res.failed);
      progress.done += chunk.length;
    } catch {
      progress.failed.push(...chunk);
      progress.done += chunk.length;
    }
    onProgress?.(progress);
  }

  progress.running = false;
  onProgress?.(progress);
  return progress;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly lockedFolderId?: string;
  readonly lockedFolderName?: string;
  readonly spaceId?: string;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    extra?: { lockedFolderId?: string; lockedFolderName?: string; spaceId?: string }
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.lockedFolderId = extra?.lockedFolderId;
    this.lockedFolderName = extra?.lockedFolderName;
    this.spaceId = extra?.spaceId;
  }
}

export const TOKEN_KEY = "personaldrive.token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY) || window.sessionStorage.getItem(TOKEN_KEY);
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    throw new ApiError(0, "INTERNAL_ERROR", err instanceof Error ? err.message : "Network error.");
  }
  if (!res.ok) {
    let code: ApiErrorCode = "INTERNAL_ERROR";
    let message = `HTTP ${res.status}`;
    let extra: { lockedFolderId?: string; lockedFolderName?: string; spaceId?: string } | undefined;
    try {
      const data = (await res.json()) as {
        code?: ApiErrorCode;
        message?: string;
        lockedFolderId?: string;
        lockedFolderName?: string;
        spaceId?: string;
      };
      if (data?.code) code = data.code;
      if (data?.message) message = data.message;
      extra = {
        lockedFolderId: data?.lockedFolderId,
        lockedFolderName: data?.lockedFolderName,
        spaceId: data?.spaceId,
      };
    } catch {
      /* ignore non-JSON */
    }
    throw new ApiError(res.status, code, message, extra);
  }
  return (await res.json()) as T;
}

export const api = {
  // ── Spaces & Auth ────────────────────────────────────────────────────────
  async listSpaces(): Promise<ListSpacesResponse> {
    return call<ListSpacesResponse>("/spaces");
  },
  async createSpace(req: CreateSpaceRequest): Promise<CreateSpaceResponse> {
    return call<CreateSpaceResponse>("/spaces", { method: "POST", body: JSON.stringify(req) });
  },
  async deleteSpace(spaceId: string, ownerPassword: string): Promise<{ ok: true; session: SessionInfo }> {
    return call(`/spaces/${encodeURIComponent(spaceId)}`, {
      method: "DELETE",
      body: JSON.stringify({ ownerPassword }),
    });
  },
  async getSession(): Promise<{ session: SessionInfo }> {
    return call("/auth/session");
  },
  async unlock(req: UnlockRequest): Promise<UnlockResponse> {
    return call<UnlockResponse>("/auth/unlock", { method: "POST", body: JSON.stringify(req) });
  },
  async logout(spaceId?: string): Promise<LogoutSpaceResponse> {
    return call<LogoutSpaceResponse>("/auth/logout", {
      method: "POST",
      body: JSON.stringify(spaceId ? { spaceId } : {}),
    });
  },
  async updateFolderSecurity(req: UpdateFolderSecurityRequest): Promise<UpdateFolderSecurityResponse> {
    const { folderId, ...rest } = req;
    return call<UpdateFolderSecurityResponse>(`/folders/${encodeURIComponent(folderId)}/security`, {
      method: "PATCH",
      body: JSON.stringify(rest),
    });
  },

  // ── Files & Folders ──────────────────────────────────────────────────────
  async listFiles(spaceId: string, folderId: string | null = null): Promise<ListFilesResponse> {
    const params = new URLSearchParams({ spaceId });
    if (folderId) params.set("folder", folderId);
    return call<ListFilesResponse>(`/files?${params.toString()}`);
  },
  async createFolder(req: CreateFolderRequest): Promise<{ folder: DriveFolder }> {
    return call("/folders", { method: "POST", body: JSON.stringify(req) });
  },
  async deleteFile(id: string): Promise<{ ok: true }> {
    return call(`/files/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  async rename(req: RenameRequest): Promise<{ file: DriveFile }> {
    return call("/rename", { method: "PATCH", body: JSON.stringify(req) });
  },
  async startUpload(req: StartUploadRequest): Promise<StartUploadResponse> {
    return call("/upload/start", { method: "POST", body: JSON.stringify(req) });
  },
  async finishUpload(req: FinishUploadRequest): Promise<FinishUploadResponse> {
    return call<FinishUploadResponse>("/upload/finish", { method: "POST", body: JSON.stringify(req) });
  },
  async preview(id: string): Promise<PreviewResponse> {
    return call(`/preview?id=${encodeURIComponent(id)}`);
  },
  async share(spaceId: string, fileId: string): Promise<ShareResponse> {
    const body: ShareRequest = { spaceId, fileId };
    return call<ShareResponse>("/share", { method: "POST", body: JSON.stringify(body) });
  },
  async shareStatus(fileId: string): Promise<ShareStatusResponse> {
    return call<ShareStatusResponse>(`/share?id=${encodeURIComponent(fileId)}`);
  },
  async search(spaceId: string, q: string): Promise<SearchResponse> {
    const params = new URLSearchParams({ spaceId, q });
    return call<SearchResponse>(`/search?${params.toString()}`);
  },
  async move(req: MoveRequest): Promise<MoveResponse> {
    return call<MoveResponse>("/move", { method: "POST", body: JSON.stringify(req) });
  },

  // ── Trash ────────────────────────────────────────────────────────────────
  async listTrash(spaceId: string): Promise<TrashListResponse> {
    return call<TrashListResponse>(`/trash?spaceId=${encodeURIComponent(spaceId)}`);
  },
  async trashItems(req: TrashRequest): Promise<TrashResponse> {
    return call<TrashResponse>("/trash", { method: "POST", body: JSON.stringify(req) });
  },
  async restoreItems(req: TrashRestoreRequest): Promise<TrashRestoreResponse> {
    return call<TrashRestoreResponse>("/trash/restore", { method: "POST", body: JSON.stringify(req) });
  },
  async deleteForever(req: TrashDeleteForeverRequest): Promise<TrashDeleteForeverResponse> {
    return call<TrashDeleteForeverResponse>("/trash", { method: "DELETE", body: JSON.stringify(req) });
  },
  async searchTrash(spaceId: string, q: string): Promise<TrashSearchResponse> {
    const params = new URLSearchParams({ spaceId, q });
    return call<TrashSearchResponse>(`/trash/search?${params.toString()}`);
  },

  // ── Storage ──────────────────────────────────────────────────────────────
  async getStorage(): Promise<StorageResponse> {
    return call<StorageResponse>("/storage");
  },
};
