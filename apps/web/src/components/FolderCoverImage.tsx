"use client";

import { useMemo } from "react";
import type { DriveFile } from "@personaldrive/shared";
import { getFolderCover, useFolderCoverVersion } from "@/stores/useFolderCoverStore";

interface FolderCoverImageProps {
  folder: DriveFile;
  className?: string;
}

export function FolderCoverImage({ folder, className = "" }: FolderCoverImageProps) {
  useFolderCoverVersion();

  const coverUrl = useMemo(() => {
    const explicitCover = getFolderCover(folder.id);
    return explicitCover?.thumbnailUrl ?? null;
  }, [folder.id]);

  if (!coverUrl) return null;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={coverUrl}
      alt={folder.name}
      className={`object-cover rounded-xl ${className}`}
      loading="lazy"
    />
  );
}

export function getFolderCoverUrl(folderId: string): string | null {
  const explicitCover = getFolderCover(folderId);
  return explicitCover?.thumbnailUrl ?? null;
}
