"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound, Lock, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { Button, Card, Modal } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { UnlockResponse } from "@personaldrive/shared";

interface UnlockPasswordModalProps {
  open: boolean;
  spaceId: string;
  folderId?: string;
  folderName: string;
  /** When true, prompts specifically for the Owner Password to enable upload/edit mode. */
  asOwner?: boolean;
  onSuccess: (res: UnlockResponse) => void;
  onClose: () => void;
}

export function UnlockPasswordModal({
  open,
  spaceId,
  folderId,
  folderName,
  asOwner = false,
  onSuccess,
  onClose,
}: UnlockPasswordModalProps) {
  const { unlock } = useAuth();
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPassword("");
      setShowPw(false);
      setError(null);
      setBusy(false);
    }
  }, [open, spaceId, folderId, asOwner]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await unlock({
        spaceId,
        folderId: folderId ?? spaceId,
        password,
        asOwner,
      });
      onSuccess(res);
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVALID_CREDENTIALS") {
        setError(asOwner ? "Password pemilik salah." : "Password folder salah.");
      } else {
        setError(err instanceof Error ? err.message : "Gagal memverifikasi password.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} className="max-w-sm">
      <Card className="p-6">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`rounded-xl p-2.5 shrink-0 ${
                asOwner ? "bg-brand-50 text-brand-600" : "bg-amber-50 text-amber-600"
              }`}
            >
              {asOwner ? <ShieldCheck className="h-5 w-5" /> : <Lock className="h-5 w-5" />}
            </div>
            <div className="min-w-0">
              <h2 className="font-semibold text-slate-900 truncate">
                {asOwner ? "Masuk sebagai Pemilik" : "Folder Terkunci"}
              </h2>
              <p className="text-xs text-slate-500 truncate mt-0.5">{folderName}</p>
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

        <p className="text-xs text-slate-500 mb-4 leading-relaxed">
          {asOwner
            ? `Masukkan Password Pemilik "${folderName}" agar kamu bisa upload file, membuat folder, menghapus, dan mengatur kunci dari perangkat ini.`
            : `Folder "${folderName}" dilindungi password. Masukkan password untuk membukanya.`}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label" htmlFor="unlock-pw">
              {asOwner ? "Password Pemilik" : "Password Folder"}
            </label>
            <div className="relative">
              <input
                id="unlock-pw"
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Masukkan password…"
                className="input pr-10"
                autoFocus
                required
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
            <Button type="submit" variant="primary" loading={busy} disabled={!password}>
              <KeyRound className="h-3.5 w-3.5" />
              {asOwner ? "Masuk Pemilik" : "Buka Folder"}
            </Button>
          </div>
        </form>
      </Card>
    </Modal>
  );
}
