"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { api, ApiError, batchOperation } from "@/lib/api";
import { downloadSelected } from "@/lib/download";
import { formatSize, formatDate, typeLabel } from "@/lib/format";
import { addFilesToPanel, useUploadCompletionVersion } from "@/hooks/useUploadPanel";
import { setFolderCover, useFolderCoverVersion } from "@/stores/useFolderCoverStore";
import { showToast } from "@/stores/useToastStore";
import { getFolderCoverUrl } from "@/components/FolderCoverImage";
import { FolderStatsDisplay } from "@/components/FolderStatsDisplay";
import { PropertiesPanel } from "@/components/PropertiesPanel";
import { StorageIndicator } from "@/components/StorageIndicator";
import { UnlockPasswordModal } from "@/components/UnlockPasswordModal";
import { FolderSecurityModal } from "@/components/FolderSecurityModal";
import {
  Folder,
  FolderLock,
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
  LayoutGrid,
  List,
  Upload,
  LogOut,
  Trash2,
  Download,
  Link as LinkIcon,
  Pencil,
  FolderOpen,
  FolderPlus,
  MoveRight,
  Check,
  House,
  ChevronRight,
  Loader2,
  SlidersHorizontal,
  Info,
  ImagePlus,
  CloudUpload,
  Eye,
  EyeOff,
  Clipboard,
  Lock,
  LockOpen,
  Globe,
  KeyRound,
  Settings,
  ShieldCheck,
} from "lucide-react";
import {
  Button,
  Badge,
  Card,
  Spinner,
  Skeleton,
  Modal,
  ErrorBanner,
  Toast,
  ContextMenu,
  ConfirmDialog,
} from "@/components/ui";
import type {
  DriveFile,
  DriveFolder,
  ListFilesResponse,
  SearchResponse,
  ShareStatusResponse,
} from "@personaldrive/shared";

type ViewMode = "grid" | "list";
type SortKey = "name" | "modified" | "size" | "type";
type SortDir = "asc" | "desc";

const SCROLL_KEY = "personaldrive.scrollY";

export default function DrivePage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slate-50 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-brand-400" />
        </main>
      }
    >
      <DriveInner />
    </Suspense>
  );
}

