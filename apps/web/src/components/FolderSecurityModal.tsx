"use client";

import { useEffect, useState } from "react";
import {
  Eye,
  EyeOff,
  Globe,
  Lock,
  Shield,
  Trash2,
  TriangleAlert,
  X,
  Check,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button, Card, Modal } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { showToast } from "@/stores/useToastStore";
import type { FolderVisibility, SpaceSummary } from "@personaldrive/shared";

interface FolderSecurityModalProps {
  open: boolean;
  space: SpaceSummary;
  /** When editing a subfolder, pass its id, name, and current lock status. Omit when editing the root space itself. */
  subfolder?: {
    id: string;
    name: string;
    visibility: FolderVisibility;
    isLocked: boolean;
  } | null;
  onUpdated: () => void;
  onSpaceDeleted?: () => void;
  onClose: () => void;
}

export function FolderSecurityModal({
  open,
  space,
  subfolder = null,
  onUpdated,
  onSpaceDeleted,
  onClose,
}: FolderSecurityModalProps) {
  const { applySession } = useAuth();
  const isRootSpace = !subfolder;
  const targetId = subfolder ? subfolder.id : space.id;
  const targetName = subfolder ? subfolder.name : space.name;

  const [visibility, setVisibility] = useState<FolderVisibility>(
    subfolder ? subfolder.visibility : space.visibility
  );
  const [spaceName, setSpaceName] = useState(space.name);
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);

  // Advanced root-space sections
  const [showChangeOwnerPw, setShowChangeOwnerPw] = useState(false);
  const [currentOwnerPassword, setCurrentOwnerPassword] = useState("");
  const [newOwnerPassword, setNewOwnerPassword] = useState("");

  const [showVisitorPwSection, setShowVisitorPwSection] = useState(false);
  const [clearVisitorPw, setClearVisitorPw] = useState(false);

  const [showDeleteZone, setShowDeleteZone] = useState(false);
  const [deleteOwnerPassword, setDeleteOwnerPassword] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setVisibility(subfolder ? subfolder.visibility : space.visibility);
      setSpaceName(space.name);
      setPassword("");
      setShowPw(false);
      setShowChangeOwnerPw(false);
      setCurrentOwnerPassword("");
      setNewOwnerPassword("");
      setShowVisitorPwSection(false);
      setClearVisitorPw(false);
      setShowDeleteZone(false);
      setDeleteOwnerPassword("");
      setError(null);
      setBusy(false);
      setDeleteBusy(false);
    }
  }, [open, space, subfolder]);

  if (!open) return null;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);

    if (!isRootSpace && visibility === "locked" && !subfolder?.isLocked && !password.trim()) {
      setError("Masukkan password baru untuk mengunci subfolder ini.");
      return;
    }

    setBusy(true);
    try {
      const payload: Parameters<typeof api.updateFolderSecurity>[0] = {
        folderId: targetId,
        spaceId: space.id,
        visibility,
      };

      if (isRootSpace) {
        if (spaceName.trim() && spaceName.trim() !== space.name) {
          payload.name = spaceName.trim();
        }
        if (visibility === "locked") {
          if (clearVisitorPw) {
            payload.password = "";
          } else if (password.trim()) {
            payload.password = password;
          }
        }
        if (showChangeOwnerPw && newOwnerPassword) {
          payload.currentOwnerPassword = currentOwnerPassword;
          payload.newOwnerPassword = newOwnerPassword;
        }
      } else {
        if (visibility === "locked" && password) {
          payload.password = password;
        }
      }

      const res = await api.updateFolderSecurity(payload);
      if (res.session) {
        applySession(res.session);
      }
      showToast(
        visibility === "locked"
          ? `Folder "${res.folder.name}" sekarang terkunci password`
          : `Folder "${res.folder.name}" sekarang publik`
      );
      onUpdated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan pengaturan keamanan.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteSpace() {
    if (!deleteOwnerPassword || deleteBusy) return;
    setDeleteBusy(true);
    setError(null);
    try {
      const res = await api.deleteSpace(space.id, deleteOwnerPassword);
      applySession(res.session);
      showToast(`Ruang "${space.name}" telah dihapus`);
      onSpaceDeleted?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menghapus ruang.");
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} className="max-w-md">
      <Card className="p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="rounded-xl bg-brand-50 text-brand-600 p-2.5 shrink-0">
              <Shield className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="font-semibold text-slate-900 truncate">
                {isRootSpace ? "Pengaturan Ruang & Password" : "Atur Kunci Subfolder"}
              </h2>
              <p className="text-xs text-slate-500 truncate mt-0.5">{targetName}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-all"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSave} className="space-y-4">
          {isRootSpace && (
            <div>
              <label className="label" htmlFor="sec-space-name">
                Nama Ruang / Folder Utama
              </label>
              <input
                id="sec-space-name"
                value={spaceName}
                onChange={(e) => setSpaceName(e.target.value)}
                className="input"
                maxLength={80}
                required
              />
            </div>
          )}

          {/* Visibility selector */}
          <div>
            <label className="label">Akses Pengunjung</label>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setVisibility("public")}
                className={`rounded-xl border p-3 text-left transition-all ${
                  visibility === "public"
                    ? "border-emerald-400 bg-emerald-50/70 ring-1 ring-emerald-200"
                    : "border-slate-200 bg-white hover:bg-slate-50"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <Globe className={`h-4 w-4 ${visibility === "public" ? "text-emerald-600" : "text-slate-400"}`} />
                  {visibility === "public" && <Check className="h-3.5 w-3.5 text-emerald-600" />}
                </div>
                <div className="text-xs font-semibold text-slate-900">Publik</div>
                <div className="text-[11px] text-slate-500 mt-0.5 leading-snug">
                  Bisa dilihat & download tanpa password (Read-Only)
                </div>
              </button>

              <button
                type="button"
                onClick={() => setVisibility("locked")}
                className={`rounded-xl border p-3 text-left transition-all ${
                  visibility === "locked"
                    ? "border-amber-400 bg-amber-50/70 ring-1 ring-amber-200"
                    : "border-slate-200 bg-white hover:bg-slate-50"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <Lock className={`h-4 w-4 ${visibility === "locked" ? "text-amber-600" : "text-slate-400"}`} />
                  {visibility === "locked" && <Check className="h-3.5 w-3.5 text-amber-600" />}
                </div>
                <div className="text-xs font-semibold text-slate-900">Terkunci</div>
                <div className="text-[11px] text-slate-500 mt-0.5 leading-snug">
                  Wajib masukkan password untuk membuka
                </div>
              </button>
            </div>
          </div>

          {/* Subfolder password input when locked */}
          {!isRootSpace && visibility === "locked" && (
            <div>
              <label className="label" htmlFor="sec-sub-pw">
                {subfolder?.isLocked ? "Ganti Password Subfolder (opsional)" : "Password Subfolder"}
              </label>
              <div className="relative">
                <input
                  id="sec-sub-pw"
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={
                    subfolder?.isLocked
                      ? "Kosongkan jika tetap memakai password lama"
                      : "Masukkan password untuk subfolder ini…"
                  }
                  className="input pr-10"
                  minLength={8}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600"
                  tabIndex={-1}
                >
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          )}

          {/* Optional separate visitor password for locked root spaces */}
          {isRootSpace && visibility === "locked" && (
            <div className="rounded-xl border border-slate-200 p-3 bg-slate-50/60 space-y-2">
              <button
                type="button"
                onClick={() => setShowVisitorPwSection((v) => !v)}
                className="w-full flex items-center justify-between text-xs font-medium text-slate-700"
              >
                <span>
                  Password Khusus Tamu Read-Only{" "}
                  {space.hasVisitorPassword ? "(Aktif)" : "(Opsional)"}
                </span>
                {showVisitorPwSection ? (
                  <ChevronUp className="h-3.5 w-3.5 text-slate-400" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
                )}
              </button>
              {!showVisitorPwSection && (
                <p className="text-[11px] text-slate-500">
                  Secara default ruang terkunci dibuka memakai Password Pemilik. Kamu juga bisa mengatur password terpisah khusus tamu (hanya lihat & download).
                </p>
              )}
              {showVisitorPwSection && (
                <div className="space-y-2 pt-1">
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setClearVisitorPw(false);
                    }}
                    placeholder="Password khusus tamu (minimal 8 karakter)…"
                    className="input text-xs"
                    minLength={8}
                    autoComplete="new-password"
                  />
                  {space.hasVisitorPassword && (
                    <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={clearVisitorPw}
                        onChange={(e) => {
                          setClearVisitorPw(e.target.checked);
                          if (e.target.checked) setPassword("");
                        }}
                        className="accent-brand-500 rounded"
                      />
                      Hapus password tamu (hanya gunakan Password Pemilik)
                    </label>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Change Owner Password section for Root Space */}
          {isRootSpace && (
            <div className="rounded-xl border border-slate-200 p-3 space-y-2">
              <button
                type="button"
                onClick={() => setShowChangeOwnerPw((v) => !v)}
                className="w-full flex items-center justify-between text-xs font-medium text-slate-700"
              >
                <span>Ganti Password Pemilik</span>
                {showChangeOwnerPw ? (
                  <ChevronUp className="h-3.5 w-3.5 text-slate-400" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
                )}
              </button>
              {showChangeOwnerPw && (
                <div className="space-y-2.5 pt-2">
                  <input
                    type="password"
                    value={currentOwnerPassword}
                    onChange={(e) => setCurrentOwnerPassword(e.target.value)}
                    placeholder="Password Pemilik saat ini"
                    className="input text-xs"
                  />
                  <input
                    type="password"
                    value={newOwnerPassword}
                    onChange={(e) => setNewOwnerPassword(e.target.value)}
                    placeholder="Password Pemilik baru (minimal 8 karakter)"
                    className="input text-xs"
                    minLength={8}
                    autoComplete="new-password"
                  />
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700">
              <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={onClose}>
              Batal
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              Simpan Pengaturan
            </Button>
          </div>
        </form>

        {/* Danger Zone: Delete entire person space */}
        {isRootSpace && (
          <div className="mt-5 pt-4 border-t border-slate-100">
            {!showDeleteZone ? (
              <button
                type="button"
                onClick={() => setShowDeleteZone(true)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 hover:text-red-700"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Hapus ruang &quot;{space.name}&quot; secara permanen…
              </button>
            ) : (
              <div className="rounded-xl border border-red-200 bg-red-50/60 p-3.5 space-y-2.5">
                <p className="text-xs text-red-800 font-medium">
                  Hapus seluruh ruang &quot;{space.name}&quot; beserta semua file di dalamnya?
                </p>
                <input
                  type="password"
                  value={deleteOwnerPassword}
                  onChange={(e) => setDeleteOwnerPassword(e.target.value)}
                  placeholder="Konfirmasi dengan Password Pemilik…"
                  className="input text-xs bg-white"
                />
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShowDeleteZone(false);
                      setDeleteOwnerPassword("");
                    }}
                  >
                    Batal
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    loading={deleteBusy}
                    disabled={!deleteOwnerPassword}
                    onClick={() => void handleDeleteSpace()}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Hapus Permanen
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
    </Modal>
  );
}
