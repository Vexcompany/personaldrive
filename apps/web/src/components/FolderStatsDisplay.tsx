"use client";

import type { DriveFile, DriveFolder } from "@personaldrive/shared";
import { formatSize } from "@/lib/format";

interface FolderStatsDisplayProps {
  files: DriveFile[];
  folders: DriveFolder[];
  className?: string;
}

export function FolderStatsDisplay({ files, folders, className = "" }: FolderStatsDisplayProps) {
  const fileCount = files.length;
  const folderCount = folders.length;
  const totalSize = files.reduce((sum, f) => sum + (f.size ?? 0), 0);

  if (fileCount === 0 && folderCount === 0) return null;

  const parts: string[] = [];
  if (fileCount > 0) parts.push(`${fileCount} File`);
  if (folderCount > 0) parts.push(`${folderCount} Folder`);
  if (totalSize > 0) parts.push(formatSize(totalSize));

  return (
    <span className={`text-xs text-slate-400 tabular-nums ${className}`}>
      {parts.join(" · ")}
    </span>
  );
}
