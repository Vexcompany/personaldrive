"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Eye,
  EyeOff,
  Folder,
  FolderLock,
  FolderPlus,
  Globe,
  HardDrive,
  KeyRound,
  Loader2,
  Lock,
  LockOpen,
  Search,
  Settings,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { api, ApiError } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Badge, Button, Card, ErrorBanner, Modal, Skeleton } from "@/components/ui";
import { StorageIndicator } from "@/components/StorageIndicator";
import { UnlockPasswordModal } from "@/components/UnlockPasswordModal";
import { FolderSecurityModal } from "@/components/FolderSecurityModal";
import { showToast } from "@/stores/useToastStore";
import type { FolderVisibility, SpaceSummary } from "@personaldrive/shared";

type SpaceFilter = "all" | "public" | "locked" | "owned";

export default function HomePage() {
  const router = useRouter();
  const { token, createSpace } = useAuth();

  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [loadingSpaces, setLoadingSpaces] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<SpaceFilter>("all");

  // Create Space Modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newVisibility, setNewVisibility] = useState<FolderVisibility>("locked");
  const [newPassword, setNewPassword] = useState("");
  const [newLockPassword, setNewLockPassword] = useState("");
  const [showNewPw, setShowNewPw] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Unlock / Owner Login Modal state
  const [unlockTarget, setUnlockTarget] = useState<{
    space: SpaceSummary;
    asOwner: boolean;
    navigateAfter: boolean;
  } | null>(null);

  // Space Settings Modal (for owners right from home page)
  const [settingsSpace, setSettingsSpace] = useState<SpaceSummary | null>(null);

  const loadSpaces = useCallback(async () => {
    setLoadingSpaces(true);
    setError(null);
    try {
      const res = await api.listSpaces();
      setSpaces(res.spaces);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal memuat daftar ruang.");
    } finally {
      setLoadingSpaces(false);
    }
  }, []);

  useEffect(() => {
    void loadSpaces();
  }, [loadSpaces, token]);

  const filteredSpaces = useMemo(() => {
    const q = search.trim().toLowerCase();
    return spaces.filter((s) => {
      if (q && !s.name.toLowerCase().includes(q)) return false;
      if (filter === "public" && s.isLocked) return false;
      if (filter === "locked" && !s.isLocked) return false;
      if (filter === "owned" && !s.isOwner) return false;
      return true;
    });
  }, [spaces, search, filter]);

  function openSpace(space: SpaceSummary) {
    if (space.isUnlocked) {
      router.push(`/drive?spaceId=${encodeURIComponent(space.id)}`);
    } else {
      setUnlockTarget({ space, asOwner: false, navigateAfter: true });
    }
  }

  function resetCreateModal() {
    setNewName("");
    setNewVisibility("locked");
    setNewPassword("");
    setNewLockPassword("");
    setShowNewPw(false);
    setCreateError(null);
    setCreateBusy(false);
  }

  async function handleCreateSpace(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || newPassword.length < 8 || (newVisibility === "locked" && newLockPassword.length < 8) || createBusy) return;
    if (newVisibility === "locked" && newPassword === newLockPassword) {
      setCreateError("Password pemilik dan password penguncian harus berbeda.");
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    try {
      const res = await createSpace({
        name: newName.trim(),
        ownerPassword: newPassword,
        visitorPassword: newVisibility === "locked" ? newLockPassword : undefined,
        visibility: newVisibility,
      });
      setCreateOpen(false);
      resetCreateModal();
      showToast(
        newVisibility === "locked"
          ? `Folder "${res.space.name}" dibuat (Terkunci Password)`
          : `Folder "${res.space.name}" dibuat (Publik)`
      );
      router.push(`/drive?spaceId=${encodeURIComponent(res.space.id)}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "NAME_TAKEN") {
        setCreateError(`Nama folder "${newName.trim()}" sudah dipakai orang lain. Gunakan nama berbeda.`);
      } else {
        setCreateError(err instanceof Error ? err.message : "Gagal membuat folder baru.");
      }
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-slate-200 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="rounded-xl bg-brand-500 p-2 shadow-sm shrink-0">
              <HardDrive className="h-5 w-5 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-bold text-slate-900 tracking-tight truncate">
                Personal Drive
              </h1>
              <p className="text-xs text-slate-400 hidden sm:block truncate">
                Ruang penyimpanan pribadi milik masing-masing orang
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <StorageIndicator />
            <Button
              variant="primary"
              onClick={() => {
                resetCreateModal();
                setCreateOpen(true);
              }}
            >
              <FolderPlus className="h-4 w-4" />
              <span>Buat Folder Baru</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="max-w-6xl w-full mx-auto px-4 sm:px-6 py-6 flex-1 space-y-5">
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

        {/* Search & Filter Toolbar */}
        <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari nama folder orang (mis. Vex)…"
              className="w-full pl-9 pr-9 py-2 text-sm rounded-xl border border-slate-200 bg-white shadow-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 transition-all"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 sm:pb-0">
            {(
              [
                { id: "all", label: `Semua (${spaces.length})` },
                { id: "public", label: "Publik" },
                { id: "locked", label: "Berpassword" },
                { id: "owned", label: "Milik Saya" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setFilter(tab.id)}
                className={`px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all ${
                  filter === tab.id
                    ? "bg-brand-500 text-white shadow-sm"
                    : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Loading state */}
        {loadingSpaces && (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: 6 }).map((_, idx) => (
              <Card key={idx} className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <Skeleton className="h-11 w-11 rounded-xl" />
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </Card>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loadingSpaces && filteredSpaces.length === 0 && (
          <Card className="py-16 px-6 text-center">
            <div className="inline-flex rounded-2xl bg-brand-50 text-brand-500 p-4 mb-4">
              <FolderPlus className="h-8 w-8" />
            </div>
            {spaces.length === 0 ? (
              <>
                <h2 className="text-base font-semibold text-slate-900">
                  Belum ada folder pribadi
                </h2>
                <p className="text-sm text-slate-500 max-w-md mx-auto mt-1 mb-5">
                  Buat folder atas namamu sendiri (misalnya <strong>Vex</strong>). Kamu bebas memasang password agar terkunci rapat atau membuatnya publik agar bisa dilihat semua orang.
                </p>
                <Button
                  variant="primary"
                  onClick={() => {
                    resetCreateModal();
                    setCreateOpen(true);
                  }}
                >
                  <FolderPlus className="h-4 w-4" />
                  Buat Folder Pertama
                </Button>
              </>
            ) : (
              <>
                <h2 className="text-base font-semibold text-slate-900">
                  Tidak ada folder yang cocok
                </h2>
                <p className="text-sm text-slate-500 mt-1 mb-4">
                  Coba kata kunci lain atau ubah filter di atas.
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSearch("");
                    setFilter("all");
                  }}
                >
                  Reset Pencarian
                </Button>
              </>
            )}
          </Card>
        )}

        {/* Spaces Grid */}
        {!loadingSpaces && filteredSpaces.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {filteredSpaces.map((space) => {
              const needsPw = space.isLocked && !space.isUnlocked;
              return (
                <div
                  key={space.id}
                  onClick={() => openSpace(space)}
                  className="group relative rounded-2xl border border-slate-200 bg-white p-5 shadow-sm hover:border-brand-300 hover:shadow-md transition-all cursor-pointer flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-3.5">
                      <div
                        className={`rounded-2xl p-3 transition-colors ${
                          needsPw
                            ? "bg-amber-50 text-amber-600 group-hover:bg-amber-100"
                            : "bg-brand-50 text-brand-600 group-hover:bg-brand-100"
                        }`}
                      >
                        {needsPw ? (
                          <FolderLock className="h-6 w-6" />
                        ) : (
                          <Folder className="h-6 w-6" />
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 flex-wrap justify-end">
                        {space.isOwner && (
                          <Badge color="blue">
                            <span className="inline-flex items-center gap-1">
                              <ShieldCheck className="h-3 w-3" /> Pemilik
                            </span>
                          </Badge>
                        )}
                        {space.isLocked ? (
                          space.isUnlocked && !space.isOwner ? (
                            <Badge color="amber">
                              <span className="inline-flex items-center gap-1">
                                <LockOpen className="h-3 w-3" /> Terbuka
                              </span>
                            </Badge>
                          ) : (
                            <Badge color="amber">
                              <span className="inline-flex items-center gap-1">
                                <Lock className="h-3 w-3" /> Terkunci
                              </span>
                            </Badge>
                          )
                        ) : (
                          <Badge color="green">
                            <span className="inline-flex items-center gap-1">
                              <Globe className="h-3 w-3" /> Publik
                            </span>
                          </Badge>
                        )}
                      </div>
                    </div>

                    <h2 className="font-semibold text-slate-900 text-base truncate group-hover:text-brand-600 transition-colors">
                      {space.name}
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      {needsPw
                        ? "Klik untuk memasukkan password"
                        : space.isOwner
                        ? "Akses penuh (Upload & Edit)"
                        : "Publik · Lihat & Download"}
                    </p>
                  </div>

                  <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-400">
                    <span>Diubah {formatDate(space.modifiedTime)}</span>

                    {space.isOwner ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSettingsSpace(space);
                        }}
                        className="inline-flex items-center gap-1 text-slate-400 hover:text-brand-600 rounded-lg px-2 py-1 hover:bg-brand-50 transition-all"
                        title="Pengaturan Ruang & Password"
                      >
                        <Settings className="h-3.5 w-3.5" />
                        <span>Atur</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setUnlockTarget({ space, asOwner: true, navigateAfter: true });
                        }}
                        className="inline-flex items-center gap-1 text-slate-400 hover:text-brand-600 rounded-lg px-2 py-1 hover:bg-brand-50 transition-all"
                        title="Masuk sebagai Pemilik untuk Upload/Edit"
                      >
                        <KeyRound className="h-3.5 w-3.5" />
                        <span>Pemilik</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="py-5 text-center text-xs text-slate-400 border-t border-slate-200/60 bg-white/50">
        <div className="max-w-6xl mx-auto px-4 flex items-center justify-center gap-4">
          <span>Personal Drive</span>
          <span>·</span>
          <Link href="/privacy" className="hover:text-slate-600 transition-colors">
            Kebijakan Privasi
          </Link>
        </div>
      </footer>

      {/* Create Space Modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        className="max-w-md"
      >
        <Card className="p-6">
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-brand-50 text-brand-600 p-2.5">
                <FolderPlus className="h-5 w-5" />
              </div>
              <div>
                <h2 className="font-semibold text-slate-900">Buat Folder Pribadi Baru</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Folder terpisah milikmu sendiri di Personal Drive
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setCreateOpen(false)}
              className="rounded-lg p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <form onSubmit={handleCreateSpace} className="space-y-4">
            <div>
              <label className="label" htmlFor="new-space-name">
                Nama Folder / Nama Kamu
              </label>
              <input
                id="new-space-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Contoh: Vex"
                className="input"
                maxLength={80}
                autoFocus
                required
              />
            </div>

            <div>
              <label className="label">Siapa yang boleh membuka folder ini?</label>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setNewVisibility("locked")}
                  className={`rounded-xl border p-3 text-left transition-all ${
                    newVisibility === "locked"
                      ? "border-amber-400 bg-amber-50/70 ring-1 ring-amber-200"
                      : "border-slate-200 bg-white hover:bg-slate-50"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <Lock className={`h-4 w-4 ${newVisibility === "locked" ? "text-amber-600" : "text-slate-400"}`} />
                    {newVisibility === "locked" && <Check className="h-3.5 w-3.5 text-amber-600" />}
                  </div>
                  <div className="text-xs font-semibold text-slate-900">Pasang Password</div>
                  <div className="text-[11px] text-slate-500 mt-0.5 leading-snug">
                    Privat — tidak ada yang bisa membuka tanpa password
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setNewVisibility("public")}
                  className={`rounded-xl border p-3 text-left transition-all ${
                    newVisibility === "public"
                      ? "border-emerald-400 bg-emerald-50/70 ring-1 ring-emerald-200"
                      : "border-slate-200 bg-white hover:bg-slate-50"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <Globe className={`h-4 w-4 ${newVisibility === "public" ? "text-emerald-600" : "text-slate-400"}`} />
                    {newVisibility === "public" && <Check className="h-3.5 w-3.5 text-emerald-600" />}
                  </div>
                  <div className="text-xs font-semibold text-slate-900">Publik</div>
                  <div className="text-[11px] text-slate-500 mt-0.5 leading-snug">
                    Bebas dilihat & didownload tanpa password (Read-Only)
                  </div>
                </button>
              </div>
            </div>

            <div>
              <label className="label" htmlFor="new-space-pw">
                Password Pemilik (untuk Upload & Kelola)
              </label>
              <div className="relative">
                <input
                  id="new-space-pw"
                  type={showNewPw ? "text" : "password"}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Buat password pemilik (minimal 10 karakter)…"
                  className="input pr-10"
                  minLength={8}
                  autoComplete="new-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowNewPw((v) => !v)}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600"
                  tabIndex={-1}
                >
                  {showNewPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-slate-400 leading-relaxed">
                Password ini hanya untuk membuktikan kepemilikan dan mengelola folder.
              </p>
            </div>

            {newVisibility === "locked" && (
              <div>
                <label className="label" htmlFor="new-space-lock-pw">Password Penguncian Folder</label>
                <input
                  id="new-space-lock-pw"
                  type="password"
                  value={newLockPassword}
                  onChange={(e) => setNewLockPassword(e.target.value)}
                  placeholder="Password untuk membuka folder (minimal 10 karakter)…"
                  className="input"
                  minLength={8}
                  autoComplete="new-password"
                  required
                />
                <p className="mt-1.5 text-[11px] text-slate-400 leading-relaxed">
                  Password ini terpisah dari password pemilik. Pengunjung hanya bisa membaca dan mengunduh setelah membukanya.
                </p>
              </div>
            )}

            {createError && (
              <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700">
                <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{createError}</span>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
                Batal
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={createBusy}
                disabled={!newName.trim() || newPassword.length < 8 || (newVisibility === "locked" && newLockPassword.length < 8) || (newVisibility === "locked" && newPassword === newLockPassword)}
              >
                <FolderPlus className="h-4 w-4" />
                Buat Folder
              </Button>
            </div>
          </form>
        </Card>
      </Modal>

      {/* Unlock / Owner Login Modal */}
      {unlockTarget && (
        <UnlockPasswordModal
          open={Boolean(unlockTarget)}
          spaceId={unlockTarget.space.id}
          folderId={unlockTarget.space.id}
          folderName={unlockTarget.space.name}
          asOwner={unlockTarget.asOwner}
          onSuccess={(res) => {
            const shouldNav = unlockTarget.navigateAfter;
            const targetId = res.space.id;
            setUnlockTarget(null);
            if (shouldNav) {
              router.push(`/drive?spaceId=${encodeURIComponent(targetId)}`);
            } else {
              void loadSpaces();
            }
          }}
          onClose={() => setUnlockTarget(null)}
        />
      )}

      {/* Space Security Settings Modal */}
      {settingsSpace && (
        <FolderSecurityModal
          open={Boolean(settingsSpace)}
          space={settingsSpace}
          onUpdated={() => void loadSpaces()}
          onSpaceDeleted={() => void loadSpaces()}
          onClose={() => setSettingsSpace(null)}
        />
      )}
    </main>
  );
}
