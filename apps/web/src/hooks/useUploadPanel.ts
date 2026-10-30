"use client";

import { useEffect, useState } from "react";
import { createEngine, toUploadSources } from "@/lib/engine";
import type { ProgressSnapshot, UploadFileSnapshot, UploadEngine } from "@personaldrive/upload-engine";

interface UploadPanelState {
  engine: UploadEngine | null;
  snapshot: ProgressSnapshot | null;
  files: UploadFileSnapshot[];
  spaceId: string | null;
  folderId: string | null;
  visible: boolean;
  minimized: boolean;
}

const singleton: UploadPanelState = {
  engine: null,
  snapshot: null,
  files: [],
  spaceId: null,
  folderId: null,
  visible: false,
  minimized: false,
};

type Listener = () => void;
const listeners = new Set<Listener>();

const completionVersion: Record<string, number> = {};
let prevAllDone = false;

function targetKey(spaceId: string | null, folderId: string | null): string {
  return `${spaceId ?? "__none__"}:${folderId ?? "__root__"}`;
}

function updateCompletion() {
  const isActive = singleton.files.some(
    (f) => f.state === "uploading" || f.state === "queued" || f.state === "paused" || f.state === "retrying"
  );
  const allDone =
    !isActive &&
    singleton.files.length > 0 &&
    singleton.files.every((f) => f.state === "completed" || f.state === "failed");

  if (allDone && !prevAllDone) {
    const hasCompleted = singleton.files.some((f) => f.state === "completed");
    if (hasCompleted) {
      const key = targetKey(singleton.spaceId, singleton.folderId);
      completionVersion[key] = (completionVersion[key] ?? 0) + 1;
    }
  }
  prevAllDone = allDone;
}

function notify() {
  updateCompletion();
  listeners.forEach((l) => l());
}

function getEngine(spaceId: string, folderId: string | null): UploadEngine {
  if (singleton.engine && singleton.spaceId === spaceId && singleton.folderId === folderId) {
    return singleton.engine;
  }
  if (singleton.engine) {
    void singleton.engine.stop();
  }

  const engine = createEngine({
    spaceId,
    parentId: folderId,
    onProgress: (snap) => {
      singleton.snapshot = snap;
      notify();
    },
    onFileStateChange: (file) => {
      const idx = singleton.files.findIndex((f) => f.id === file.id);
      if (idx === -1) {
        singleton.files = [...singleton.files, file];
      } else {
        const next = singleton.files.slice();
        next[idx] = file;
        singleton.files = next;
      }
      notify();
    },
  });

  singleton.engine = engine;
  singleton.spaceId = spaceId;
  singleton.folderId = folderId;
  return engine;
}

export function addFilesToPanel(rawFiles: File[], spaceId: string, folderId: string | null): void {
  const engine = getEngine(spaceId, folderId);
  const sources = toUploadSources(rawFiles);
  engine.addFiles(sources);
  engine.start();
  singleton.visible = true;
  singleton.minimized = false;
  notify();
}

export function pauseAllUploads(): void {
  singleton.engine?.pauseAll();
}

export function resumeAllUploads(): void {
  singleton.engine?.resumeAll();
}

export function retryAllFailedUploads(): void {
  singleton.engine?.retryAllFailed();
}

export function cancelAllUploads(): void {
  singleton.engine?.cancelAll();
  singleton.files = [];
  singleton.snapshot = null;
  singleton.visible = false;
  prevAllDone = false;
  notify();
}

export function pauseFile(id: string): void {
  singleton.engine?.pauseFile(id);
}

export function resumeFile(id: string): void {
  singleton.engine?.resumeFile(id);
}

export function retryFile(id: string): void {
  singleton.engine?.retryFile(id);
}

export function cancelFile(id: string): void {
  singleton.engine?.cancelFile(id);
}

export function setPanelMinimized(minimized: boolean): void {
  singleton.minimized = minimized;
  notify();
}

export function closePanel(): void {
  const isActive = singleton.files.some(
    (f) => f.state === "uploading" || f.state === "queued" || f.state === "paused" || f.state === "retrying"
  );
  if (!isActive) {
    singleton.visible = false;
    singleton.files = [];
    singleton.snapshot = null;
    prevAllDone = false;
    notify();
  }
}

export interface UploadPanelSnapshot {
  snapshot: ProgressSnapshot | null;
  files: UploadFileSnapshot[];
  visible: boolean;
  minimized: boolean;
  isActive: boolean;
  allDone: boolean;
}

export function useUploadPanel(): UploadPanelSnapshot {
  const [, setTick] = useState(0);

  useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const isActive = singleton.files.some(
    (f) => f.state === "uploading" || f.state === "queued" || f.state === "paused" || f.state === "retrying"
  );

  const allDone =
    !isActive &&
    singleton.files.length > 0 &&
    singleton.files.every((f) => f.state === "completed" || f.state === "failed");

  return {
    snapshot: singleton.snapshot,
    files: singleton.files,
    visible: singleton.visible,
    minimized: singleton.minimized,
    isActive,
    allDone,
  };
}

export function useUploadCompletionVersion(spaceId: string | null, folderId: string | null): number {
  const key = targetKey(spaceId, folderId);
  const [version, setVersion] = useState(() => completionVersion[key] ?? 0);

  useEffect(() => {
    setVersion(completionVersion[key] ?? 0);
    const listener = () => {
      setVersion((prev) => {
        const current = completionVersion[key] ?? 0;
        return prev !== current ? current : prev;
      });
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [key]);

  return version;
}
