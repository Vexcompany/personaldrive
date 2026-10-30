"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CreateSpaceRequest, SessionInfo, UnlockRequest } from "@personaldrive/shared";
import { AuthContext, type AuthState } from "./auth-context";
import { api, TOKEN_KEY } from "./api";
import { FloatingUploadPanel } from "@/components/FloatingUploadPanel";
import { useToastSubscription, dismissToast, type ToastType } from "@/stores/useToastStore";
import { CheckCircle2, AlertCircle, Info, XCircle } from "lucide-react";

function parseTokenClaimsClient(token: string | null): { owned: string[]; unlocked: string[] } {
  if (!token) return { owned: [], unlocked: [] };
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { owned: [], unlocked: [] };
    const pad = parts[1].length % 4 === 0 ? "" : "=".repeat(4 - (parts[1].length % 4));
    const b64 = (parts[1] + pad).replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(b64)) as {
      owned?: Record<string, string>;
      unlocked?: Record<string, string>;
    };
    return {
      owned: Object.keys(decoded.owned ?? {}),
      unlocked: Object.keys(decoded.unlocked ?? {}),
    };
  } catch {
    return { owned: [], unlocked: [] };
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [ownedSpaceIds, setOwnedSpaceIds] = useState<string[]>([]);
  const [unlockedFolderIds, setUnlockedFolderIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const applySession = useCallback((session: SessionInfo) => {
    if (typeof window !== "undefined") {
      if (session.token) {
        window.localStorage.setItem(TOKEN_KEY, session.token);
      } else {
        window.localStorage.removeItem(TOKEN_KEY);
      }
    }
    setToken(session.token || null);
    setOwnedSpaceIds(session.ownedSpaceIds ?? []);
    setUnlockedFolderIds(session.unlockedFolderIds ?? []);
  }, []);

  useEffect(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(TOKEN_KEY) : null;
    if (stored) {
      const parsed = parseTokenClaimsClient(stored);
      setToken(stored);
      setOwnedSpaceIds(parsed.owned);
      setUnlockedFolderIds(parsed.unlocked);
    }
    setLoading(false);
  }, []);

  const isSpaceOwner = useCallback(
    (spaceId: string | null | undefined) => {
      if (!spaceId) return false;
      return ownedSpaceIds.includes(spaceId);
    },
    [ownedSpaceIds]
  );

  const createSpace = useCallback(
    async (req: CreateSpaceRequest) => {
      const res = await api.createSpace(req);
      applySession(res.session);
      return res;
    },
    [applySession]
  );

  const unlock = useCallback(
    async (req: UnlockRequest) => {
      const res = await api.unlock(req);
      applySession(res.session);
      return res;
    },
    [applySession]
  );

  const logoutSpace = useCallback(
    async (spaceId?: string) => {
      try {
        const res = await api.logout(spaceId);
        applySession(res.session);
      } catch {
        applySession({ token: "", ownedSpaceIds: [], unlockedFolderIds: [], issuedAt: 0 });
      }
    },
    [applySession]
  );

  const value = useMemo<AuthState>(
    () => ({
      token,
      ownedSpaceIds,
      unlockedFolderIds,
      loading,
      isSpaceOwner,
      applySession,
      createSpace,
      unlock,
      logoutSpace,
    }),
    [token, ownedSpaceIds, unlockedFolderIds, loading, isSpaceOwner, applySession, createSpace, unlock, logoutSpace]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      <FloatingUploadPanel />
      <GlobalToast />
    </AuthContext.Provider>
  );
}

function GlobalToast() {
  const toast = useToastSubscription();
  if (!toast) return null;

  const icons: Record<ToastType, typeof CheckCircle2> = {
    success: CheckCircle2,
    error: AlertCircle,
    info: Info,
  };
  const colors: Record<ToastType, string> = {
    success: "text-emerald-400",
    error: "text-red-400",
    info: "text-brand-400",
  };
  const Icon = icons[toast.type];

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-pop-in">
      <div className="flex items-center gap-3 rounded-xl bg-slate-900 text-white px-4 py-3 shadow-lg text-sm">
        <Icon className={`h-4 w-4 shrink-0 ${colors[toast.type]}`} />
        <span>{toast.message}</span>
        {toast.action && (
          <button
            onClick={toast.action.onClick}
            className="font-semibold text-brand-400 hover:text-brand-300 transition-colors whitespace-nowrap"
          >
            {toast.action.label}
          </button>
        )}
        <button onClick={dismissToast} className="text-slate-400 hover:text-slate-200 ml-1">
          <XCircle className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
