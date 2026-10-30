"use client";

import { API_URL, ApiError, authHeaders } from "./api";
import type { ApiErrorCode, DriveFile } from "@personaldrive/shared";

export async function downloadUrl(url: string, filename: string): Promise<void> {
  const res = await fetch(url, { headers: authHeaders() });
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
      /* ignore */
    }
    throw new ApiError(res.status, code, message, extra);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}

export function downloadItem(item: DriveFile): Promise<void> {
  if (item.mimeType === "application/vnd.google-apps.folder") {
    return downloadUrl(`${API_URL}/download/folder?id=${encodeURIComponent(item.id)}`, `${item.name}.zip`);
  }
  return downloadUrl(`${API_URL}/download?id=${encodeURIComponent(item.id)}`, item.name);
}

export async function downloadSelected(items: DriveFile[]): Promise<void> {
  if (items.length === 0) return;
  if (items.length === 1) {
    return downloadItem(items[0]);
  }
  const { buildClientZip } = await import("./zip-builder");
  const zipBlob = await buildClientZip(items);
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "download.zip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
