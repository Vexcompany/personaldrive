"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { api, ApiError, batchOperation } from "@/lib/api";
import { formatSize, formatDate, typeLabel } from "@/lib/format";
import { PropertiesPanel } from "@/components/PropertiesPanel";
import { UnlockPasswordModal } from "@/components/UnlockPasswordModal";
import {
  Trash2,
  Folder,
  FileText,
  Image as ImageIcon,
  Video,
  Music,
  FileArchive,
  FileSpreadsheet,
  Presentation,
  File,
  Search,
  X,
  ArrowUp,
  ArrowDown,
  RotateCcw,
  LayoutGrid,
  List,
  House,
  ChevronRight,
  Loader2,
  SlidersHorizontal,
  Info,
  Eye,
  Check,
} from "lucide-react";
import {
  Button,
  Card,
  Skeleton,
  ErrorBanner,
  ContextMenu,
  ConfirmDialog,
} from "@/components/ui";
import type { DriveFile, TrashListResponse, TrashSearchResponse } from "@personaldrive/shared";
import { showToast } from "@/stores/useToastStore";

type ViewMode = "grid" | "list";
type SortKey = "name" | "modified" | "size" | "type";
type SortDir = "asc" | "desc";

const VIEW_KEY = "personaldrive.trash.view";
const SORT_KEY = "personaldrive.trash.sortKey";
const SORT_DIR_KEY = "personaldrive.trash.sortDir";

function readLocal<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (raw as unknown as T);
  } catch {
    return fallback;
  }
}

export default function TrashPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slate-50 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-brand-400" />
        </main>
      }
    >
      <TrashInner />
    </Suspense>
  );
}

