"use client";

import { useState } from "react";
import { X, Copy, Loader2, Folder, Lock, Globe } from "lucide-react";
import { Button, Badge, Card, Modal } from "@/components/ui";
import { api } from "@/lib/api";
import { formatSize, formatDateTime, typeLabel } from "@/lib/format";
import type { DriveFile, ShareStatusResponse } from "@personaldrive/shared";

interface PropertiesPanelProps {
  item: DriveFile;
  breadcrumb: { id: string; name: string }[];
  spaceName: string;
  isOwner: boolean;
  onClose: () => void;
}

export function PropertiesPanel({
  item,
  breadcrumb,
  spaceName,
  isOwner,
  onClose,
}: PropertiesPanelProps) {
  const [shareStatus, setShareStatus] = useState<ShareStatusResponse | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const isFolder = item.mimeType === "application/vnd.google-apps.folder";

  function loadShareStatus() {
    if (!isOwner || shareStatus || shareLoading) return;
    setShareLoading(true);
    api
      .shareStatus(item.id)
      .then((s) => setShareStatus(s))
      .catch(() => {})
      .finally(() => setShareLoading(false));
  }

  async function copyLink() {
    const link = shareStatus?.webViewLink ?? item.webViewLink;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Salin link ini:", link);
    }
  }

  const locationPath = [spaceName, ...breadcrumb.map((c) => c.name)].join(" / ");

  return (
    <Modal open onClose={onClose} className="max-w-md">
      <Card className="p-5">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2.5 min-w-0">
            {isFolder ? (
              <Folder className="h-5 w-5 text-brand-500 shrink-0" />
            ) : (
              <span className="text-xs text-slate-400">{typeLabel(item.mimeType)}</span>
            )}
            <h2 className="font-semibold text-slate-900 truncate">{item.name}</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-all shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 text-sm">
          <PropertyRow label="Nama" value={item.name} />
          <PropertyRow label="Tipe" value={isFolder ? "Folder" : typeLabel(item.mimeType)} />
          <PropertyRow label="MIME Type" value={item.mimeType} mono />
          <PropertyRow label="Ukuran" value={isFolder ? "—" : formatSize(item.size)} />
          <PropertyRow label="Diubah" value={formatDateTime(item.modifiedTime)} />
          <PropertyRow label="Lokasi" value={locationPath} />
          <PropertyRow label="Ruang Pemilik" value={spaceName} />

          {isFolder && (
            <div className="flex justify-between items-center">
              <span className="text-slate-500">Proteksi Folder</span>
              {item.isLocked ? (
                <Badge color="amber" dot>
                  <span className="inline-flex items-center gap-1">
                    <Lock className="h-3 w-3" /> Berpassword
                  </span>
                </Badge>
              ) : (
                <Badge color="green" dot>
                  <span className="inline-flex items-center gap-1">
                    <Globe className="h-3 w-3" /> Publik
                  </span>
                </Badge>
              )}
            </div>
          )}

          <div className="flex justify-between items-center">
            <span className="text-slate-500">Status</span>
            {item.trashed ? (
              <Badge color="red" dot>Di Sampah</Badge>
            ) : (
              <Badge color="green" dot>Aktif</Badge>
            )}
          </div>

          {isOwner && (
            <div className="flex justify-between items-start">
              <span className="text-slate-500">Link Drive</span>
              <div className="flex items-center gap-2">
                {shareLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
                ) : shareStatus ? (
                  <Badge color={shareStatus.public ? "green" : "slate"} dot>
                    {shareStatus.public ? "Publik" : "Terbatas"}
                  </Badge>
                ) : (
                  <button
                    onClick={loadShareStatus}
                    className="text-xs text-brand-500 hover:text-brand-600 transition-colors"
                  >
                    Cek status
                  </button>
                )}
              </div>
            </div>
          )}

          {isOwner && shareStatus?.public && shareStatus.webViewLink && !item.trashed && (
            <div className="flex justify-between items-start">
              <span className="text-slate-500">URL Publik</span>
              <div className="flex items-center gap-1.5 max-w-[16rem]">
                <a
                  href={shareStatus.webViewLink}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-brand-500 hover:text-brand-600 truncate"
                >
                  {shareStatus.webViewLink}
                </a>
                <button
                  onClick={copyLink}
                  className="rounded p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-all shrink-0"
                  title="Salin link"
                >
                  {copied ? <span className="text-xs text-emerald-600">✓</span> : <Copy className="h-3 w-3" />}
                </button>
              </div>
            </div>
          )}

          <PropertyRow label="ID" value={item.id} mono truncate />
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <Button variant="ghost" onClick={onClose}>Tutup</Button>
        </div>
      </Card>
    </Modal>
  );
}

function PropertyRow({
  label,
  value,
  mono,
  truncate,
}: {
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="flex justify-between items-start gap-4">
      <span className="text-slate-500 shrink-0">{label}</span>
      <span
        className={`text-slate-900 text-right ${mono ? "font-mono text-xs" : "font-medium"} ${
          truncate ? "truncate max-w-[16rem]" : ""
        }`}
      >
        {value || "—"}
      </span>
    </div>
  );
}
