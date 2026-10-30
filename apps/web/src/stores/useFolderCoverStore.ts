"use client";

import { useState, useEffect } from "react";

const STORAGE_KEY = "personaldrive.folderCovers";

interface CoverEntry {
  imageId: string;
  thumbnailUrl: string;
}

interface CoverMap {
  [folderId: string]: CoverEntry;
}

function loadCovers(): CoverMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveCovers(covers: CoverMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(covers));
  } catch {
    /* ignore */
  }
}

let covers: CoverMap = loadCovers();
let version = 0;
const listeners = new Set<() => void>();

function notify() {
  version++;
  listeners.forEach((l) => l());
}

export function setFolderCover(folderId: string, imageId: string, thumbnailUrl: string): void {
  covers = { ...covers, [folderId]: { imageId, thumbnailUrl } };
  saveCovers(covers);
  notify();
}

export function removeFolderCover(folderId: string): void {
  const next = { ...covers };
  delete next[folderId];
  covers = next;
  saveCovers(covers);
  notify();
}

export function removeCoverByImage(imageFileId: string): void {
  let changed = false;
  const next: CoverMap = {};
  for (const [fid, entry] of Object.entries(covers)) {
    if (entry.imageId === imageFileId) changed = true;
    else next[fid] = entry;
  }
  if (changed) {
    covers = next;
    saveCovers(covers);
    notify();
  }
}

export function getFolderCover(folderId: string): CoverEntry | null {
  return covers[folderId] ?? null;
}

export function useFolderCoverVersion(): number {
  const [ver, setVer] = useState(version);
  useEffect(() => {
    const listener = () => setVer(version);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return ver;
}