function DriveInner() {
  const { token, loading: authLoading, logoutSpace } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const spaceId = useMemo(() => searchParams.get("spaceId") ?? null, [searchParams]);
  const folderId = useMemo(() => searchParams.get("folderId") ?? null, [searchParams]);

  const [data, setData] = useState<ListFilesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);

  // Create Subfolder Modal state
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderPassword, setNewFolderPassword] = useState("");
  const [showNewFolderPw, setShowNewFolderPw] = useState(false);
  const [newFolderBusy, setNewFolderBusy] = useState(false);

  // Rename state
  const [renaming, setRenaming] = useState<DriveFile | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Unlock / Owner login modal state
  const [unlockModal, setUnlockModal] = useState<{
    folderId: string;
    folderName: string;
    asOwner: boolean;
    navigateFolderAfter?: string | null;
    blockingPage?: boolean;
  } | null>(null);

  // Security settings modal (root space or subfolder)
  const [securityModal, setSecurityModal] = useState<{
    subfolder: {
      id: string;
      name: string;
      visibility: "public" | "locked";
      isLocked: boolean;
    } | null;
  } | null>(null);

  // Search state
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);

  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  function saveRecentSearch(q: string) {
    const trimmed = q.trim();
    if (!trimmed) return;
    setRecentSearches((prev) => {
      const next = [trimmed, ...prev.filter((s) => s.toLowerCase() !== trimmed.toLowerCase())].slice(0, 8);
       return next;
    });
  }

  function clearRecentSearches() {
    setRecentSearches([]);
   }

  const [view, setView] = useState<ViewMode>("list");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [showSortMenu, setShowSortMenu] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClicked = useRef<string | null>(null);

  const [shareItem, setShareItem] = useState<DriveFile | null>(null);
  const [shareStatus, setShareStatus] = useState<ShareStatusResponse | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);

  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTargets, setMoveTargets] = useState<string[]>([]);
  const [moveFolderId, setMoveFolderId] = useState<string | null>(null);
  const [moveFolders, setMoveFolders] = useState<DriveFolder[]>([]);
  const [moveCrumbs, setMoveCrumbs] = useState<{ id: string; name: string }[]>([]);
  const [moveBusy, setMoveBusy] = useState(false);

  const [propsItem, setPropsItem] = useState<DriveFile | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; item: DriveFile } | null>(null);

  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean;
    title: string;
    message: string;
    ids: string[];
  }>({ open: false, title: "", message: "", ids: [] });
  const [deleteBusy, setDeleteBusy] = useState(false);

  const [dragOver, setDragOver] = useState(false);

  useFolderCoverVersion();

  const [toast, setToast] = useState<{
    visible: boolean;
    message: string;
    undoIds: string[];
    restoring: boolean;
  }>({
    visible: false,
    message: "",
    undoIds: [],
    restoring: false,
  });
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isOwner = data?.role === "owner";

  useEffect(() => {
    if (!authLoading && !spaceId) {
      router.replace("/");
    }
  }, [authLoading, spaceId, router]);

  function showTrashToast(ids: string[], count: number) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({
      visible: true,
      message: `${count} item dipindahkan ke Sampah`,
      undoIds: ids,
      restoring: false,
    });
    toastTimer.current = setTimeout(() => setToast((t) => ({ ...t, visible: false })), 6000);
  }

  async function undoTrash() {
    if (!spaceId) return;
    const ids = toast.undoIds;
    if (ids.length === 0 || toast.restoring) return;
    setToast((t) => ({ ...t, restoring: true }));
    try {
      await api.restoreItems({ spaceId, fileIds: ids });
      setToast({ visible: false, message: "", undoIds: [], restoring: false });
      showToast("Berhasil dipulihkan");
      void refresh(folderId);
    } catch {
      setToast((t) => ({ ...t, restoring: false }));
      showToast("Gagal memulihkan item", { type: "error" });
    }
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  function buildDriveUrl(nextFolderId: string | null): string {
    if (!spaceId) return "/";
    const params = new URLSearchParams({ spaceId });
    if (nextFolderId) params.set("folderId", nextFolderId);
    return `/drive?${params.toString()}`;
  }

  function navigateToFolder(id: string | null) {
    router.push(buildDriveUrl(id));
  }

  function openItem(item: DriveFile) {
    if (!spaceId) return;
    if (item.mimeType === "application/vnd.google-apps.folder") {
      if (item.isLocked && !item.isUnlocked && !isOwner) {
        setUnlockModal({
          folderId: item.id,
          folderName: item.name,
          asOwner: false,
          navigateFolderAfter: item.id,
          blockingPage: false,
        });
        return;
      }
      navigateToFolder(item.id);
    } else {
      try {
        sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
      } catch {
        /* ignore */
      }
      const params = new URLSearchParams({ spaceId, id: item.id });
      if (folderId) params.set("folderId", folderId);
      router.push(`/preview?${params.toString()}`);
    }
  }

  // ── Data fetching ───────────────────────────────────────────────────────

  const refresh = useCallback(
    async (id: string | null) => {
      if (!spaceId) return;
      setLoadingFiles(true);
      setError(null);
      try {
        const next = await api.listFiles(spaceId, id);
        setData(next);
        setUnlockModal((prev) => (prev?.blockingPage ? null : prev));
      } catch (err) {
        if (err instanceof ApiError && err.code === "FOLDER_LOCKED") {
          setUnlockModal({
            folderId: err.lockedFolderId ?? id ?? spaceId,
            folderName: err.lockedFolderName ?? "Folder Terkunci",
            asOwner: false,
            navigateFolderAfter: undefined,
            blockingPage: true,
          });
        } else {
          setError(err instanceof Error ? err.message : "Gagal memuat daftar file.");
        }
      } finally {
        setLoadingFiles(false);
      }
    },
    [spaceId]
  );

  const silentRefresh = useCallback(
    async (id: string | null) => {
      if (!spaceId) return;
      try {
        const next = await api.listFiles(spaceId, id);
        setData(next);
      } catch {
        /* ignore background error */
      }
    },
    [spaceId]
  );

  useEffect(() => {
    if (!authLoading && spaceId) {
      void refresh(folderId);
    }
  }, [authLoading, spaceId, folderId, token, refresh]);

  const uploadCompletionVersion = useUploadCompletionVersion(spaceId, folderId);
  const prevUploadVersion = useRef(uploadCompletionVersion);
  const prevUploadTarget = useRef(`${spaceId}:${folderId}`);

  useEffect(() => {
    const curTarget = `${spaceId}:${folderId}`;
    if (curTarget !== prevUploadTarget.current) {
      prevUploadTarget.current = curTarget;
      prevUploadVersion.current = uploadCompletionVersion;
      return;
    }
    if (uploadCompletionVersion > 0 && uploadCompletionVersion > prevUploadVersion.current) {
      prevUploadVersion.current = uploadCompletionVersion;
      const scrollY = window.scrollY;
      void silentRefresh(folderId).then(() => {
        window.scrollTo(0, scrollY);
      });
    }
  }, [uploadCompletionVersion, spaceId, folderId, silentRefresh]);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(SCROLL_KEY);
      if (saved != null) {
        sessionStorage.removeItem(SCROLL_KEY);
        const y = Number(saved);
        if (Number.isFinite(y)) window.scrollTo(0, y);
      }
    } catch {
      /* ignore */
    }
  }, []);

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
        .search(spaceId, q)
        .then((r) => {
          setResults(r);
          saveRecentSearch(q);
        })
        .catch((err) => setError(err instanceof Error ? err.message : "Pencarian gagal."))
        .finally(() => setSearching(false));
    }, 180);
    return () => window.clearTimeout(t);
  }, [query, spaceId, token]);

  useEffect(() => {
    setSelected(new Set());
    lastClicked.current = null;
  }, [spaceId, folderId, query]);

  const isSearching = Boolean(query.trim()) && results !== null;

  const folders = useMemo(() => {
    const src: DriveFile[] = results ? results.folders : (data?.folders ?? []);
    return [...src].sort((a, b) => compareItems(a, b, sortKey, sortDir));
  }, [results, data, sortKey, sortDir]);

  const files = useMemo(() => {
    const src: DriveFile[] = results ? results.files : (data?.files ?? []);
    return [...src].sort((a, b) => compareItems(a, b, sortKey, sortDir));
  }, [results, data, sortKey, sortDir]);

  const ordered = useMemo(() => [...folders, ...files], [folders, files]);

  // ── Actions ─────────────────────────────────────────────────────────────

  async function createFolder(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!spaceId || !newFolderName.trim() || newFolderBusy || (newFolderPassword.length > 0 && newFolderPassword.length < 8)) return;
    setNewFolderBusy(true);
    try {
      const pw = newFolderPassword;
      await api.createFolder({
        spaceId,
        name: newFolderName.trim(),
        parentId: folderId,
        ...(pw ? { password: pw } : {}),
      });
      setNewFolderName("");
      setNewFolderPassword("");
      setShowNewFolderPw(false);
      setShowNewFolder(false);
      showToast(pw ? "Subfolder terkunci berhasil dibuat" : "Subfolder publik berhasil dibuat");
      void refresh(folderId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal membuat subfolder.");
    } finally {
      setNewFolderBusy(false);
    }
  }

  function requestDeleteOne(item: DriveFile) {
    const isFolder = item.mimeType === "application/vnd.google-apps.folder";
    setDeleteConfirm({
      open: true,
      title: "Pindahkan ke Sampah",
      message: isFolder
        ? `Pindahkan folder "${item.name}" beserta seluruh isinya ke Sampah?`
        : `Pindahkan "${item.name}" ke Sampah? Kamu masih bisa memulihkannya nanti.`,
      ids: [item.id],
    });
  }

  function requestDeleteSelected() {
    if (!isOwner) return;
    const ids = [...selected];
    if (ids.length === 0) return;
    setDeleteConfirm({
      open: true,
      title: "Pindahkan ke Sampah",
      message: `Pindahkan ${ids.length} item terpilih ke Sampah?`,
      ids,
    });
  }

  async function confirmDelete() {
    if (!spaceId) return;
    setDeleteBusy(true);
    try {
      const result = await batchOperation(deleteConfirm.ids, async (chunk) => {
        const res = await api.trashItems({ spaceId, fileIds: chunk });
        return { succeeded: res.trashed, failed: res.failed ?? [] };
      });
      setSelected(new Set());
      if (result.failed.length > 0) {
        setError(`${result.failed.length} item gagal dipindahkan ke Sampah.`);
      }
      if (result.succeeded.length > 0) {
        showTrashToast(result.succeeded, result.succeeded.length);
      }
      void refresh(folderId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menghapus item.");
    } finally {
      setDeleteBusy(false);
      setDeleteConfirm((d) => ({ ...d, open: false }));
    }
  }

  async function handleDownloadItems(items: DriveFile[]) {
    if (items.length === 0) return;
    // Block downloading locked folders that haven't been unlocked yet
    const locked = items.find(
      (i) => i.mimeType === "application/vnd.google-apps.folder" && i.isLocked && !i.isUnlocked && !isOwner
    );
    if (locked) {
      setUnlockModal({
        folderId: locked.id,
        folderName: locked.name,
        asOwner: false,
        blockingPage: false,
      });
      return;
    }
    try {
      await downloadSelected(items);
    } catch (err) {
      if (err instanceof ApiError && err.code === "FOLDER_LOCKED") {
        setUnlockModal({
          folderId: err.lockedFolderId ?? spaceId ?? "",
          folderName: err.lockedFolderName ?? "Folder Terkunci",
          asOwner: false,
          blockingPage: false,
        });
      } else {
        setError(err instanceof Error ? err.message : "Download gagal.");
      }
    }
  }

  async function submitRename() {
    if (!spaceId || !renaming || !renameValue.trim()) return;
    try {
      await api.rename({ spaceId, fileId: renaming.id, name: renameValue.trim() });
      setRenaming(null);
      setRenameValue("");
      showToast("Nama berhasil diubah");
      void refresh(folderId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal mengubah nama.");
    }
  }

  // ── Upload handling (Owner only) ────────────────────────────────────────

  function promptOwnerLogin() {
    if (!spaceId) return;
    setUnlockModal({
      folderId: spaceId,
      folderName: data?.space.name ?? "Ruang",
      asOwner: true,
      blockingPage: false,
    });
  }

  function handleUploadFiles(fileList: FileList | File[]) {
    if (!spaceId) return;
    if (!isOwner) {
      showToast("Masuk sebagai Pemilik untuk mengupload file", { type: "info" });
      promptOwnerLogin();
      return;
    }
    const rawFiles = Array.from(fileList);
    if (rawFiles.length === 0) return;
    addFilesToPanel(rawFiles, spaceId, folderId);
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list || list.length === 0) return;
    handleUploadFiles(list);
    e.target.value = "";
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (!spaceId) return;
    if (!isOwner) {
      showToast("Masuk sebagai Pemilik untuk mengupload file", { type: "info" });
      promptOwnerLogin();
      return;
    }
    const rawFiles: File[] = [];
    const items = e.dataTransfer.items;
    if (items && items.length && "webkitGetAsEntry" in items[0]) {
      const entries: FsEntry[] = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.() as FsEntry | null;
        if (entry) entries.push(entry);
      }
      collectEntries(entries, rawFiles).then(() => {
        if (rawFiles.length > 0) addFilesToPanel(rawFiles, spaceId, folderId);
      });
    } else {
      handleUploadFiles(e.dataTransfer.files);
    }
  }

  // ── Selection ───────────────────────────────────────────────────────────

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastClicked.current = id;
  }

  function selectRange(fromId: string, toId: string) {
    const ids = ordered.map((i) => i.id);
    const a = ids.indexOf(fromId);
    const b = ids.indexOf(toId);
    if (a === -1 || b === -1) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    setSelected(new Set(ids.slice(lo, hi + 1)));
  }

  function handleRowClick(e: React.MouseEvent, item: DriveFile) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      toggleSelect(item.id);
      return;
    }
    if (e.shiftKey && lastClicked.current) {
      e.preventDefault();
      selectRange(lastClicked.current, item.id);
      return;
    }
    toggleSelect(item.id);
  }

  // ── Share ───────────────────────────────────────────────────────────────

  async function openShare(item: DriveFile) {
    if (!isOwner) return;
    setShareItem(item);
    setShareStatus(null);
    setShareCopied(false);
    try {
      const status = await api.shareStatus(item.id);
      setShareStatus(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal memeriksa status link.");
      setShareItem(null);
    }
  }

  async function makePublicLink() {
    if (!spaceId || !shareItem || shareBusy) return;
    setShareBusy(true);
    try {
      const { webViewLink } = await api.share(spaceId, shareItem.id);
      setShareStatus({ public: true, role: "reader", webViewLink });
      showToast("Link Google Drive publik berhasil dibuat");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal membagikan file.");
    } finally {
      setShareBusy(false);
    }
  }

  async function copyShareLink() {
    if (!shareStatus?.webViewLink) return;
    try {
      await navigator.clipboard.writeText(shareStatus.webViewLink);
      setShareCopied(true);
      showToast("Link disalin");
      window.setTimeout(() => setShareCopied(false), 2000);
    } catch {
      window.prompt("Salin link ini:", shareStatus.webViewLink);
    }
  }

  // ── Move ────────────────────────────────────────────────────────────────

  function openMove(ids?: string[]) {
    if (!isOwner) return;
    setMoveTargets(ids ?? [...selected]);
    setMoveFolderId(null);
    setMoveCrumbs([]);
    setMoveOpen(true);
  }

  useEffect(() => {
    if (!moveOpen || !spaceId) return;
    let alive = true;
    api
      .listFiles(spaceId, moveFolderId)
      .then((next) => {
        if (alive) {
          setMoveFolders(next.folders.filter((f) => !moveTargets.includes(f.id)));
          setMoveCrumbs(next.breadcrumb);
        }
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : "Gagal memuat folder tujuan.");
      });
    return () => {
      alive = false;
    };
  }, [moveOpen, moveFolderId, spaceId, moveTargets]);

  async function confirmMove() {
    if (!spaceId || moveBusy) return;
    setMoveBusy(true);
    try {
      await api.move({ spaceId, fileIds: moveTargets, parentId: moveFolderId });
      setMoveOpen(false);
      setSelected(new Set());
      showToast("Berhasil dipindahkan");
      void refresh(folderId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal memindahkan item.");
    } finally {
      setMoveBusy(false);
    }
  }

  // ── Keyboard shortcuts ──────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      const isModal = Boolean(
        shareItem || renaming || moveOpen || propsItem || showNewFolder || unlockModal || securityModal
      );
      if (isInput || isModal) {
        if (e.key === "Escape" && isModal && !unlockModal?.blockingPage) {
          e.preventDefault();
          setShareItem(null);
          setRenaming(null);
          setMoveOpen(false);
          setPropsItem(null);
          setShowNewFolder(false);
          setUnlockModal(null);
          setSecurityModal(null);
        }
        return;
      }
      if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setSelected(new Set(ordered.map((i) => i.id)));
      } else if (e.key === "Escape") {
        e.preventDefault();
        setSelected(new Set());
      } else if ((e.key === "Delete" || e.key === "Backspace") && isOwner) {
        if (selected.size > 0) {
          e.preventDefault();
          requestDeleteSelected();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ordered, selected, shareItem, renaming, moveOpen, propsItem, showNewFolder, unlockModal, securityModal, isOwner]);

  if (!spaceId) return null;

  const selectedCount = selected.size;
  const searchQuery = query.trim();

  const sortLabels: Record<SortKey, string> = {
    name: "Nama",
    modified: "Terakhir diubah",
    size: "Ukuran file",
    type: "Tipe file",
  };

  // Context Menu items (adapts cleanly for Visitor vs Owner!)
  const ctxIsFolder = ctxMenu?.item.mimeType === "application/vnd.google-apps.folder";
  const ctxLockedForVisitor = Boolean(ctxIsFolder && ctxMenu?.item.isLocked && !ctxMenu?.item.isUnlocked && !isOwner);

  const ctxMenuItems = ctxMenu
    ? [
        {
          label: ctxLockedForVisitor ? "Buka dengan Password" : "Buka",
          icon: ctxLockedForVisitor ? <KeyRound className="h-4 w-4" /> : <Eye className="h-4 w-4" />,
          onClick: () => openItem(ctxMenu.item),
        },
        ...(isOwner && ctxIsFolder
          ? [
              {
                label: ctxMenu.item.isLocked ? "Atur / Lepas Password Folder" : "Pasang Password Folder",
                icon: <Lock className="h-4 w-4" />,
                onClick: () =>
                  setSecurityModal({
                    subfolder: {
                      id: ctxMenu.item.id,
                      name: ctxMenu.item.name,
                      visibility: ctxMenu.item.visibility ?? "public",
                      isLocked: Boolean(ctxMenu.item.isLocked),
                    },
                  }),
              },
            ]
          : []),
        ...(isOwner
          ? [
              {
                label: "Ubah Nama",
                icon: <Pencil className="h-4 w-4" />,
                onClick: () => {
                  setRenaming(ctxMenu.item);
                  setRenameValue(ctxMenu.item.name);
                },
              },
              {
                label: "Bagikan Link Drive",
                icon: <LinkIcon className="h-4 w-4" />,
                onClick: () => void openShare(ctxMenu.item),
              },
              {
                label: "Pindahkan",
                icon: <MoveRight className="h-4 w-4" />,
                onClick: () => openMove([ctxMenu.item.id]),
              },
            ]
          : []),
        ...(!ctxLockedForVisitor
          ? [
              {
                label: "Download",
                icon: <Download className="h-4 w-4" />,
                onClick: () => void handleDownloadItems([ctxMenu.item]),
              },
            ]
          : []),
        {
          label: "Properti",
          icon: <Info className="h-4 w-4" />,
          onClick: () => setPropsItem(ctxMenu.item),
        },
        {
          label: "Salin Lokasi",
          icon: <Clipboard className="h-4 w-4" />,
          onClick: () => {
            const parts = [data?.space.name ?? "", ...(data?.breadcrumb.map((c) => c.name) ?? []), ctxMenu.item.name].filter(Boolean);
            const pathStr = parts.join("/");
            navigator.clipboard.writeText(pathStr).then(
              () => showToast("Lokasi disalin"),
              () => showToast(pathStr, { type: "info" })
            );
          },
        },
        ...(isOwner &&
        ctxMenu.item.mimeType.startsWith("image/") &&
        ctxMenu.item.thumbnailLink &&
        folderId
          ? [
              {
                label: "Jadikan Sampul Folder",
                icon: <ImagePlus className="h-4 w-4" />,
                onClick: () => {
                  setFolderCover(folderId, ctxMenu.item.id, ctxMenu.item.thumbnailLink!);
                  showToast("Sampul folder diperbarui");
                },
              },
            ]
          : []),
        ...(isOwner
          ? [
              {
                label: "Pindahkan ke Sampah",
                icon: <Trash2 className="h-4 w-4" />,
                onClick: () => requestDeleteOne(ctxMenu.item),
                danger: true,
              },
            ]
          : []),
      ]
    : [];

  return (
    <main
      className="min-h-screen bg-slate-50"
      onDragOver={(e) => {
        if (!isOwner) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* Upload drop overlay */}
      {dragOver && isOwner && (
        <div className="fixed inset-0 z-50 bg-brand-500/10 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="rounded-2xl bg-white p-8 shadow-2xl flex flex-col items-center gap-3 animate-pop-in">
            <CloudUpload className="h-10 w-10 text-brand-500" />
            <p className="text-lg font-semibold text-slate-900">Lepaskan file untuk upload</p>
            <p className="text-sm text-slate-400">File akan diupload ke folder ini</p>
          </div>
        </div>
      )}

      {/* Top Navigation */}
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3">
          {/* Breadcrumb */}
          <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-x-auto">
            <Link
              href="/"
              className="flex items-center gap-1.5 text-slate-500 hover:text-brand-600 text-sm font-medium shrink-0 transition-colors"
              title="Semua Folder Orang"
            >
              <House className="h-4 w-4" />
              <span className="hidden md:inline">Semua Ruang</span>
            </Link>

            {data?.space && (
              <>
                <ChevronRight className="h-3.5 w-3.5 text-slate-300 shrink-0" />
                <button
                  type="button"
                  onClick={() => {
                    navigateToFolder(null);
                    setQuery("");
                  }}
                  className={`inline-flex items-center gap-1.5 text-sm truncate max-w-[10rem] shrink-0 transition-colors ${
                    folderId === null && !searchQuery
                      ? "font-semibold text-brand-600"
                      : "text-slate-700 hover:text-brand-600 font-medium"
                  }`}
                >
                  {data.space.isLocked ? (
                    <Lock className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                  ) : (
                    <Globe className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  )}
                  <span className="truncate">{data.space.name}</span>
                </button>
              </>
            )}

            {!searchQuery &&
              data?.breadcrumb.map((c) => (
                <span key={c.id} className="flex items-center gap-1 min-w-0 shrink-0">
                  <ChevronRight className="h-3.5 w-3.5 text-slate-300 shrink-0" />
                  <button
                    type="button"
                    onClick={() => navigateToFolder(c.id)}
                    className={`inline-flex items-center gap-1 text-sm truncate max-w-[9rem] ${
                      folderId === c.id ? "font-semibold text-slate-900" : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    {c.isLocked && <Lock className="h-3 w-3 text-amber-500 shrink-0" />}
                    <span className="truncate">{c.name}</span>
                  </button>
                </span>
              ))}

            {searchQuery && (
              <span className="flex items-center gap-1 shrink-0">
                <ChevronRight className="h-3.5 w-3.5 text-slate-300" />
                <span className="text-sm text-slate-600 truncate max-w-[10rem]">&quot;{searchQuery}&quot;</span>
              </span>
            )}
          </div>

          {data && !searchQuery && (
            <FolderStatsDisplay files={data.files} folders={data.folders} className="hidden xl:inline" />
          )}

          {/* Role & Actions */}
          <div className="flex items-center gap-1.5 shrink-0">
            {isOwner ? (
              <>
                <span className="hidden lg:inline-flex items-center gap-1 rounded-full bg-brand-50 text-brand-700 px-2.5 py-1 text-xs font-medium border border-brand-200">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Pemilik
                </span>

                <button
                  type="button"
                  onClick={() => setSecurityModal({ subfolder: null })}
                  className="inline-flex items-center gap-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all"
                  title="Atur Publik / Password Ruang"
                >
                  <Settings className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Kunci Ruang</span>
                </button>

                <Link
                  href={`/trash?spaceId=${encodeURIComponent(spaceId)}`}
                  className="inline-flex items-center gap-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Sampah</span>
                </Link>

                <Link
                  href={
                    folderId
                      ? `/upload?spaceId=${encodeURIComponent(spaceId)}&folderId=${encodeURIComponent(folderId)}`
                      : `/upload?spaceId=${encodeURIComponent(spaceId)}`
                  }
                  className="inline-flex items-center gap-1.5 bg-brand-500 text-white hover:bg-brand-600 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all shadow-sm"
                >
                  <Upload className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Upload</span>
                </Link>

                <StorageIndicator />

                <button
                  type="button"
                  onClick={async () => {
                    const wasLocked = data?.space.isLocked;
                    await logoutSpace(spaceId);
                    showToast("Keluar dari sesi Pemilik");
                    if (wasLocked) {
                      router.replace("/");
                    } else {
                      void refresh(folderId);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all"
                  title="Keluar dari mode Pemilik"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span className="hidden md:inline">Keluar</span>
                </button>
              </>
            ) : (
              <>
                <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-600 px-2.5 py-1 text-xs font-medium">
                  <Eye className="h-3.5 w-3.5" />
                  Read-Only
                </span>

                <button
                  type="button"
                  onClick={promptOwnerLogin}
                  className="inline-flex items-center gap-1.5 bg-brand-500 text-white hover:bg-brand-600 rounded-lg px-3 py-1.5 text-xs font-medium transition-all shadow-sm"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  <span>Masuk Pemilik</span>
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 space-y-4">
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

        {/* Subfolder lock status banner for Owner when viewing a locked subfolder */}
        {isOwner && data?.folder && (
          <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs">
            <div className="flex items-center gap-2 text-slate-600 min-w-0">
              {data.folder.isLocked ? (
                <>
                  <Lock className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                  <span className="truncate">
                    Subfolder <strong>{data.folder.name}</strong> dilindungi password untuk pengunjung.
                  </span>
                </>
              ) : (
                <>
                  <Globe className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  <span className="truncate">
                    Subfolder <strong>{data.folder.name}</strong> bersifat publik (mengikuti akses ruang).
                  </span>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() =>
                data.folder &&
                setSecurityModal({
                  subfolder: {
                    id: data.folder.id,
                    name: data.folder.name,
                    visibility: data.folder.visibility ?? "public",
                    isLocked: Boolean(data.folder.isLocked),
                  },
                })
              }
              className="text-brand-600 hover:text-brand-700 font-medium whitespace-nowrap shrink-0"
            >
              Atur Password
            </button>
          </div>
        )}

        {/* Toolbar */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => {
                setTimeout(() => setSearchFocused(false), 200);
              }}
              placeholder={`Cari file atau folder di ${data?.space.name ?? "ruang ini"}…`}
              className="w-full pl-9 pr-10 py-2 text-sm rounded-xl border border-slate-200 bg-white shadow-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 transition-all placeholder:text-slate-400"
              aria-label="Cari"
            />
            {searchFocused && !searchQuery && recentSearches.length > 0 && (
              <div className="absolute left-0 right-0 top-full mt-1 z-30 rounded-xl bg-white shadow-xl ring-1 ring-slate-200 overflow-hidden animate-pop-in">
                <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100">
                  <span className="text-xs font-medium text-slate-500">Pencarian terakhir</span>
                  <button
                    onClick={clearRecentSearches}
                    className="text-xs text-slate-400 hover:text-red-500 transition-colors"
                  >
                    Hapus
                  </button>
                </div>
                {recentSearches.map((s) => (
                  <button
                    key={s}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setQuery(s);
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 transition-colors flex items-center gap-2"
                  >
                    <Search className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                    {s}
                  </button>
                ))}
              </div>
            )}
            {searching && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-brand-400 animate-spin" />
            )}
            {searchQuery && !searching && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                title="Bersihkan pencarian"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="flex gap-2 items-center">
            <div className="relative">
              <button
                onClick={() => setShowSortMenu((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm hover:bg-slate-50 transition-all"
              >
                <SlidersHorizontal className="h-4 w-4 text-slate-400" />
                <span className="hidden sm:inline">{sortLabels[sortKey]}</span>
                {sortDir === "asc" ? (
                  <ArrowUp className="h-3.5 w-3.5 text-slate-400" />
                ) : (
                  <ArrowDown className="h-3.5 w-3.5 text-slate-400" />
                )}
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
                    {sortDir === "asc" ? "A → Z / Lama" : "Z → A / Baru"}
                  </button>
                </div>
              )}
            </div>

            <div className="flex rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
              <button
                onClick={() => setView("list")}
                className={`px-3 py-2 transition-all ${
                  view === "list" ? "bg-brand-500 text-white" : "text-slate-500 hover:bg-slate-50"
                }`}
                title="Tampilan daftar"
              >
                <List className="h-4 w-4" />
              </button>
              <button
                onClick={() => setView("grid")}
                className={`px-3 py-2 border-l border-slate-200 transition-all ${
                  view === "grid" ? "bg-brand-500 text-white" : "text-slate-500 hover:bg-slate-50"
                }`}
                title="Tampilan grid"
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
            </div>

            {isOwner && (
              <button
                onClick={() => {
                  setNewFolderName("");
                  setNewFolderPassword("");
                  setShowNewFolderPw(false);
                  setShowNewFolder(true);
                }}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm hover:bg-slate-50 transition-all"
                title="Buat subfolder baru"
              >
                <FolderPlus className="h-4 w-4 text-slate-400" />
                <span className="hidden sm:inline">Folder Baru</span>
              </button>
            )}
          </div>
        </div>

        {/* Selection bar */}
        {selectedCount > 0 && (
          <Card className="px-4 py-2.5 flex flex-wrap items-center gap-2 animate-pop-in border-brand-100 bg-brand-50/50">
            <span className="text-sm font-medium text-brand-700 mr-1">{selectedCount} dipilih</span>
            <div className="h-4 w-px bg-brand-200" />
            {isOwner && (
              <Button variant="danger" size="sm" onClick={() => requestDeleteSelected()}>
                <Trash2 className="h-3.5 w-3.5" />
                Hapus
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleDownloadItems(ordered.filter((i) => selected.has(i.id)))}
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </Button>
            {isOwner && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const only = ordered.find((i) => selected.has(i.id));
                    if (only) void openShare(only);
                  }}
                  disabled={selectedCount !== 1}
                >
                  <LinkIcon className="h-3.5 w-3.5" />
                  Bagikan
                </Button>
                <Button variant="ghost" size="sm" onClick={() => openMove()}>
                  <MoveRight className="h-3.5 w-3.5" />
                  Pindahkan
                </Button>
              </>
            )}
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              <X className="h-3.5 w-3.5" />
              Batal
            </Button>
          </Card>
        )}

        {/* File & Folder Listing */}
        <Card className="overflow-hidden">
          {loadingFiles && !data && <SkeletonList view={view} />}

          {!loadingFiles && data && ordered.length === 0 && (
            <EmptyState
              searching={Boolean(searchQuery)}
              query={searchQuery}
              atRoot={folderId === null}
              isOwner={isOwner}
              onClear={() => setQuery("")}
              onUpload={() => document.getElementById("drive-upload-input")?.click()}
              onOwnerLogin={promptOwnerLogin}
            />
          )}

          {/* List View */}
          {ordered.length > 0 && view === "list" && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/80">
                    <th className="w-10 px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label="Pilih semua"
                        className="accent-brand-500 rounded"
                        checked={selectedCount === ordered.length && ordered.length > 0}
                        onChange={(e) => {
                          setSelected(e.target.checked ? new Set(ordered.map((i) => i.id)) : new Set());
                          lastClicked.current = null;
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </th>
                    <th className="px-3 py-3 text-left font-medium text-slate-500 text-xs uppercase tracking-wide">
                      Nama
                    </th>
                    <th className="px-3 py-3 hidden sm:table-cell text-left font-medium text-slate-500 text-xs uppercase tracking-wide">
                      Tipe
                    </th>
                    <th className="px-3 py-3 hidden md:table-cell text-left font-medium text-slate-500 text-xs uppercase tracking-wide">
                      Ukuran
                    </th>
                    <th className="px-3 py-3 hidden md:table-cell text-left font-medium text-slate-500 text-xs uppercase tracking-wide">
                      Diubah
                    </th>
                    <th className="w-1 px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {ordered.map((item) => {
                    const isFolder = item.mimeType === "application/vnd.google-apps.folder";
                    const isSel = selected.has(item.id);
                    const lockedForVisitor = Boolean(isFolder && item.isLocked && !item.isUnlocked && !isOwner);
                    return (
                      <tr
                        key={item.id}
                        onClick={(e) => handleRowClick(e, item)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setCtxMenu({ x: e.clientX, y: e.clientY, item });
                        }}
                        className={`group border-b border-slate-50 last:border-0 cursor-pointer select-none transition-colors duration-100 ${
                          isSel ? "bg-brand-50 hover:bg-brand-100/70" : "hover:bg-slate-50"
                        }`}
                      >
                        <td className="w-10 px-4 py-2.5">
                          <input
                            type="checkbox"
                            aria-label={`Pilih ${item.name}`}
                            className="accent-brand-500 opacity-0 group-hover:opacity-100 transition-opacity"
                            style={isSel ? { opacity: 1 } : {}}
                            checked={isSel}
                            onChange={() => toggleSelect(item.id)}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <FileIcon
                              mime={item.mimeType}
                              isFolder={isFolder}
                              isLocked={Boolean(item.isLocked)}
                              lockedForVisitor={lockedForVisitor}
                            />
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openItem(item);
                              }}
                              className="truncate font-medium text-slate-800 hover:text-brand-600 hover:underline text-left"
                              title={item.name}
                            >
                              <HighlightText text={item.name} query={searchQuery} />
                            </button>
                            {isFolder && item.isLocked && (
                              <span
                                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium shrink-0 ${
                                  lockedForVisitor
                                    ? "bg-amber-50 text-amber-700 border border-amber-200"
                                    : "bg-slate-100 text-slate-600"
                                }`}
                              >
                                {lockedForVisitor ? (
                                  <>
                                    <Lock className="h-2.5 w-2.5" /> Terkunci
                                  </>
                                ) : (
                                  <>
                                    <LockOpen className="h-2.5 w-2.5" /> Berpassword
                                  </>
                                )}
                              </span>
                            )}
                            {isSearching && (item as DriveFile & { path?: string | null }).path && (
                              <span className="text-xs text-slate-400 truncate shrink-0">
                                · {(item as DriveFile & { path?: string | null }).path}
                              </span>
                            )}
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
                            {!lockedForVisitor && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleDownloadItems([item]);
                                }}
                                className="rounded-lg p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-all"
                                title="Download"
                              >
                                <Download className="h-3.5 w-3.5" />
                              </button>
                            )}
                            {isOwner && isFolder && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSecurityModal({
                                    subfolder: {
                                      id: item.id,
                                      name: item.name,
                                      visibility: item.visibility ?? "public",
                                      isLocked: Boolean(item.isLocked),
                                    },
                                  });
                                }}
                                className="rounded-lg p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 transition-all"
                                title="Atur Password Subfolder"
                              >
                                <Lock className="h-3.5 w-3.5" />
                              </button>
                            )}
                            {isOwner && (
                              <>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setRenaming(item);
                                    setRenameValue(item.name);
                                  }}
                                  className="rounded-lg p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-all"
                                  title="Ubah Nama"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    requestDeleteOne(item);
                                  }}
                                  className="rounded-lg p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 transition-all"
                                  title="Pindahkan ke Sampah"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Grid View */}
          {ordered.length > 0 && view === "grid" && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 p-4">
              {ordered.map((item) => {
                const isFolder = item.mimeType === "application/vnd.google-apps.folder";
                const isSel = selected.has(item.id);
                const lockedForVisitor = Boolean(isFolder && item.isLocked && !item.isUnlocked && !isOwner);
                const coverUrl = isFolder && !lockedForVisitor ? getFolderCoverUrl(item.id) : null;
                return (
                  <div
                    key={item.id}
                    onClick={(e) => handleRowClick(e, item)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCtxMenu({ x: e.clientX, y: e.clientY, item });
                    }}
                    className={`group relative flex flex-col items-center rounded-2xl border p-3 cursor-pointer select-none transition-all duration-150 ${
                      isSel
                        ? "border-brand-300 ring-2 ring-brand-200 bg-brand-50 shadow-sm"
                        : "border-slate-200 hover:border-slate-300 hover:bg-slate-50 hover:shadow-sm"
                    }`}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Pilih ${item.name}`}
                      className="accent-brand-500 absolute top-2.5 left-2.5 z-10 opacity-0 group-hover:opacity-100 transition-opacity"
                      style={isSel ? { opacity: 1 } : {}}
                      checked={isSel}
                      onChange={() => toggleSelect(item.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    {isFolder && item.isLocked && (
                      <span
                        className={`absolute top-2.5 right-2.5 rounded-full p-1 ${
                          lockedForVisitor ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"
                        }`}
                        title={lockedForVisitor ? "Terkunci Password" : "Dilindungi Password"}
                      >
                        {lockedForVisitor ? <Lock className="h-3 w-3" /> : <LockOpen className="h-3 w-3" />}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openItem(item);
                      }}
                      className="h-16 w-16 flex items-center justify-center mb-2 focus:outline-none overflow-hidden"
                      title={item.name}
                    >
                      {!isFolder && item.thumbnailLink && item.mimeType.startsWith("image/") ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.thumbnailLink}
                          alt=""
                          className="h-full w-full object-cover rounded-xl shadow-sm"
                          loading="lazy"
                        />
                      ) : isFolder && coverUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={coverUrl}
                          alt=""
                          className="h-full w-full object-cover rounded-xl shadow-sm"
                          loading="lazy"
                        />
                      ) : (
                        <FileIconLarge
                          mime={item.mimeType}
                          isFolder={isFolder}
                          lockedForVisitor={lockedForVisitor}
                        />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openItem(item);
                      }}
                      className="text-xs font-medium truncate w-full text-center text-slate-800 hover:text-brand-600 hover:underline leading-tight"
                      title={item.name}
                    >
                      <HighlightText text={item.name} query={searchQuery} />
                    </button>
                    <div className="text-xs text-slate-400 mt-0.5">
                      {isFolder ? (lockedForVisitor ? "Terkunci" : "Folder") : formatSize(item.size)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Hidden upload input */}
      <input id="drive-upload-input" type="file" multiple className="hidden" onChange={onFileInput} />

      {/* Create Subfolder Modal (with optional password!) */}
      <Modal open={showNewFolder} onClose={() => setShowNewFolder(false)} className="max-w-sm">
        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-slate-900">Buat Subfolder Baru</h2>
            <button
              type="button"
              onClick={() => setShowNewFolder(false)}
              className="rounded-lg p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <form onSubmit={(e) => void createFolder(e)} className="space-y-4">
            <div>
              <label className="label" htmlFor="new-subfolder-name">
                Nama Subfolder
              </label>
              <input
                id="new-subfolder-name"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="Contoh: Foto Kegiatan"
                className="input"
                maxLength={80}
                autoFocus
                required
              />
            </div>

            <div>
              <label className="label" htmlFor="new-subfolder-pw">
                Password Penguncian Subfolder <span className="text-slate-400 font-normal">(opsional, minimal 8 karakter)</span>
              </label>
              <div className="relative">
                <input
                  id="new-subfolder-pw"
                  type={showNewFolderPw ? "text" : "password"}
                  value={newFolderPassword}
                  onChange={(e) => setNewFolderPassword(e.target.value)}
                  placeholder="Kosongkan jika publik…"
                  className="input pr-10"
                  minLength={8}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowNewFolderPw((v) => !v)}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600"
                  tabIndex={-1}
                >
                  {showNewFolderPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="mt-1 text-[11px] text-slate-400">
                {newFolderPassword
                  ? "🔒 Subfolder ini akan dikunci password untuk pengunjung."
                  : "🌐 Kosong = publik (pengunjung bisa lihat & download)."}
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setShowNewFolder(false)}>
                Batal
              </Button>
              <Button type="submit" variant="primary" loading={newFolderBusy} disabled={!newFolderName.trim() || (newFolderPassword.length > 0 && newFolderPassword.length < 8)}>
                Buat
              </Button>
            </div>
          </form>
        </Card>
      </Modal>

      {/* Rename Modal */}
      <Modal open={Boolean(renaming)} onClose={() => setRenaming(null)} className="max-w-sm">
        <Card className="p-5">
          <h2 className="font-semibold text-slate-900 mb-4">Ubah Nama</h2>
          <input
            className="input mb-4"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitRename();
            }}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Batal
            </Button>
            <Button variant="primary" onClick={() => void submitRename()}>
              Simpan
            </Button>
          </div>
        </Card>
      </Modal>

      {/* Share Dialog */}
      <Modal open={Boolean(shareItem)} onClose={() => setShareItem(null)} className="max-w-md">
        <Card className="p-5">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="font-semibold text-slate-900">Bagikan Link Google Drive</h2>
              <p className="text-sm text-slate-500 truncate max-w-[18rem] mt-0.5">{shareItem?.name}</p>
            </div>
            <button
              onClick={() => setShareItem(null)}
              className="rounded-lg p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {!shareStatus ? (
            <div className="flex items-center gap-2 text-sm text-slate-400 py-8 justify-center">
              <Spinner className="h-4 w-4" />
              Memeriksa status link…
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-slate-200 p-4 mb-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-sm font-medium text-slate-800">Siapa saja yang memiliki link</div>
                  <Badge color={shareStatus.public ? "green" : "slate"} dot>
                    {shareStatus.public ? "Publik" : "Terbatas"}
                  </Badge>
                </div>
                {!shareStatus.public ? (
                  <Button variant="primary" size="sm" onClick={() => void makePublicLink()} loading={shareBusy}>
                    <LinkIcon className="h-3.5 w-3.5" />
                    Aktifkan link publik
                  </Button>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs text-slate-500">Akses: Pelihat</div>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void copyShareLink()}
                      disabled={!shareStatus.webViewLink}
                    >
                      {shareCopied ? (
                        <>
                          <Check className="h-3.5 w-3.5" /> Disalin
                        </>
                      ) : (
                        <>
                          <LinkIcon className="h-3.5 w-3.5" /> Salin Link
                        </>
                      )}
                    </Button>
                  </div>
                )}
              </div>
              {shareStatus.public && shareStatus.webViewLink && (
                <p className="text-xs text-slate-400 break-all mb-4 font-mono bg-slate-50 rounded-lg p-2">
                  {shareStatus.webViewLink}
                </p>
              )}
              <div className="flex justify-end">
                <Button variant="ghost" onClick={() => setShareItem(null)}>
                  Tutup
                </Button>
              </div>
            </>
          )}
        </Card>
      </Modal>

      {/* Move Dialog */}
      <Modal open={moveOpen} onClose={() => setMoveOpen(false)} className="max-w-md">
        <Card className="p-5">
          <h2 className="font-semibold text-slate-900 mb-1">Pindahkan ke Folder</h2>
          <p className="text-sm text-slate-500 mb-4">
            Memindahkan {moveTargets.length} item — pilih folder tujuan
          </p>
          <nav className="flex items-center gap-1 text-sm mb-3 flex-wrap">
            <button
              onClick={() => {
                setMoveFolderId(null);
                setMoveCrumbs([]);
              }}
              className={`flex items-center gap-1 hover:text-brand-600 ${
                moveFolderId === null ? "font-semibold text-slate-900" : "text-slate-500"
              }`}
            >
              <House className="h-3.5 w-3.5" />
              {data?.space.name ?? "Root"}
            </button>
            {moveCrumbs.map((c) => (
              <span key={c.id} className="flex items-center gap-1">
                <ChevronRight className="h-3.5 w-3.5 text-slate-300" />
                <button
                  onClick={() => setMoveFolderId(c.id)}
                  className={`hover:text-brand-600 ${
                    moveFolderId === c.id ? "font-semibold text-slate-900" : "text-slate-500"
                  }`}
                >
                  {c.name}
                </button>
              </span>
            ))}
          </nav>
          <div className="max-h-56 overflow-y-auto rounded-xl border border-slate-200">
            {moveFolders.length === 0 && (
              <div className="flex flex-col items-center justify-center py-8 gap-2 text-slate-400">
                <FolderOpen className="h-8 w-8" />
                <span className="text-sm">Tidak ada subfolder di sini</span>
              </div>
            )}
            {moveFolders.map((f) => (
              <button
                key={f.id}
                onClick={() => setMoveFolderId(f.id)}
                className={`w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-3 text-sm border-b border-slate-50 last:border-0 transition-colors ${
                  moveFolderId === f.id ? "bg-brand-50 text-brand-700" : "text-slate-700"
                }`}
              >
                <Folder className="h-4 w-4 text-slate-400 shrink-0" />
                <span className="truncate">{f.name}</span>
              </button>
            ))}
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setMoveOpen(false)}>
              Batal
            </Button>
            <Button variant="primary" onClick={() => void confirmMove()} loading={moveBusy}>
              Pindahkan ke Sini
            </Button>
          </div>
        </Card>
      </Modal>

      {/* Properties Panel */}
      {propsItem && data && (
        <PropertiesPanel
          item={propsItem}
          breadcrumb={data.breadcrumb}
          spaceName={data.space.name}
          isOwner={isOwner}
          onClose={() => setPropsItem(null)}
        />
      )}

      {/* Unlock / Owner Login Modal */}
      {unlockModal && (
        <UnlockPasswordModal
          open={Boolean(unlockModal)}
          spaceId={spaceId}
          folderId={unlockModal.folderId}
          folderName={unlockModal.folderName}
          asOwner={unlockModal.asOwner}
          onSuccess={(res) => {
            const nextFolder = unlockModal.navigateFolderAfter;
            const wasOwnerPrompt = unlockModal.asOwner;
            setUnlockModal(null);
            if (wasOwnerPrompt || res.role === "owner") {
              showToast(`Masuk sebagai Pemilik "${res.space.name}"`);
            } else {
              showToast("Folder berhasil dibuka");
            }
            if (nextFolder) {
              navigateToFolder(nextFolder);
            } else {
              void refresh(folderId);
            }
          }}
          onClose={() => {
            const wasBlocking = unlockModal.blockingPage;
            setUnlockModal(null);
            if (wasBlocking) {
              if (folderId) {
                navigateToFolder(null);
              } else {
                router.replace("/");
              }
            }
          }}
        />
      )}

      {/* Folder / Space Security Modal */}
      {securityModal && data && (
        <FolderSecurityModal
          open={Boolean(securityModal)}
          space={data.space}
          subfolder={securityModal.subfolder}
          onUpdated={() => void refresh(folderId)}
          onSpaceDeleted={() => router.replace("/")}
          onClose={() => setSecurityModal(null)}
        />
      )}

      {/* Context Menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenuItems}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {showSortMenu && <div className="fixed inset-0 z-20" onClick={() => setShowSortMenu(false)} />}

      <Toast
        visible={toast.visible}
        message={toast.restoring ? "Memulihkan…" : toast.message}
        action={toast.restoring ? undefined : { label: "URUNGKAN", onClick: undoTrash }}
        onDismiss={() => {
          if (!toast.restoring) setToast((t) => ({ ...t, visible: false }));
        }}
      />

      <ConfirmDialog
        open={deleteConfirm.open}
        title={deleteConfirm.title}
        message={deleteConfirm.message}
        confirmLabel="Pindahkan ke Sampah"
        loading={deleteBusy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteConfirm((d) => ({ ...d, open: false }))}
      />
    </main>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let idx = lower.indexOf(q, lastIdx);
  while (idx !== -1) {
    if (idx > lastIdx) parts.push(text.substring(lastIdx, idx));
    parts.push(
      <mark key={idx} className="bg-brand-200/70 text-brand-900 rounded-sm px-0.5">
        {text.substring(idx, idx + q.length)}
      </mark>
    );
    lastIdx = idx + q.length;
    idx = lower.indexOf(q, lastIdx);
  }
  if (lastIdx < text.length) parts.push(text.substring(lastIdx));
  return <>{parts}</>;
}

function FileIcon({
  mime,
  isFolder,
  isLocked,
  lockedForVisitor,
}: {
  mime: string;
  isFolder: boolean;
  isLocked?: boolean;
  lockedForVisitor?: boolean;
}) {
  if (isFolder) {
    if (lockedForVisitor) return <FolderLock className="h-4 w-4 shrink-0 text-amber-500" />;
    if (isLocked) return <FolderLock className="h-4 w-4 shrink-0 text-brand-500" />;
    return <Folder className="h-4 w-4 shrink-0 text-brand-400" />;
  }
  const cls = "h-4 w-4 shrink-0 text-slate-400";
  if (mime.startsWith("image/")) return <ImageIcon className={cls} />;
  if (mime.startsWith("video/")) return <Video className={cls} />;
  if (mime.startsWith("audio/")) return <Music className={cls} />;
  if (mime === "application/pdf") return <FileText className={cls} />;
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/javascript") {
    return <FileText className={cls} />;
  }
  if (mime.includes("zip") || mime.includes("compressed") || mime.includes("tar")) {
    return <FileArchive className={cls} />;
  }
  if (mime.includes("spreadsheet") || mime === "text/csv") return <FileSpreadsheet className={cls} />;
  if (mime.includes("presentation")) return <Presentation className={cls} />;
  return <File className={cls} />;
}

function FileIconLarge({
  mime,
  isFolder,
  lockedForVisitor,
}: {
  mime: string;
  isFolder: boolean;
  lockedForVisitor?: boolean;
}) {
  const cls = "h-10 w-10";
  if (isFolder) {
    return lockedForVisitor ? (
      <FolderLock className={`${cls} text-amber-400`} />
    ) : (
      <Folder className={`${cls} text-brand-400`} />
    );
  }
  if (mime.startsWith("image/")) return <ImageIcon className={`${cls} text-violet-400`} />;
  if (mime.startsWith("video/")) return <Video className={`${cls} text-red-400`} />;
  if (mime.startsWith("audio/")) return <Music className={`${cls} text-emerald-400`} />;
  if (mime === "application/pdf") return <FileText className={`${cls} text-red-400`} />;
  if (mime.includes("spreadsheet") || mime === "text/csv") return <FileSpreadsheet className={`${cls} text-emerald-400`} />;
  if (mime.includes("presentation")) return <Presentation className={`${cls} text-amber-400`} />;
  if (mime.includes("zip") || mime.includes("compressed")) return <FileArchive className={`${cls} text-slate-400`} />;
  return <File className={`${cls} text-slate-400`} />;
}

function compareItems(a: DriveFile, b: DriveFile, key: SortKey, dir: SortDir): number {
  let r = 0;
  switch (key) {
    case "name":
      r = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
      break;
    case "modified": {
      const ta = Date.parse(a.modifiedTime ?? "") || 0;
      const tb = Date.parse(b.modifiedTime ?? "") || 0;
      r = ta - tb;
      break;
    }
    case "size": {
      const na = typeof a.size === "string" ? Number(a.size) : a.size ?? 0;
      const nb = typeof b.size === "string" ? Number(b.size) : b.size ?? 0;
      r = (na || 0) - (nb || 0);
      break;
    }
    case "type":
      r = typeLabel(a.mimeType).localeCompare(typeLabel(b.mimeType));
      break;
  }
  return dir === "asc" ? r : -r;
}

function SkeletonList({ view }: { view: ViewMode }) {
  if (view === "grid") {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 p-4">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="flex flex-col items-center p-3 rounded-2xl border border-slate-100 gap-2">
            <Skeleton className="h-16 w-16 rounded-xl" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-2 w-1/2" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="p-4 space-y-1">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-2">
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-4 w-4 rounded" />
          <div className="h-4 flex-1 rounded animate-pulse bg-slate-100" />
          <Skeleton className="h-3 w-16 rounded hidden sm:block" />
          <Skeleton className="h-3 w-12 rounded hidden md:block" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  searching,
  query,
  atRoot,
  isOwner,
  onClear,
  onUpload,
  onOwnerLogin,
}: {
  searching: boolean;
  query: string;
  atRoot: boolean;
  isOwner: boolean;
  onClear: () => void;
  onUpload: () => void;
  onOwnerLogin: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
      {searching ? (
        <>
          <div className="rounded-2xl bg-slate-100 p-5 mb-4">
            <Search className="h-8 w-8 text-slate-400" />
          </div>
          <p className="font-semibold text-slate-700">Tidak ada hasil untuk &quot;{query}&quot;</p>
          <p className="text-sm text-slate-400 mt-1 mb-4">Coba kata kunci lain.</p>
          <Button variant="ghost" size="sm" onClick={onClear}>
            <X className="h-4 w-4" /> Bersihkan Pencarian
          </Button>
        </>
      ) : isOwner ? (
        <>
          <div className="rounded-2xl bg-slate-100 p-5 mb-4">
            {atRoot ? <Upload className="h-8 w-8 text-slate-400" /> : <FolderOpen className="h-8 w-8 text-slate-400" />}
          </div>
          <p className="font-semibold text-slate-700">
            {atRoot ? "Folder ini masih kosong" : "Subfolder ini masih kosong"}
          </p>
          <p className="text-sm text-slate-400 mt-1 mb-4">
            Upload file atau buat subfolder (bisa publik atau dipasang password).
          </p>
          <button
            onClick={onUpload}
            className="inline-flex items-center gap-1.5 bg-brand-500 text-white hover:bg-brand-600 rounded-xl px-4 py-2 text-sm font-medium transition-all shadow-sm"
          >
            <Upload className="h-4 w-4" /> Upload File
          </button>
        </>
      ) : (
        <>
          <div className="rounded-2xl bg-slate-100 p-5 mb-4">
            <FolderOpen className="h-8 w-8 text-slate-400" />
          </div>
          <p className="font-semibold text-slate-700">Belum ada file publik di folder ini</p>
          <p className="text-sm text-slate-400 mt-1 mb-4">
            Jika ini adalah folder milikmu, masuk menggunakan Password Pemilik untuk mengupload file.
          </p>
          <button
            onClick={onOwnerLogin}
            className="inline-flex items-center gap-1.5 text-slate-700 hover:bg-slate-100 rounded-xl px-4 py-2 text-sm font-medium transition-all border border-slate-200"
          >
            <KeyRound className="h-4 w-4" /> Masuk Pemilik
          </button>
        </>
      )}
    </div>
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
