"use client";

import { API_URL, api, authHeaders } from "./api";
import type { ResumableSession, UploadSource } from "@personaldrive/upload-engine";
import { UploadError, isRecoverableStatus } from "@personaldrive/upload-engine";

export interface OpenSessionArgs {
  spaceId: string;
  source: UploadSource;
  parentId: string | null;
}

export interface OpenSessionResult extends ResumableSession {
  driveFileId: string | null;
}

export async function openSession({ spaceId, source, parentId }: OpenSessionArgs): Promise<OpenSessionResult> {
  const filename = source.name ?? source.relativePath.split("/").pop() ?? "untitled";
  const mimeType = source.mimeType ?? "application/octet-stream";
  const { sessionUri, totalBytes } = await api.startUpload({
    spaceId,
    filename,
    mimeType,
    size: source.size,
    parentId,
  });
  return {
    sessionUri,
    bytesUploaded: 0,
    totalBytes,
    parentId,
    filename,
    mimeType,
    openedAt: Date.now(),
    driveFileId: null,
  };
}

export interface UploadChunkArgs {
  session: ResumableSession;
  chunk: { start: number; end: number; bytes: Uint8Array };
  expectedStart: number;
}

export interface UploadChunkResult {
  acknowledged: number;
  driveFileId: string | null;
  finished: boolean;
}

export async function uploadChunk({ session, chunk, expectedStart }: UploadChunkArgs): Promise<UploadChunkResult> {
  if (expectedStart !== session.bytesUploaded) {
    throw new UploadError("Client/server offset mismatch", { recoverable: true, status: 409 });
  }
  const ab = new ArrayBuffer(chunk.bytes.byteLength);
  new Uint8Array(ab).set(chunk.bytes);

  let res: Response;
  try {
    res = await fetch(`${API_URL}/upload/chunk`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": session.mimeType,
        "X-Session-Uri": session.sessionUri,
        "X-Upload-Start": String(chunk.start),
        "X-Upload-End": String(chunk.end),
        "X-Upload-Total": String(session.totalBytes),
      },
      body: ab,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network error during chunk upload.";
    throw new UploadError(`network: ${message}`, {
      recoverable: true,
      status: 0,
      cause: err,
    });
  }

  if (res.status === 308 || res.status === 200 || res.status === 201) {
    let payload: { acknowledged: number; finished: boolean; driveFileId: string | null };
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      throw new UploadError(
        `Worker returned ${res.status} with non-JSON body for chunk ${chunk.start}-${chunk.end}`,
        { recoverable: true, status: res.status }
      );
    }
    return {
      acknowledged: typeof payload.acknowledged === "number" ? payload.acknowledged : chunk.end,
      driveFileId: payload.driveFileId ?? null,
      finished: Boolean(payload.finished),
    };
  }

  let code = "INTERNAL_ERROR";
  let message = `HTTP ${res.status}`;
  let workerStatus: number | null = res.status;
  try {
    const data = (await res.json()) as { code?: string; message?: string; status?: number };
    if (data?.code) code = data.code;
    if (data?.message) message = data.message;
    if (typeof data?.status === "number") workerStatus = data.status;
  } catch {
    try {
      const text = await res.text();
      if (text) message = text.slice(0, 256);
    } catch {
      /* ignore */
    }
  }
  throw new UploadError(`chunk upload failed (${code}): ${message}`, {
    recoverable: isRecoverableStatus(workerStatus),
    status: workerStatus,
  });
}

export async function querySessionProgress(session: ResumableSession): Promise<number> {
  return session.bytesUploaded;
}
