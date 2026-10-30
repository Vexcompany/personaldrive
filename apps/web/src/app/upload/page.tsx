"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Upload,
  Folder,
  Pause,
  Play,
  RotateCcw,
  X,
  CloudUpload,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { addFilesToPanel, useUploadPanel } from "@/hooks/useUploadPanel";
import { Button, Card, StatusBadge, ProgressBar, ErrorBanner } from "@/components/ui";
import { formatSize, formatSpeed, formatRemaining } from "@/lib/format";
import { DuplicateDialog, type DuplicateAction } from "@/components/DuplicateDialog";
import { UnlockPasswordModal } from "@/components/UnlockPasswordModal";
import { api } from "@/lib/api";
import type { ListFilesResponse } from "@personaldrive/shared";

export default function UploadPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slate-50 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-brand-400" />
        </main>
      }
    >
      <UploadInner />
    </Suspense>
  );
}

function UploadInner() {
  const { loading, isSpaceOwner } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const spaceId = useMemo(() => searchParams.get("spaceId") ?? null, [searchParams]);
  const folderId = useMemo(() => searchParams.get("folderId") ?? null, [searchParams]);

  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spaceName, setSpaceName] = useState<string>("");
  const [needOwnerModal, setNeedOwnerModal] = useState(false);

  const [dupDialog, setDupDialog] = useState<{
    open: boolean;
    count: number;
    firstName: string;
    pendingFiles: File[];
  }>({ open: false, count: 0, firstName: "", pendingFiles: [] });

  const panel = useUploadPanel();
  const { snapshot, files } = panel;

  const backHref = useMemo(() => {
    if (!spaceId) return "/";
    const params = new URLSearchParams({ spaceId });
    if (folderId) params.set("folderId", folderId);
    return `/drive?${params.toString()}`;
  }, [spaceId, folderId]);

  useEffect(() => {
    if (!loading && !spaceId) {
      router.replace("/");
    }
  }, [loading, spaceId, router]);

  useEffect(() => {
    if (loading || !spaceId) return;
    api
      .listFiles(spaceId, folderId)
      .then((res) => {
        setSpaceName(res.space.name);
        if (res.role !== "owner") {
          setNeedOwnerModal(true);
        }
      })
      .catch(() => {
        if (!isSpaceOwner(spaceId)) setNeedOwnerModal(true);
      });
  }, [loading, spaceId, folderId, isSpaceOwner]);

  const handleFiles = useCallback(
    async (rawFiles: File[]) => {
      if (!spaceId || rawFiles.length === 0) return;
      if (!isSpaceOwner(spaceId)) {
        setNeedOwnerModal(true);
        return;
      }
      setError(null);

      try {
        const listing: ListFilesResponse = await api.listFiles(spaceId, folderId);
        const existingNames = new Set(
          [...listing.files, ...listing.folders].map((f) => f.name.toLowerCase())
        );
        const duplicates = rawFiles.filter((f) => existingNames.has(f.name.toLowerCase()));
        if (duplicates.length > 0) {
          setDupDialog({
            open: true,
            count: duplicates.length,
            firstName: duplicates[0].name,
            pendingFiles: rawFiles,
          });
          return;
        }
      } catch {
        /* proceed without duplicate check */
      }

      addFilesToPanel(rawFiles, spaceId, folderId);
      router.push(backHref);
    },
    [spaceId, folderId, isSpaceOwner, router, backHref]
  );

  function handleDuplicateChoice(action: DuplicateAction) {
    if (!spaceId) return;
    const { pendingFiles } = dupDialog;
    setDupDialog({ open: false, count: 0, firstName: "", pendingFiles: [] });

    if (action === "skip") {
      api
        .listFiles(spaceId, folderId)
        .then((listing) => {
          const existingNames = new Set(
            [...listing.files, ...listing.folders].map((f) => f.name.toLowerCase())
          );
          const nonDuplicates = pendingFiles.filter((f) => !existingNames.has(f.name.toLowerCase()));
          if (nonDuplicates.length > 0) {
            addFilesToPanel(nonDuplicates, spaceId, folderId);
            router.push(backHref);
          }
        })
        .catch(() => {
          addFilesToPanel(pendingFiles, spaceId, folderId);
          router.push(backHref);
        });
      return;
    }

    if (action === "replace") {
      addFilesToPanel(pendingFiles, spaceId, folderId);
      router.push(backHref);
      return;
    }

    api
      .listFiles(spaceId, folderId)
      .then((listing) => {
        const existingNames = new Set(
          [...listing.files, ...listing.folders].map((f) => f.name.toLowerCase())
        );
        const renamed = pendingFiles.map((f) => {
          if (!existingNames.has(f.name.toLowerCase())) return f;
          const dotIdx = f.name.lastIndexOf(".");
          const base = dotIdx > 0 ? f.name.substring(0, dotIdx) : f.name;
          const ext = dotIdx > 0 ? f.name.substring(dotIdx) : "";
          let n = 1;
          let newName: string;
          do {
            newName = `${base} (${n})${ext}`;
            n++;
          } while (existingNames.has(newName.toLowerCase()));
          existingNames.add(newName.toLowerCase());
          return new File([f], newName, { type: f.type, lastModified: f.lastModified });
        });
        addFilesToPanel(renamed, spaceId, folderId);
        router.push(backHref);
      })
      .catch(() => {
        addFilesToPanel(pendingFiles, spaceId, folderId);
        router.push(backHref);
      });
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list || list.length === 0) return;
    void handleFiles(Array.from(list));
    e.target.value = "";
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const items = e.dataTransfer.items;
    const dropped: File[] = [];
    if (items && items.length && "webkitGetAsEntry" in items[0]) {
      const entries: FsEntry[] = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.() as FsEntry | null;
        if (entry) entries.push(entry);
      }
      collectEntries(entries, dropped).then(() => void handleFiles(dropped));
    } else {
      void handleFiles(Array.from(e.dataTransfer.files));
    }
  }

  if (!spaceId) return null;

  const pct = snapshot ? snapshot.fraction * 100 : 0;
  const allDone = files.length > 0 && files.every((f) => f.state === "completed" || f.state === "failed");

  return (
    <main className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 shadow-sm">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3">
          <Link
            href={backHref}
            className="inline-flex items-center gap-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-all"
          >
            <ArrowLeft className="h-4 w-4" />
            Drive
          </Link>
          <div className="h-4 w-px bg-slate-200" />
          <h1 className="text-sm font-semibold text-slate-900">Upload File</h1>
          {spaceName && <span className="text-xs text-slate-400 hidden sm:inline">ke {spaceName}</span>}
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-4">
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={`rounded-2xl border-2 border-dashed p-12 text-center transition-all duration-150 ${
            dragOver ? "border-brand-400 bg-brand-50 scale-[1.01]" : "border-slate-200 bg-white hover:border-slate-300"
          }`}
        >
          <div
            className={`inline-flex rounded-2xl p-4 mb-4 transition-colors ${
              dragOver ? "bg-brand-100" : "bg-slate-100"
            }`}
          >
            <CloudUpload className={`h-8 w-8 ${dragOver ? "text-brand-500" : "text-slate-400"}`} />
          </div>
          <p className="text-slate-700 font-medium mb-1">
            {dragOver ? "Lepaskan untuk mulai upload" : "Tarik & letakkan file di sini"}
          </p>
          <p className="text-sm text-slate-400 mb-6">atau pilih file maupun folder dari perangkatmu</p>
          <div className="flex justify-center gap-3 flex-wrap">
            <label className="inline-flex items-center gap-1.5 bg-brand-500 text-white hover:bg-brand-600 rounded-xl px-4 py-2 text-sm font-medium cursor-pointer transition-all shadow-sm">
              <Upload className="h-4 w-4" />
              Pilih File
              <input type="file" multiple className="hidden" onChange={onFileInput} />
            </label>
            <label className="inline-flex items-center gap-1.5 text-slate-700 hover:bg-slate-100 border border-slate-200 rounded-xl px-4 py-2 text-sm font-medium cursor-pointer transition-all">
              <Folder className="h-4 w-4 text-slate-400" />
              Pilih Folder
              <input
                type="file"
                multiple
                // @ts-expect-error — non-standard attribute supported by evergreen browsers
                webkitdirectory=""
                directory=""
                className="hidden"
                onChange={onFileInput}
              />
            </label>
          </div>
        </div>

        {snapshot && snapshot.totalFiles > 0 && (
          <Card className="p-5 animate-pop-in">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">
                  {allDone ? (
                    <span className="flex items-center gap-1.5 text-emerald-600">
                      <CheckCircle2 className="h-4 w-4" />
                      Upload selesai
                    </span>
                  ) : (
                    `Mengupload ${snapshot.uploadedFiles} / ${snapshot.totalFiles} file`
                  )}
                </div>
                <div className="text-xs text-slate-400 mt-0.5 tabular-nums">
                  {formatSize(snapshot.uploadedBytes)} / {formatSize(snapshot.totalBytes)}
                  {formatSpeed(snapshot.overallSpeedBps)}
                  {formatRemaining(snapshot.remainingSeconds)}
                </div>
              </div>
              <div className="text-lg font-semibold tabular-nums text-slate-700">{pct.toFixed(0)}%</div>
            </div>
            <ProgressBar value={pct} />

            <div className="flex flex-wrap gap-2 mt-3">
              {snapshot.queuedFiles > 0 && (
                <span className="text-xs text-slate-500 bg-slate-100 rounded-full px-2.5 py-0.5">
                  {snapshot.queuedFiles} antrean
                </span>
              )}
              {snapshot.retryingFiles > 0 && (
                <span className="text-xs text-amber-700 bg-amber-50 rounded-full px-2.5 py-0.5">
                  {snapshot.retryingFiles} mencoba ulang
                </span>
              )}
              {snapshot.failedFiles > 0 && (
                <span className="text-xs text-red-700 bg-red-50 rounded-full px-2.5 py-0.5 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  {snapshot.failedFiles} gagal
                </span>
              )}
              {snapshot.uploadedFiles > 0 && (
                <span className="text-xs text-emerald-700 bg-emerald-50 rounded-full px-2.5 py-0.5">
                  {snapshot.uploadedFiles} selesai
                </span>
              )}
            </div>
          </Card>
        )}

        {files.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                import("@/hooks/useUploadPanel").then((m) => m.retryAllFailedUploads());
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" /> Coba Ulang Gagal
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                import("@/hooks/useUploadPanel").then((m) => m.pauseAllUploads());
              }}
            >
              <Pause className="h-3.5 w-3.5" /> Jeda Semua
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                import("@/hooks/useUploadPanel").then((m) => m.resumeAllUploads());
              }}
            >
              <Play className="h-3.5 w-3.5" /> Lanjutkan Semua
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                import("@/hooks/useUploadPanel").then((m) => m.cancelAllUploads());
              }}
            >
              <X className="h-3.5 w-3.5" /> Batalkan Semua
            </Button>
            {allDone && (
              <Button variant="primary" size="sm" onClick={() => router.push(backHref)}>
                <ArrowLeft className="h-3.5 w-3.5" /> Kembali ke Drive
              </Button>
            )}
          </div>
        )}

        {files.length > 0 && (
          <Card className="overflow-hidden divide-y divide-slate-50">
            {files.map((f) => {
              const filePct = f.size > 0 ? (f.bytesUploaded / f.size) * 100 : 0;
              const isUploading = f.state === "uploading" || f.state === "retrying";
              return (
                <div key={f.id} className="px-4 py-3 flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-sm font-medium text-slate-800 truncate">{f.relativePath}</span>
                      <StatusBadge state={f.state} />
                    </div>

                    {(isUploading || f.state === "paused") && (
                      <div className="mb-1">
                        <ProgressBar value={filePct} />
                      </div>
                    )}

                    <div className="flex items-center gap-3 text-xs text-slate-400 tabular-nums">
                      <span>
                        {formatSize(f.bytesUploaded)} / {formatSize(f.size)}
                      </span>
                      {f.speedBps > 0 && <span>{formatSpeed(f.speedBps)}</span>}
                      {f.state === "failed" && f.errorMessage && (
                        <span className="text-red-500 truncate max-w-xs" title={f.errorMessage}>
                          {f.errorMessage}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0 mt-0.5">
                    {isUploading ? (
                      <button
                        className="rounded-lg p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                        onClick={() => import("@/hooks/useUploadPanel").then((m) => m.pauseFile(f.id))}
                        title="Jeda"
                      >
                        <Pause className="h-3.5 w-3.5" />
                      </button>
                    ) : f.state === "paused" ? (
                      <button
                        className="rounded-lg p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                        onClick={() => import("@/hooks/useUploadPanel").then((m) => m.resumeFile(f.id))}
                        title="Lanjutkan"
                      >
                        <Play className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                    {f.state === "failed" && (
                      <button
                        className="rounded-lg p-1.5 text-slate-400 hover:text-brand-600 hover:bg-brand-50"
                        onClick={() => import("@/hooks/useUploadPanel").then((m) => m.retryFile(f.id))}
                        title="Coba ulang"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {(f.state === "uploading" ||
                      f.state === "queued" ||
                      f.state === "paused" ||
                      f.state === "failed") && (
                      <button
                        className="rounded-lg p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50"
                        onClick={() => import("@/hooks/useUploadPanel").then((m) => m.cancelFile(f.id))}
                        title="Batalkan"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </Card>
        )}
      </div>

      <DuplicateDialog
        open={dupDialog.open}
        count={dupDialog.count}
        firstName={dupDialog.firstName}
        onChoose={handleDuplicateChoice}
        onCancel={() => setDupDialog({ open: false, count: 0, firstName: "", pendingFiles: [] })}
      />

      {needOwnerModal && (
        <UnlockPasswordModal
          open={needOwnerModal}
          spaceId={spaceId}
          folderId={spaceId}
          folderName={spaceName || "Ruang"}
          asOwner
          onSuccess={() => setNeedOwnerModal(false)}
          onClose={() => router.replace(backHref)}
        />
      )}
    </main>
  );
}

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  createReader(): { readEntries(cb: (entries: FsEntry[]) => void): void };
  file(cb: (f: File) => void): void;
}

function collectEntries(entries: FsEntry[], out: File[]): Promise<void> {
  return Promise.all(
    entries.map(
      (entry) =>
        new Promise<void>((resolve) => {
          if (entry.isFile) {
            entry.file((f) => {
              try {
                Object.defineProperty(f, "webkitRelativePath", { value: entry.fullPath.replace(/^\//, "") });
              } catch {
                /* ignore */
              }
              out.push(f);
              resolve();
            });
          } else if (entry.isDirectory) {
            const reader = entry.createReader();
            const all: FsEntry[] = [];
            const read = () => {
              reader.readEntries((batch) => {
                if (batch.length === 0) {
                  collectEntries(all, out).then(resolve);
                } else {
                  all.push(...batch);
                  read();
                }
              });
            };
            read();
          } else {
            resolve();
          }
        })
    )
  ).then(() => undefined);
}
