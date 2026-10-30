"use client";

import { createContext, useContext } from "react";
import type {
  CreateSpaceRequest,
  CreateSpaceResponse,
  SessionInfo,
  UnlockRequest,
  UnlockResponse,
} from "@personaldrive/shared";

export interface AuthState {
  token: string | null;
  ownedSpaceIds: string[];
  unlockedFolderIds: string[];
  loading: boolean;
  isSpaceOwner(spaceId: string | null | undefined): boolean;
  applySession(session: SessionInfo): void;
  createSpace(req: CreateSpaceRequest): Promise<CreateSpaceResponse>;
  unlock(req: UnlockRequest): Promise<UnlockResponse>;
  logoutSpace(spaceId?: string): Promise<void>;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
