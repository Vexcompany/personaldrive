"use client";

import {
  UploadEngine,
  GoogleDriveAdapter,
  defaultConfig,
  type UploadSource,
  type ResumableSession,
} from "@personaldrive/upload-engine";
import { openSession, querySessionProgress, uploadChunk } from "./upload-client";
import { api } from "./api";

declare module "@personaldrive/upload-engine" {
  interface GoogleDriveAdapter {
    openSession(source: UploadSource, accessToken: string): Promise<ResumableSession>;
    uploadChunk(
      session: ResumableSession,
      chunk: { start: number; end: number; bytes: Uint8Array },
      accessToken: string,
      expectedStart: number
    ): Promise<{ acknowledged: number; driveFileId: string | null; finished: boolean }>;
    queryProgress(session: ResumableSession, accessToken: string): Promise<number>;
  }
}

export interface CreateEngineOptions {
  spaceId: string;
  parentId: string | null;
  onProgress?: (snap: import("@personaldrive/upload-engine").ProgressSnapshot) => void;
  onFileStateChange?: (file: import("@personaldrive/upload-engine").UploadFileSnapshot) => void;
}

class DriveFolderResolver {
  private readonly cache = new Map<string, Promise<string | null>>();

  constructor(
    private readonly getSpaceId: () => string,
    private readonly getBaseParentId: () => string | null
  ) {}

  parentFor(relativePath: string): Promise<string | null> {
    const parts = relativePath.split("/").filter(Boolean);
    parts.pop();
    if (parts.length === 0) return Promise.resolve(this.getBaseParentId());
    const key = parts.join("/");
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.ensureParts(parts).catch((err) => {
        this.cache.delete(key);
        throw err;
      });
      this.cache.set(key, pending);
    }
    return pending;
  }

  private async ensureParts(parts: string[]): Promise<string | null> {
    const spaceId = this.getSpaceId();
    let parentId = this.getBaseParentId();
    for (const name of parts) {
      const { folder } = await api.createFolder({ spaceId, name, parentId });
      parentId = folder.id;
    }
    return parentId;
  }
}

class WorkerBackedDriveAdapter {
  private readonly folders: DriveFolderResolver;

  constructor(private readonly getSpaceId: () => string, getParentId: () => string | null) {
    this.folders = new DriveFolderResolver(getSpaceId, getParentId);
  }

  async openSession(source: UploadSource, _accessToken: string): Promise<ResumableSession> {
    const parentId = await this.folders.parentFor(source.relativePath ?? "");
    return openSession({ spaceId: this.getSpaceId(), source, parentId });
  }

  async uploadChunk(
    session: ResumableSession,
    chunk: { start: number; end: number; bytes: Uint8Array },
    _accessToken: string,
    expectedStart: number
  ): Promise<{ acknowledged: number; driveFileId: string | null; finished: boolean }> {
    return uploadChunk({ session, chunk, expectedStart });
  }

  async queryProgress(session: ResumableSession, _accessToken: string): Promise<number> {
    return querySessionProgress(session);
  }
}

export function createEngine(opts: CreateEngineOptions): UploadEngine {
  const spaceIdRef = { current: opts.spaceId };
  const parentIdRef = { current: opts.parentId };
  const engine = new UploadEngine({
    ...defaultConfig,
    chunkSize: 8 * 1024 * 1024,
    normalConcurrency: 4,
    retryConcurrency: 1,
    maxRetries: 5,
    backoffSeconds: [3, 8, 20, 45, 90],
    parentFolderId: opts.parentId,
    sessionPersistKey: `personaldrive.sessions.${opts.spaceId}.${opts.parentId ?? "root"}`,
    getAccessToken: async () => "worker-bearer",
    onProgress: opts.onProgress,
    onFileStateChange: opts.onFileStateChange,
  });

  engine.setAdapter(
    new WorkerBackedDriveAdapter(
      () => spaceIdRef.current,
      () => parentIdRef.current
    ) as unknown as GoogleDriveAdapter
  );
  return engine;
}

export function toUploadSources(files: File[], rootPath = ""): UploadSource[] {
  return files.map((file) => {
    const rel =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || `${rootPath}${file.name}`;
    return {
      file,
      relativePath: rel,
      name: file.name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
    } as UploadSource;
  });
}