function TrashInner() {
  const { token, loading: authLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const spaceId = useMemo(() => searchParams.get("spaceId") ?? null, [searchParams]);

  const [data, setData] = useState<TrashListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [needOwnerModal, setNeedOwnerModal] = useState(false);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TrashSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);

  const [view, setView] = useState<ViewMode>(() => readLocal<ViewMode>(VIEW_KEY, "list"));
  const [sortKey, setSortKey] = useState<SortKey>(() => readLocal<SortKey>(SORT_KEY, "name"));
  const [sortDir, setSortDir] = useState<SortDir>(() => readLocal<SortDir>(SORT_DIR_KEY, "asc"));
  const [showSortMenu, setShowSortMenu] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClicked = useRef<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; item: DriveFile } | null>(null);
  const [propsItem, setPropsItem] = useState<DriveFile | null>(null);

  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  }>({ open: false, title: "", message: "", onConfirm: () => {} });
  const [confirmLoading, setConfirmLoading] = useState(false);

  useEffect(() => {
    if (!authLoading && !spaceId) router.replace("/");
  }, [authLoading, spaceId, router]);

  const refresh = useCallback(async () => {
    if (!spaceId) return;
    setLoadingFiles(true);
    setError(null);
    try {
      const next = await api.listTrash(spaceId);
      setData(next);
      setNeedOwnerModal(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setNeedOwnerModal(true);
      } else {
        setError(err instanceof Error ? err.message : "Gagal memuat Sampah.");
      }
    } finally {
      setLoadingFiles(false);
    }
  }, [spaceId]);

  useEffect(() => {
    if (!authLoading && spaceId) void refresh();
  }, [authLoading, spaceId, token, refresh]);

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_KEY, view);
      window.localStorage.setItem(SORT_KEY, sortKey);
      window.localStorage.setItem(SORT_DIR_KEY, sortDir);
    } catch {
      /* ignore */
    }
  }, [view, sortKey, sortDir]);

  useEffect(() => {
    if (!spaceId) return;
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = window.setTimeout(() => {
      api
        .searchTrash(spaceId, q)
        .then((r) => setResults(r))
        .catch((err) => setError(err instanceof Error ? err.message : "Pencarian gagal."))
        .finally(() => setSearching(false));
    }, 180);
    return () => window.clearTimeout(t);
  }, [query, spaceId]);

  const isSearching = Boolean(query.trim()) && results !== null;

  const ordered = useMemo(() => {
    const folders: DriveFile[] = results ? results.folders : (data?.folders ?? []);
    const files: DriveFile[] = results ? results.files : (data?.files ?? []);
    return [
      ...[...folders].sort((a, b) => compareItems(a, b, sortKey, sortDir)),
      ...[...files].sort((a, b) => compareItems(a, b, sortKey, sortDir)),
    ];
  }, [results, data, sortKey, sortDir]);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastClicked.current = id;
  }

  async function restoreIds(ids: string[]) {
    if (!spaceId || ids.length === 0) return;
    try {
      const res = await batchOperation(ids, async (chunk) => {
        const r = await api.restoreItems({ spaceId, fileIds: chunk });
        return { succeeded: r.restored, failed: r.failed };
      });
      setSelected(new Set());
      showToast(`${res.succeeded.length} item berhasil dipulihkan`);
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal memulihkan item.");
    }
  }

  function requestDeleteForever(ids: string[]) {
    if (!spaceId || ids.length === 0) return;
    setConfirmDialog({
      open: true,
      title: "Hapus Permanen",
      message: `Hapus ${ids.length} item secara permanen? Tindakan ini tidak dapat dibatalkan.`,
      onConfirm: async () => {
        setConfirmLoading(true);
        try {
          const res = await batchOperation(ids, async (chunk) => {
            const r = await api.deleteForever({ spaceId, fileIds: chunk });
            return { succeeded: r.deleted, failed: r.failed };
          });
          setSelected(new Set());
          showToast(`${res.succeeded.length} item dihapus permanen`);
          void refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Gagal menghapus permanen.");
        } finally {
          setConfirmLoading(false);
          setConfirmDialog((d) => ({ ...d, open: false }));
        }
      },
    });
  }

  if (!spaceId) return null;

  const selectedCount = selected.size;
  const sortLabels: Record<SortKey, string> = {
    name: "Nama",
    modified: "Terakhir diubah",
    size: "Ukuran",
    type: "Tipe",
  };

  const ctxMenuItems = ctxMenu
    ? [
        {
          label: "Pulihkan",
          icon: <RotateCcw className="h-4 w-4" />,
          onClick: () => void restoreIds([ctxMenu.item.id]),
        },
        ...(ctxMenu.item.mimeType !== "application/vnd.google-apps.folder"
          ? [
              {
                label: "Preview",
                icon: <Eye className="h-4 w-4" />,
                onClick: () =>
                  router.push(
                    `/preview?spaceId=${encodeURIComponent(spaceId)}&id=${encodeURIComponent(ctxMenu.item.id)}`
                  ),
              },
            ]
          : []),
        {
          label: "Properti",
          icon: <Info className="h-4 w-4" />,
          onClick: () => setPropsItem(ctxMenu.item),
        },
        {
          label: "Hapus Permanen",
          icon: <Trash2 className="h-4 w-4" />,
          onClick: () => requestDeleteForever([ctxMenu.item.id]),
          danger: true,
        },
      ]
    : [];

  return (
    <main className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Link
              href={`/drive?spaceId=${encodeURIComponent(spaceId)}`}
              className="flex items-center gap-1.5 text-brand-600 hover:text-brand-700 font-semibold text-sm shrink-0"
            >
              <House className="h-4 w-4" />
              <span>Kembali ke Drive</span>
            </Link>
            <ChevronRight className="h-3.5 w-3.5 text-slate-300" />
            <span className="text-sm font-medium text-slate-900 flex items-center gap-1.5">
              <Trash2 className="h-4 w-4 text-slate-400" />
              Sampah
            </span>
          </div>

          {ordered.length > 0 && (
            <Button
              variant="danger"
              size="sm"
              onClick={() => requestDeleteForever(ordered.map((i) => i.id))}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Kosongkan Sampah
            </Button>
          )}
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 space-y-4">
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cari item di Sampah…"
              className="w-full pl-9 pr-10 py-2 text-sm rounded-xl border border-slate-200 bg-white shadow-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100"
            />
            {searching && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-brand-400 animate-spin" />
            )}
            {query && !searching && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="flex gap-2 items-center">
            <div className="relative">
              <button
                onClick={() => setShowSortMenu((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm hover:bg-slate-50"
              >
                <SlidersHorizontal className="h-4 w-4 text-slate-400" />
                <span className="hidden sm:inline">{sortLabels[sortKey]}</span>
              </button>
              {showSortMenu && (
                <div className="absolute right-0 top-full mt-1 z-30 w-44 rounded-xl border border-slate-200 bg-white shadow-lg py-1 animate-pop-in">
                  {(Object.keys(sortLabels) as SortKey[]).map((k) => (
                    <button
                      key={k}
                      onClick={() => {
                        setSortKey(k);
                        setShowSortMenu(false);
                      }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center justify-between ${
                        sortKey === k ? "text-brand-600 font-medium" : "text-slate-700"
                      }`}
                    >
                      {sortLabels[k]}
                      {sortKey === k && <Check className="h-4 w-4" />}
                    </button>
                  ))}
                  <div className="h-px bg-slate-100 my-1" />
                  <button
                    onClick={() => {
                      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                      setShowSortMenu(false);
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 text-slate-700 flex items-center gap-2"
                  >
                    {sortDir === "asc" ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
                    {sortDir === "asc" ? "A → Z" : "Z → A"}
                  </button>
                </div>
              )}
            </div>

            <div className="flex rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
              <button
                onClick={() => setView("list")}
                className={`px-3 py-2 ${view === "list" ? "bg-brand-500 text-white" : "text-slate-500 hover:bg-slate-50"}`}
              >
                <List className="h-4 w-4" />
              </button>
              <button
                onClick={() => setView("grid")}
                className={`px-3 py-2 border-l border-slate-200 ${
                  view === "grid" ? "bg-brand-500 text-white" : "text-slate-500 hover:bg-slate-50"
                }`}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        {selectedCount > 0 && (
          <Card className="px-4 py-2.5 flex flex-wrap items-center gap-2 animate-pop-in border-brand-100 bg-brand-50/50">
            <span className="text-sm font-medium text-brand-700 mr-1">{selectedCount} dipilih</span>
            <div className="h-4 w-px bg-brand-200" />
            <Button variant="primary" size="sm" onClick={() => void restoreIds([...selected])}>
              <RotateCcw className="h-3.5 w-3.5" />
              Pulihkan
            </Button>
            <Button variant="danger" size="sm" onClick={() => requestDeleteForever([...selected])}>
              <Trash2 className="h-3.5 w-3.5" />
              Hapus Permanen
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              <X className="h-3.5 w-3.5" />
              Batal
            </Button>
          </Card>
        )}

        <Card className="overflow-hidden">
          {loadingFiles && !data && (
            <div className="p-4 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full rounded-lg" />
              ))}
            </div>
          )}

          {!loadingFiles && data && ordered.length === 0 && (
            <div className="py-20 px-6 text-center">
              <div className="inline-flex rounded-2xl bg-slate-100 p-5 mb-4">
                <Trash2 className="h-8 w-8 text-slate-400" />
              </div>
              <p className="font-semibold text-slate-700">
                {isSearching ? "Tidak ada item yang cocok di Sampah" : "Sampah kosong"}
              </p>
              <p className="text-sm text-slate-400 mt-1">
                Item yang dihapus dari ruang ini akan muncul di sini.
              </p>
            </div>
          )}

          {ordered.length > 0 && view === "list" && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/80">
                    <th className="w-10 px-4 py-3">
                      <input
                        type="checkbox"
                        className="accent-brand-500 rounded"
                        checked={selectedCount === ordered.length && ordered.length > 0}
                        onChange={(e) =>
                          setSelected(e.target.checked ? new Set(ordered.map((i) => i.id)) : new Set())
                        }
                      />
                    </th>
                    <th className="px-3 py-3 text-left font-medium text-slate-500 text-xs uppercase">Nama</th>
                    <th className="px-3 py-3 hidden sm:table-cell text-left font-medium text-slate-500 text-xs uppercase">
                      Tipe
                    </th>
                    <th className="px-3 py-3 hidden md:table-cell text-left font-medium text-slate-500 text-xs uppercase">
                      Ukuran
                    </th>
                    <th className="px-3 py-3 hidden md:table-cell text-left font-medium text-slate-500 text-xs uppercase">
                      Diubah
                    </th>
                    <th className="w-1 px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {ordered.map((item) => {
                    const isFolder = item.mimeType === "application/vnd.google-apps.folder";
                    const isSel = selected.has(item.id);
                    return (
                      <tr
                        key={item.id}
                        onClick={() => toggleSelect(item.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setCtxMenu({ x: e.clientX, y: e.clientY, item });
                        }}
                        className={`group border-b border-slate-50 last:border-0 cursor-pointer ${
                          isSel ? "bg-brand-50" : "hover:bg-slate-50"
                        }`}
                      >
                        <td className="w-10 px-4 py-2.5">
                          <input
                            type="checkbox"
                            className="accent-brand-500"
                            checked={isSel}
                            onChange={() => toggleSelect(item.id)}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <TrashIcon mime={item.mimeType} isFolder={isFolder} />
                            <span className="truncate font-medium text-slate-800">{item.name}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 hidden sm:table-cell text-slate-500 text-xs">
                          {isFolder ? "Folder" : typeLabel(item.mimeType)}
                        </td>
                        <td className="px-3 py-2.5 hidden md:table-cell text-slate-500 text-xs tabular-nums">
                          {isFolder ? "—" : formatSize(item.size)}
                        </td>
                        <td className="px-3 py-2.5 hidden md:table-cell text-slate-500 text-xs tabular-nums">
                          {formatDate(item.modifiedTime)}
                        </td>
                        <td className="px-4 py-2.5 text-right whitespace-nowrap">
                          <span className="inline-flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                void restoreIds([item.id]);
                              }}
                              className="rounded-lg p-1.5 text-slate-400 hover:text-brand-600 hover:bg-brand-50"
                              title="Pulihkan"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                requestDeleteForever([item.id]);
                              }}
                              className="rounded-lg p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50"
                              title="Hapus Permanen"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {ordered.length > 0 && view === "grid" && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 p-4">
              {ordered.map((item) => {
                const isFolder = item.mimeType === "application/vnd.google-apps.folder";
                const isSel = selected.has(item.id);
                return (
                  <div
                    key={item.id}
                    onClick={() => toggleSelect(item.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCtxMenu({ x: e.clientX, y: e.clientY, item });
                    }}
                    className={`relative flex flex-col items-center rounded-2xl border p-4 cursor-pointer ${
                      isSel ? "border-brand-300 bg-brand-50" : "border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    <TrashIcon mime={item.mimeType} isFolder={isFolder} large />
                    <span className="text-xs font-medium text-slate-800 truncate w-full text-center mt-2">
                      {item.name}
                    </span>
                    <span className="text-[11px] text-slate-400 mt-0.5">
                      {isFolder ? "Folder" : formatSize(item.size)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {propsItem && (
        <PropertiesPanel
          item={propsItem}
          breadcrumb={[]}
          spaceName="Sampah"
          isOwner
          onClose={() => setPropsItem(null)}
        />
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenuItems}
          onClose={() => setCtxMenu(null)}
        />
      )}

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel="Hapus Permanen"
        loading={confirmLoading}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog((d) => ({ ...d, open: false }))}
      />

      {needOwnerModal && (
        <UnlockPasswordModal
          open={needOwnerModal}
          spaceId={spaceId}
          folderId={spaceId}
          folderName="Sampah Ruang"
          asOwner
          onSuccess={() => {
            setNeedOwnerModal(false);
            void refresh();
          }}
          onClose={() => router.replace(`/drive?spaceId=${encodeURIComponent(spaceId)}`)}
        />
      )}
    </main>
  );
}

function TrashIcon({ mime, isFolder, large }: { mime: string; isFolder: boolean; large?: boolean }) {
  const cls = large ? "h-10 w-10 text-slate-400" : "h-4 w-4 text-slate-400 shrink-0";
  if (isFolder) return <Folder className={cls} />;
  if (mime.startsWith("image/")) return <ImageIcon className={cls} />;
  if (mime.startsWith("video/")) return <Video className={cls} />;
  if (mime.startsWith("audio/")) return <Music className={cls} />;
  if (mime === "application/pdf" || mime.startsWith("text/")) return <FileText className={cls} />;
  if (mime.includes("zip") || mime.includes("compressed")) return <FileArchive className={cls} />;
  if (mime.includes("spreadsheet")) return <FileSpreadsheet className={cls} />;
  if (mime.includes("presentation")) return <Presentation className={cls} />;
  return <File className={cls} />;
}

function compareItems(a: DriveFile, b: DriveFile, key: SortKey, dir: SortDir): number {
  let r = 0;
  switch (key) {
    case "name":
      r = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
      break;
    case "modified":
      r = (Date.parse(a.modifiedTime ?? "") || 0) - (Date.parse(b.modifiedTime ?? "") || 0);
      break;
    case "size":
      r = (a.size ?? 0) - (b.size ?? 0);
      break;
    case "type":
      r = typeLabel(a.mimeType).localeCompare(typeLabel(b.mimeType));
      break;
  }
  return dir === "asc" ? r : -r;
}
