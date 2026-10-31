import type { Env } from "./env";
import { signJwt, verifyJwt, type JwtPayload } from "./jwt";
import {
  generateSalt,
  getFolderVisibility,
  getLockTag,
  getOwnerTag,
  hashPassword,
  hasSeparateVisitorPassword,
  isFolderLockedProp,
  verifyPassword,
} from "./crypto";
import {
  collectSubtree,
  createFolder,
  deleteFile,
  ensureFolder,
  fetchMedia,
  forwardChunk,
  getFile,
  getStorageInfo,
  HttpError,
  listChildren,
  listPermissions,
  listTrashed,
  moveFile,
  renameFile,
  restoreFile,
  revokePublicPermissions,
  searchDrive,
  searchTrashed,
  startResumableUpload,
  trashFile,
  updateFileMetadata,
  type DriveFile,
} from "./google";
import { buildZip } from "./zip";
import type {
  AccessRole,
  ApiErrorCode,
  DriveFile as ClientDriveFile,
  DriveFolder as ClientDriveFolder,
  FolderVisibility,
  SessionInfo,
  SpaceSummary,
} from "@personaldrive/shared";

const MAX_BATCH = 20;

const CORS_HEADERS = (origin: string) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, x-session-uri, x-upload-start, x-upload-end, x-upload-total",
  "Access-Control-Max-Age": "86400",
});

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function json(data: unknown, init: ResponseInit = {}, origin = "*"): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...JSON_HEADERS, ...CORS_HEADERS(origin), ...(init.headers ?? {}) },
  });
}

function err(
  code: ApiErrorCode,
  message: string,
  status: number,
  origin = "*",
  extra?: { lockedFolderId?: string; lockedFolderName?: string; spaceId?: string }
): Response {
  return json({ success: false, code, message, status, ...(extra ?? {}) }, { status }, origin);
}

function throwHttp(
  status: number,
  code: HttpError["code"],
  message: string,
  extra?: { lockedFolderId?: string; lockedFolderName?: string; spaceId?: string }
): never {
  throw new HttpError(status, code, message, extra);
}

function getRootId(env: Env): string {
  if (env.GOOGLE_DRIVE_ROOT) return env.GOOGLE_DRIVE_ROOT;
  if (env.MOCK_DRIVE === "true") return "mock_root";
  throwHttp(500, "MISSING_CONFIG", "GOOGLE_DRIVE_ROOT is not configured.");
}

function getJwtSecret(env: Env): string {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  if (env.MOCK_DRIVE === "true") return "dev-mock-jwt-secret";
  throwHttp(500, "MISSING_CONFIG", "JWT_SECRET is not configured.");
}

interface SessionState {
  owned: Record<string, string>;
  unlocked: Record<string, string>;
}

async function parseSession(request: Request, url: URL, env: Env): Promise<SessionState> {
  const auth = request.headers.get("authorization") || "";
  const headerToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const queryToken = url.searchParams.get("token") || "";
  const raw = headerToken || queryToken;
  if (!raw) return { owned: {}, unlocked: {} };
  const secret = env.JWT_SECRET || (env.MOCK_DRIVE === "true" ? "dev-mock-jwt-secret" : "");
  if (!secret) return { owned: {}, unlocked: {} };
  const payload: JwtPayload | null = await verifyJwt(raw, secret);
  if (!payload) return { owned: {}, unlocked: {} };
  return {
    owned: { ...(payload.owned ?? {}) },
    unlocked: { ...(payload.unlocked ?? {}) },
  };
}

async function mintSessionInfo(session: SessionState, env: Env): Promise<SessionInfo> {
  const secret = getJwtSecret(env);
  const hasAny = Object.keys(session.owned).length > 0 || Object.keys(session.unlocked).length > 0;
  const token = hasAny ? await signJwt({ owned: session.owned, unlocked: session.unlocked }, secret) : "";
  return {
    token,
    ownedSpaceIds: Object.keys(session.owned),
    unlockedFolderIds: Object.keys(session.unlocked),
    issuedAt: Math.floor(Date.now() / 1000),
  };
}

function isOwnerOfSpace(session: SessionState, spaceFolder: DriveFile): boolean {
  const props = spaceFolder.appProperties;
  if (!props?.pd_oh || !props?.pd_os) return false;
  return session.owned[spaceFolder.id] === getOwnerTag(props);
}

function isFolderUnlocked(session: SessionState, spaceFolder: DriveFile, folder: DriveFile): boolean {
  if (isOwnerOfSpace(session, spaceFolder)) return true;
  if (!isFolderLockedProp(folder.appProperties)) return true;
  return session.unlocked[folder.id] === getLockTag(folder.appProperties);
}

function toSpaceSummary(folder: DriveFile, session: SessionState): SpaceSummary {
  const props = folder.appProperties;
  const visibility = getFolderVisibility(props);
  const isLocked = visibility === "locked";
  const isOwner = isOwnerOfSpace(session, folder);
  const isUnlocked = isFolderUnlocked(session, folder, folder);
  return {
    id: folder.id,
    name: folder.name,
    visibility,
    isLocked,
    isOwner,
    isUnlocked,
    hasVisitorPassword: hasSeparateVisitorPassword(props),
    modifiedTime: folder.modifiedTime,
    createdTime: folder.createdTime ?? folder.modifiedTime,
  };
}

function toClientFile(f: DriveFile, session: SessionState, spaceFolder: DriveFile): ClientDriveFile {
  const isFolder = f.mimeType === "application/vnd.google-apps.folder";
  const base: ClientDriveFile = {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size ? Number(f.size) : null,
    parents: f.parents ?? [],
    thumbnailLink: f.thumbnailLink,
    webViewLink: null,
    modifiedTime: f.modifiedTime,
    trashed: f.trashed,
  };
  if (isFolder) {
    base.visibility = getFolderVisibility(f.appProperties);
    base.isLocked = isFolderLockedProp(f.appProperties);
    base.isUnlocked = isFolderUnlocked(session, spaceFolder, f);
  }
  return base;
}

/**
 * Walks parents from `targetId` up to `rootId`, returning `[spaceFolder, ...ancestors, target]`.
 * Throws 403 FORBIDDEN if `targetId` is not inside `rootId`.
 */
async function resolveChain(
  env: Env,
  targetId: string,
  rootId: string,
  cache = new Map<string, DriveFile>()
): Promise<{ spaceFolder: DriveFile; chain: DriveFile[] }> {
  if (targetId === rootId) {
    throwHttp(403, "FORBIDDEN", "Direct access to Drive root is not permitted.");
  }
  const chain: DriveFile[] = [];
  let currentId: string | undefined = targetId;
  const seen = new Set<string>();

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    let node = cache.get(currentId);
    if (!node) {
      node = await getFile(env, currentId);
      cache.set(currentId, node);
    }
    chain.unshift(node);
    if (node.parents?.includes(rootId)) {
      if (node.mimeType !== "application/vnd.google-apps.folder") {
        throwHttp(403, "FORBIDDEN", "Invalid space root.");
      }
      return { spaceFolder: node, chain };
    }
    currentId = node.parents?.[0];
  }

  throwHttp(403, "FORBIDDEN", "Item is outside the Personal Drive root.");
}

function assertReadAccess(session: SessionState, spaceFolder: DriveFile, chain: DriveFile[]): AccessRole {
  if (spaceFolder.trashed) {
    throwHttp(404, "NOT_FOUND", "Ruang ini sudah dihapus.");
  }
  if (isOwnerOfSpace(session, spaceFolder)) {
    return "owner";
  }
  for (const node of chain) {
    if (node.trashed) {
      throwHttp(403, "ITEM_IN_TRASH", "Item berada di Sampah dan hanya bisa dilihat oleh pemilik.");
    }
    if (node.mimeType === "application/vnd.google-apps.folder" && !isFolderUnlocked(session, spaceFolder, node)) {
      throwHttp(
        403,
        "FOLDER_LOCKED",
        `Folder "${node.name}" dilindungi password.`,
        { lockedFolderId: node.id, lockedFolderName: node.name, spaceId: spaceFolder.id }
      );
    }
  }
  return "viewer";
}

function assertOwnerAccess(session: SessionState, spaceFolder: DriveFile): void {
  if (spaceFolder.trashed) {
    throwHttp(404, "NOT_FOUND", "Ruang ini sudah dihapus.");
  }
  if (!isOwnerOfSpace(session, spaceFolder)) {
    throwHttp(
      403,
      "FORBIDDEN",
      "Akses ditolak. Masuk menggunakan Password Pemilik untuk mengupload atau mengubah isi folder."
    );
  }
}

async function revokePublicTree(
  env: Env,
  folderId: string,
  depth = 0,
  state: { visited: number } = { visited: 0 }
): Promise<void> {
  if (depth > 20) throwHttp(400, "INVALID_PAYLOAD", "Struktur folder terlalu dalam untuk pengamanan otomatis.");
  state.visited += 1;
  if (state.visited > 1000) throwHttp(413, "INVALID_PAYLOAD", "Folder memiliki lebih dari 1.000 item; penguncian dibatalkan agar tidak meninggalkan tautan publik.");
  const children = await listChildren(env, folderId);
  for (const child of children) {
    if (child.trashed) continue;
    state.visited += 1;
    if (state.visited > 1000) throwHttp(413, "INVALID_PAYLOAD", "Folder memiliki lebih dari 1.000 item; penguncian dibatalkan agar tidak meninggalkan tautan publik.");
    await revokePublicPermissions(env, child.id);
    if (child.mimeType === "application/vnd.google-apps.folder") {
      await revokePublicTree(env, child.id, depth + 1, state);
    }
  }
  await revokePublicPermissions(env, folderId);
}

function validateBatchIds(body: unknown): string[] {
  if (
    !body ||
    !Array.isArray((body as { fileIds?: unknown }).fileIds) ||
    (body as { fileIds: unknown[] }).fileIds.length === 0 ||
    !(body as { fileIds: unknown[] }).fileIds.every((id) => typeof id === "string")
  ) {
    throwHttp(400, "INVALID_PAYLOAD", "fileIds must be a non-empty array of strings.");
  }
  const ids = (body as { fileIds: string[] }).fileIds;
  if (ids.length > MAX_BATCH) {
    throwHttp(400, "INVALID_PAYLOAD", `Batch too large: ${ids.length} items. Maximum is ${MAX_BATCH} per request.`);
  }
  return ids;
}

function validateFolderName(raw: unknown): string {
  if (typeof raw !== "string") throwHttp(400, "INVALID_PAYLOAD", "Nama folder wajib diisi.");
  const trimmed = raw.trim();
  if (!trimmed) throwHttp(400, "INVALID_PAYLOAD", "Nama folder tidak boleh kosong.");
  if (trimmed.length > 80) throwHttp(400, "INVALID_PAYLOAD", "Nama folder maksimal 80 karakter.");
  if (/[\\/]/.test(trimmed)) throwHttp(400, "INVALID_PAYLOAD", "Nama folder tidak boleh mengandung karakter / atau \\.");
  return trimmed;
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const origin = env.CORS_ORIGIN ?? "*";
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS(origin) });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    const rootId = getRootId(env);
    const session = await parseSession(request, url, env);

    // ── SPACES (Top-level folders per person) ──────────────────────────────

    // GET /spaces — list all people's spaces on the home page
    if (path === "/spaces" && request.method === "GET") {
      const children = await listChildren(env, rootId);
      const spaces = children
        .filter((f) => f.mimeType === "application/vnd.google-apps.folder" && !f.trashed)
        .map((f) => toSpaceSummary(f, session));
      return json({ spaces }, {}, origin);
    }

    // POST /spaces — create a new person's space
    if (path === "/spaces" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        name?: unknown;
        ownerPassword?: unknown;
        visibility?: unknown;
        visitorPassword?: unknown;
      } | null;
      if (!body) return err("INVALID_PAYLOAD", "Invalid JSON body.", 400, origin);

      const name = validateFolderName(body.name);
      if (typeof body.ownerPassword !== "string" || body.ownerPassword.length < 8) {
        return err("INVALID_PAYLOAD", "Password pemilik minimal 8 karakter.", 400, origin);
      }
      const visibility: FolderVisibility = body.visibility === "locked" ? "locked" : "public";
      if (visibility === "locked") {
        if (typeof body.visitorPassword !== "string" || body.visitorPassword.length < 8) {
          return err("INVALID_PAYLOAD", "Password penguncian wajib diisi dan minimal 8 karakter.", 400, origin);
        }
        if (body.visitorPassword === body.ownerPassword) {
          return err("INVALID_PAYLOAD", "Password pemilik dan password penguncian harus berbeda.", 400, origin);
        }
      }

      const existing = await listChildren(env, rootId);
      const duplicate = existing.find(
        (f) =>
          f.mimeType === "application/vnd.google-apps.folder" &&
          !f.trashed &&
          f.name.toLowerCase() === name.toLowerCase()
      );
      if (duplicate) {
        return err("NAME_TAKEN", `Folder "${name}" sudah digunakan. Silakan pilih nama lain.`, 409, origin);
      }

      const ownerSalt = generateSalt();
      const ownerHash = await hashPassword(body.ownerPassword, ownerSalt);
      const appProperties: Record<string, string> = {
        pd_vis: visibility,
        pd_oh: ownerHash,
        pd_os: ownerSalt,
        pd_cat: String(Math.floor(Date.now() / 1000)),
      };

      if (visibility === "locked" && typeof body.visitorPassword === "string") {
        const lockSalt = generateSalt();
        const lockHash = await hashPassword(body.visitorPassword, lockSalt);
        appProperties.pd_lh = lockHash;
        appProperties.pd_ls = lockSalt;
      }

      const created = await createFolder(env, rootId, name, appProperties);
      const nextSession: SessionState = {
        owned: { ...session.owned, [created.id]: getOwnerTag(created.appProperties) },
        unlocked: { ...session.unlocked, [created.id]: getLockTag(created.appProperties) },
      };
      const sessionInfo = await mintSessionInfo(nextSession, env);
      return json(
        { space: toSpaceSummary(created, nextSession), session: sessionInfo },
        { status: 201 },
        origin
      );
    }

    // DELETE /spaces/:id — delete a person's space (requires ownerPassword confirmation)
    const deleteSpaceMatch = /^\/spaces\/([^/]+)$/.exec(path);
    if (deleteSpaceMatch && request.method === "DELETE") {
      const spaceId = decodeURIComponent(deleteSpaceMatch[1]);
      const body = (await request.json().catch(() => null)) as { ownerPassword?: unknown } | null;
      if (!body || typeof body.ownerPassword !== "string" || !body.ownerPassword) {
        return err("INVALID_PAYLOAD", "Masukkan password pemilik untuk menghapus ruang ini.", 400, origin);
      }
      const spaceFolder = await getFile(env, spaceId);
      if (!spaceFolder.parents?.includes(rootId) || spaceFolder.mimeType !== "application/vnd.google-apps.folder") {
        return err("FORBIDDEN", "Target bukan ruang utama yang valid.", 403, origin);
      }
      const ok = await verifyPassword(
        body.ownerPassword,
        spaceFolder.appProperties?.pd_os,
        spaceFolder.appProperties?.pd_oh
      );
      if (!ok) {
        return err("INVALID_CREDENTIALS", "Password pemilik salah.", 401, origin);
      }
      await deleteFile(env, spaceId);
      const nextOwned = { ...session.owned };
      delete nextOwned[spaceId];
      const nextUnlocked = { ...session.unlocked };
      delete nextUnlocked[spaceId];
      const sessionInfo = await mintSessionInfo({ owned: nextOwned, unlocked: nextUnlocked }, env);
      return json({ ok: true, session: sessionInfo }, {}, origin);
    }

    // ── AUTH / UNLOCK ──────────────────────────────────────────────────────

    // GET /auth/session — inspect active client session
    if (path === "/auth/session" && request.method === "GET") {
      const sessionInfo = await mintSessionInfo(session, env);
      return json({ session: sessionInfo }, {}, origin);
    }

    // POST /auth/unlock — unlock a locked space/subfolder OR sign in as space Owner
    if (path === "/auth/unlock" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        spaceId?: unknown;
        folderId?: unknown;
        password?: unknown;
        asOwner?: unknown;
      } | null;
      if (
        !body ||
        typeof body.spaceId !== "string" ||
        !body.spaceId ||
        typeof body.password !== "string" ||
        body.password.length === 0
      ) {
        return err("INVALID_LOGIN_PAYLOAD", "Masukkan password terlebih dahulu.", 400, origin);
      }

      const spaceId = body.spaceId;
      const targetFolderId = typeof body.folderId === "string" && body.folderId ? body.folderId : spaceId;
      const asOwner = Boolean(body.asOwner);

      const cache = new Map<string, DriveFile>();
      const { spaceFolder, chain } = await resolveChain(env, targetFolderId, rootId, cache);
      if (spaceFolder.id !== spaceId) {
        return err("FORBIDDEN", "Folder tidak berada di dalam ruang yang dimaksud.", 403, origin);
      }

      // Always check if the password matches the space's Owner Password first!
      const ownerMatch = await verifyPassword(
        body.password,
        spaceFolder.appProperties?.pd_os,
        spaceFolder.appProperties?.pd_oh
      );

      if (ownerMatch) {
        const nextSession: SessionState = {
          owned: { ...session.owned, [spaceFolder.id]: getOwnerTag(spaceFolder.appProperties) },
          unlocked: {
            ...session.unlocked,
            [spaceFolder.id]: getLockTag(spaceFolder.appProperties),
          },
        };
        const sessionInfo = await mintSessionInfo(nextSession, env);
        return json(
          {
            session: sessionInfo,
            role: "owner" as AccessRole,
            space: toSpaceSummary(spaceFolder, nextSession),
          },
          {},
          origin
        );
      }

      if (asOwner) {
        return err("INVALID_CREDENTIALS", "Password pemilik salah.", 401, origin);
      }

      // Viewer unlock on root space (if separate visitorPassword was configured) or locked subfolder
      const targetFolder = chain[chain.length - 1];
      if (targetFolder.mimeType !== "application/vnd.google-apps.folder") {
        return err("INVALID_PAYLOAD", "Target bukan folder.", 400, origin);
      }

      const visitorMatch = await verifyPassword(
        body.password,
        targetFolder.appProperties?.pd_ls,
        targetFolder.appProperties?.pd_lh
      );

      if (visitorMatch) {
        const nextSession: SessionState = {
          owned: { ...session.owned },
          unlocked: {
            ...session.unlocked,
            [targetFolder.id]: getLockTag(targetFolder.appProperties),
          },
        };
        const sessionInfo = await mintSessionInfo(nextSession, env);
        const role: AccessRole = isOwnerOfSpace(nextSession, spaceFolder) ? "owner" : "viewer";
        return json(
          {
            session: sessionInfo,
            role,
            space: toSpaceSummary(spaceFolder, nextSession),
          },
          {},
          origin
        );
      }

      return err("INVALID_CREDENTIALS", "Password yang dimasukkan salah.", 401, origin);
    }

    // POST /auth/logout — drop owner/unlocked status for a space (or all spaces)
    if (path === "/auth/logout" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { spaceId?: unknown } | null;
      const spaceId = typeof body?.spaceId === "string" ? body.spaceId : null;
      if (!spaceId) {
        const sessionInfo = await mintSessionInfo({ owned: {}, unlocked: {} }, env);
        return json({ session: sessionInfo }, {}, origin);
      }
      const nextOwned = { ...session.owned };
      delete nextOwned[spaceId];
      const nextUnlocked = { ...session.unlocked };
      delete nextUnlocked[spaceId];
      const sessionInfo = await mintSessionInfo({ owned: nextOwned, unlocked: nextUnlocked }, env);
      return json({ session: sessionInfo }, {}, origin);
    }

    // ── FOLDER SECURITY SETTINGS (Root space or any subfolder) ─────────────

    const securityMatch = /^\/folders\/([^/]+)\/security$/.exec(path);
    if (securityMatch && request.method === "PATCH") {
      const folderId = decodeURIComponent(securityMatch[1]);
      const body = (await request.json().catch(() => null)) as {
        spaceId?: unknown;
        visibility?: unknown;
        password?: unknown;
        newOwnerPassword?: unknown;
        currentOwnerPassword?: unknown;
        name?: unknown;
      } | null;
      if (!body || (body.visibility !== "public" && body.visibility !== "locked")) {
        return err("INVALID_PAYLOAD", "Pilih mode akses 'public' atau 'locked'.", 400, origin);
      }

      const { spaceFolder, chain } = await resolveChain(env, folderId, rootId);
      if (typeof body.spaceId === "string" && body.spaceId !== spaceFolder.id) {
        return err("FORBIDDEN", "Folder tidak sesuai dengan ruang aktif.", 403, origin);
      }
      assertOwnerAccess(session, spaceFolder);

      const targetFolder = chain[chain.length - 1];
      if (targetFolder.mimeType !== "application/vnd.google-apps.folder") {
        return err("INVALID_PAYLOAD", "Hanya folder yang dapat diatur pengunciannya.", 400, origin);
      }

      const visibility: FolderVisibility = body.visibility;
      const appPatch: Record<string, string | null> = { pd_vis: visibility };
      let newName: string | undefined;
      const nextSession: SessionState = {
        owned: { ...session.owned },
        unlocked: { ...session.unlocked },
      };

      if (targetFolder.id === spaceFolder.id) {
        // Updating the person's root space
        if (typeof body.name === "string" && body.name.trim() && body.name.trim() !== spaceFolder.name) {
          const validated = validateFolderName(body.name);
          const siblings = await listChildren(env, rootId);
          const dup = siblings.find(
            (s) =>
              s.id !== spaceFolder.id &&
              s.mimeType === "application/vnd.google-apps.folder" &&
              !s.trashed &&
              s.name.toLowerCase() === validated.toLowerCase()
          );
          if (dup) {
            return err("NAME_TAKEN", `Nama folder "${validated}" sudah dipakai.`, 409, origin);
          }
          newName = validated;
        }

        if (typeof body.newOwnerPassword === "string" && body.newOwnerPassword.length > 0) {
          if (typeof body.currentOwnerPassword !== "string" || !body.currentOwnerPassword) {
            return err("INVALID_PAYLOAD", "Masukkan password pemilik saat ini untuk mengganti password.", 400, origin);
          }
          const validCurrent = await verifyPassword(
            body.currentOwnerPassword,
            spaceFolder.appProperties?.pd_os,
            spaceFolder.appProperties?.pd_oh
          );
          if (!validCurrent) {
            return err("INVALID_CREDENTIALS", "Password pemilik saat ini salah.", 401, origin);
          }
          const newSalt = generateSalt();
          const newHash = await hashPassword(body.newOwnerPassword, newSalt);
          appPatch.pd_os = newSalt;
          appPatch.pd_oh = newHash;
        }

        if (visibility === "public") {
          appPatch.pd_lh = null;
          appPatch.pd_ls = null;
        } else if (typeof body.password === "string" && body.password.length >= 8) {
          const sameAsOwner = await verifyPassword(body.password, spaceFolder.appProperties?.pd_os, spaceFolder.appProperties?.pd_oh);
          if (sameAsOwner) return err("INVALID_PAYLOAD", "Password penguncian harus berbeda dari password pemilik.", 400, origin);
          const vSalt = generateSalt();
          const vHash = await hashPassword(body.password, vSalt);
          appPatch.pd_lh = vHash;
          appPatch.pd_ls = vSalt;
        } else if (!hasSeparateVisitorPassword(spaceFolder.appProperties)) {
          return err("INVALID_PAYLOAD", "Password penguncian baru wajib diisi (minimal 8 karakter).", 400, origin);
        }

        if (visibility === "locked") {
          await revokePublicTree(env, spaceFolder.id);
        }
        const updated = await updateFileMetadata(env, spaceFolder.id, {
          ...(newName ? { name: newName } : {}),
          appProperties: appPatch,
        });
        nextSession.owned[updated.id] = getOwnerTag(updated.appProperties);
        nextSession.unlocked[updated.id] = getLockTag(updated.appProperties);
        const sessionInfo = await mintSessionInfo(nextSession, env);
        return json(
          {
            ok: true,
            folder: toClientFile(updated, nextSession, updated) as ClientDriveFolder,
            space: toSpaceSummary(updated, nextSession),
            session: sessionInfo,
          },
          {},
          origin
        );
      } else {
        // Updating a subfolder inside the space
        if (visibility === "public") {
          appPatch.pd_lh = null;
          appPatch.pd_ls = null;
        } else {
          if (typeof body.password === "string" && body.password.length >= 8) {
            const sameAsOwner = await verifyPassword(body.password, spaceFolder.appProperties?.pd_os, spaceFolder.appProperties?.pd_oh);
            if (sameAsOwner) return err("INVALID_PAYLOAD", "Password penguncian harus berbeda dari password pemilik.", 400, origin);
            const subSalt = generateSalt();
            const subHash = await hashPassword(body.password, subSalt);
            appPatch.pd_lh = subHash;
            appPatch.pd_ls = subSalt;
          } else if (!targetFolder.appProperties?.pd_lh || !targetFolder.appProperties?.pd_ls) {
            return err("INVALID_PAYLOAD", "Password penguncian wajib diisi (minimal 8 karakter).", 400, origin);
          }
        }

        if (visibility === "locked") {
          await revokePublicTree(env, targetFolder.id);
        }
        const updated = await updateFileMetadata(env, targetFolder.id, {
          appProperties: appPatch,
        });
        return json(
          {
            ok: true,
            folder: toClientFile(updated, nextSession, spaceFolder) as ClientDriveFolder,
          },
          {},
          origin
        );
      }
    }

    // ── BROWSE FILES & FOLDERS ─────────────────────────────────────────────

    if (path === "/files" && request.method === "GET") {
      const spaceId = url.searchParams.get("spaceId");
      const folderParam = url.searchParams.get("folder");
      const targetId = folderParam || spaceId;
      if (!targetId) {
        return err("MISSING_QUERY_PARAM", "Parameter 'spaceId' wajib disertakan.", 400, origin);
      }

      const cache = new Map<string, DriveFile>();
      const { spaceFolder, chain } = await resolveChain(env, targetId, rootId, cache);
      if (spaceId && spaceFolder.id !== spaceId) {
        return err("FORBIDDEN", "Folder berada di luar ruang yang diminta.", 403, origin);
      }

      const role = assertReadAccess(session, spaceFolder, chain);
      const targetFolder = chain[chain.length - 1];
      if (targetFolder.mimeType !== "application/vnd.google-apps.folder") {
        return err("INVALID_PAYLOAD", "Target bukan folder.", 400, origin);
      }

      const items = await listChildren(env, targetFolder.id);
      const folders = items
        .filter((f) => f.mimeType === "application/vnd.google-apps.folder")
        .map((f) => toClientFile(f, session, spaceFolder) as ClientDriveFolder);
      const files = items
        .filter((f) => f.mimeType !== "application/vnd.google-apps.folder")
        .map((f) => toClientFile(f, session, spaceFolder));

      // Breadcrumb inside the space (excludes spaceFolder itself since the UI renders space name as root)
      const breadcrumb = chain.slice(1).map((node) => ({
        id: node.id,
        name: node.name,
        isLocked: isFolderLockedProp(node.appProperties),
      }));

      return json(
        {
          space: toSpaceSummary(spaceFolder, session),
          role,
          folder: folderParam ? (toClientFile(targetFolder, session, spaceFolder) as ClientDriveFolder) : null,
          files,
          folders,
          breadcrumb,
        },
        {},
        origin
      );
    }

    // POST /folders — create a subfolder inside a space (Owner only)
    if (path === "/folders" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        spaceId?: unknown;
        name?: unknown;
        parentId?: unknown;
        password?: unknown;
      } | null;
      if (!body || typeof body.spaceId !== "string" || !body.spaceId) {
        return err("INVALID_PAYLOAD", "spaceId wajib diisi.", 400, origin);
      }
      const name = validateFolderName(body.name);
      const targetParentId = typeof body.parentId === "string" && body.parentId ? body.parentId : body.spaceId;

      const { spaceFolder } = await resolveChain(env, targetParentId, rootId);
      if (spaceFolder.id !== body.spaceId) {
        return err("FORBIDDEN", "Parent folder berada di luar ruang aktif.", 403, origin);
      }
      assertOwnerAccess(session, spaceFolder);

      const rawPassword = typeof body.password === "string" ? body.password : "";
      if (rawPassword.length > 0 && rawPassword.length < 8) {
        return err("INVALID_PAYLOAD", "Password penguncian subfolder minimal 8 karakter.", 400, origin);
      }
      if (rawPassword.length > 0) {
        const sameAsOwner = await verifyPassword(rawPassword, spaceFolder.appProperties?.pd_os, spaceFolder.appProperties?.pd_oh);
        if (sameAsOwner) {
          return err("INVALID_PAYLOAD", "Password penguncian harus berbeda dari password pemilik.", 400, origin);
        }
      }
      let created: DriveFile;
      if (rawPassword.length > 0) {
        const existing = await listChildren(env, targetParentId);
        const dup = existing.find(
          (f) =>
            f.mimeType === "application/vnd.google-apps.folder" &&
            !f.trashed &&
            f.name.toLowerCase() === name.toLowerCase()
        );
        if (dup) {
          return err("NAME_TAKEN", `Subfolder "${name}" sudah ada di dalam folder ini.`, 409, origin);
        }
        const subSalt = generateSalt();
        const subHash = await hashPassword(rawPassword, subSalt);
        created = await createFolder(env, targetParentId, name, {
          pd_vis: "locked",
          pd_lh: subHash,
          pd_ls: subSalt,
          pd_cat: String(Math.floor(Date.now() / 1000)),
        });
      } else {
        // Idempotent ensureFolder when no password is provided (supports folder tree uploads cleanly!)
        created = await ensureFolder(env, targetParentId, name, {
          pd_vis: "public",
          pd_cat: String(Math.floor(Date.now() / 1000)),
        });
      }

      return json({ folder: toClientFile(created, session, spaceFolder) }, {}, origin);
    }

    // ── STORAGE ────────────────────────────────────────────────────────────

    if (path === "/storage" && request.method === "GET") {
      const info = await getStorageInfo(env);
      return json({ limit: info.limit, usage: info.usage, workspaceUsage: info.workspaceUsage }, {}, origin);
    }

    // ── MUTATIONS (Owner only) ─────────────────────────────────────────────

    const deleteMatch = /^\/files\/([^/]+)$/.exec(path);
    if (deleteMatch && request.method === "DELETE") {
      const fileId = decodeURIComponent(deleteMatch[1]);
      const { spaceFolder } = await resolveChain(env, fileId, rootId);
      if (fileId === spaceFolder.id) {
        return err("FORBIDDEN", "Gunakan menu Pengaturan Ruang untuk menghapus ruang utama.", 403, origin);
      }
      assertOwnerAccess(session, spaceFolder);
      await trashFile(env, fileId);
      return json({ ok: true }, {}, origin);
    }

    if (path === "/rename" && request.method === "PATCH") {
      const body = (await request.json().catch(() => null)) as {
        spaceId?: unknown;
        fileId?: unknown;
        name?: unknown;
      } | null;
      if (!body || typeof body.fileId !== "string" || typeof body.name !== "string" || !body.name.trim()) {
        return err("INVALID_PAYLOAD", "fileId dan name wajib diisi.", 400, origin);
      }
      const { spaceFolder } = await resolveChain(env, body.fileId, rootId);
      if (body.fileId === spaceFolder.id) {
        return err("FORBIDDEN", "Gunakan menu Pengaturan Ruang untuk mengubah nama ruang utama.", 403, origin);
      }
      assertOwnerAccess(session, spaceFolder);
      const updated = await renameFile(env, body.fileId, body.name.trim());
      return json({ file: toClientFile(updated, session, spaceFolder) }, {}, origin);
    }

    // ── TRASH (Owner only, strictly scoped to spaceId) ─────────────────────

    if (path === "/trash" && request.method === "GET") {
      const spaceId = url.searchParams.get("spaceId");
      if (!spaceId) return err("MISSING_QUERY_PARAM", "Parameter 'spaceId' wajib disertakan.", 400, origin);
      const cache = new Map<string, DriveFile>();
      const { spaceFolder } = await resolveChain(env, spaceId, rootId, cache);
      assertOwnerAccess(session, spaceFolder);

      const allTrashed = await listTrashed(env);
      const scoped: DriveFile[] = [];
      const limit = Math.min(allTrashed.length, MAX_BATCH * 3);
      for (let i = 0; i < limit; i++) {
        const item = allTrashed[i];
        if (item.id === spaceFolder.id) continue;
        try {
          const resolved = await resolveChain(env, item.id, rootId, cache);
          if (resolved.spaceFolder.id !== spaceFolder.id) continue;
        } catch {
          continue;
        }
        const parentId = item.parents?.[0];
        if (parentId && parentId !== spaceFolder.id) {
          let parent = cache.get(parentId);
          if (!parent) {
            try {
              parent = await getFile(env, parentId);
              cache.set(parentId, parent);
            } catch {
              parent = undefined;
            }
          }
          if (parent && parent.trashed) continue;
        }
        scoped.push(item);
      }
      const folders = scoped
        .filter((f) => f.mimeType === "application/vnd.google-apps.folder")
        .map((f) => toClientFile(f, session, spaceFolder) as ClientDriveFolder);
      const files = scoped
        .filter((f) => f.mimeType !== "application/vnd.google-apps.folder")
        .map((f) => toClientFile(f, session, spaceFolder));
      return json({ files, folders, breadcrumb: [], hasMore: allTrashed.length > limit }, {}, origin);
    }

    if (path === "/trash" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { spaceId?: unknown; fileIds?: unknown } | null;
      if (!body || typeof body.spaceId !== "string" || !body.spaceId) {
        return err("INVALID_PAYLOAD", "spaceId wajib diisi.", 400, origin);
      }
      const fileIds = validateBatchIds(body);
      const cache = new Map<string, DriveFile>();
      const { spaceFolder } = await resolveChain(env, body.spaceId, rootId, cache);
      assertOwnerAccess(session, spaceFolder);

      let trashed = 0;
      const failed: string[] = [];
      for (const fileId of fileIds) {
        if (fileId === spaceFolder.id) {
          failed.push(fileId);
          continue;
        }
        try {
          const resolved = await resolveChain(env, fileId, rootId, cache);
          if (resolved.spaceFolder.id !== spaceFolder.id) {
            failed.push(fileId);
            continue;
          }
          await trashFile(env, fileId);
          trashed += 1;
        } catch {
          failed.push(fileId);
        }
      }
      return json({ ok: true, trashed, failed }, {}, origin);
    }

    if (path === "/trash/restore" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { spaceId?: unknown; fileIds?: unknown } | null;
      if (!body || typeof body.spaceId !== "string" || !body.spaceId) {
        return err("INVALID_PAYLOAD", "spaceId wajib diisi.", 400, origin);
      }
      const fileIds = validateBatchIds(body);
      const cache = new Map<string, DriveFile>();
      const { spaceFolder } = await resolveChain(env, body.spaceId, rootId, cache);
      assertOwnerAccess(session, spaceFolder);

      const folderIds: string[] = [];
      const nonFolderIds: string[] = [];
      for (const fileId of fileIds) {
        try {
          const resolved = await resolveChain(env, fileId, rootId, cache);
          if (resolved.spaceFolder.id !== spaceFolder.id || fileId === spaceFolder.id) {
            continue;
          }
          const file = resolved.chain[resolved.chain.length - 1];
          if (file.mimeType === "application/vnd.google-apps.folder") folderIds.push(fileId);
          else nonFolderIds.push(fileId);
        } catch {
          // Handled below
        }
      }

      let restored = 0;
      const failed: string[] = [];
      const validSet = new Set([...folderIds, ...nonFolderIds]);
      for (const id of fileIds) {
        if (!validSet.has(id)) failed.push(id);
      }

      for (const fileId of folderIds) {
        try {
          const file = await getFile(env, fileId);
          if (!file.trashed) {
            restored += 1;
            continue;
          }
          await restoreFile(env, fileId);
          restored += 1;
        } catch {
          failed.push(fileId);
        }
      }
      for (const fileId of nonFolderIds) {
        try {
          const file = await getFile(env, fileId);
          if (!file.trashed) {
            restored += 1;
            continue;
          }
          await restoreFile(env, fileId);
          restored += 1;
        } catch {
          failed.push(fileId);
        }
      }
      return json({ ok: true, restored, failed }, {}, origin);
    }

    if (path === "/trash" && request.method === "DELETE") {
      const body = (await request.json().catch(() => null)) as { spaceId?: unknown; fileIds?: unknown } | null;
      if (!body || typeof body.spaceId !== "string" || !body.spaceId) {
        return err("INVALID_PAYLOAD", "spaceId wajib diisi.", 400, origin);
      }
      const fileIds = validateBatchIds(body);
      const cache = new Map<string, DriveFile>();
      const { spaceFolder } = await resolveChain(env, body.spaceId, rootId, cache);
      assertOwnerAccess(session, spaceFolder);

      let deleted = 0;
      const failed: string[] = [];
      const folderIds: string[] = [];
      const nonFolderIds: string[] = [];

      for (const fileId of fileIds) {
        try {
          const resolved = await resolveChain(env, fileId, rootId, cache);
          if (resolved.spaceFolder.id !== spaceFolder.id || fileId === spaceFolder.id) {
            failed.push(fileId);
            continue;
          }
          const file = resolved.chain[resolved.chain.length - 1];
          if (!file.trashed) {
            failed.push(fileId);
            continue;
          }
          if (file.mimeType === "application/vnd.google-apps.folder") folderIds.push(fileId);
          else nonFolderIds.push(fileId);
        } catch {
          failed.push(fileId);
        }
      }

      for (const fileId of folderIds) {
        try {
          await deleteFile(env, fileId);
          deleted += 1;
        } catch {
          failed.push(fileId);
        }
      }
      for (const fileId of nonFolderIds) {
        try {
          await deleteFile(env, fileId);
          deleted += 1;
        } catch (e) {
          if (e instanceof HttpError && e.status === 404) deleted += 1;
          else failed.push(fileId);
        }
      }
      return json({ ok: true, deleted, failed }, {}, origin);
    }

    if (path === "/trash/search" && request.method === "GET") {
      const spaceId = url.searchParams.get("spaceId");
      if (!spaceId) return err("MISSING_QUERY_PARAM", "Parameter 'spaceId' wajib disertakan.", 400, origin);
      const query = (url.searchParams.get("q") ?? "").trim();
      const cache = new Map<string, DriveFile>();
      const { spaceFolder } = await resolveChain(env, spaceId, rootId, cache);
      assertOwnerAccess(session, spaceFolder);
      if (!query) return json({ files: [], folders: [] }, {}, origin);

      const results = await searchTrashed(env, query);
      const files: Array<ClientDriveFile & { path: string | null }> = [];
      const folders: Array<ClientDriveFile & { path: string | null }> = [];
      const limit = Math.min(results.length, MAX_BATCH * 3);

      for (let i = 0; i < limit; i++) {
        const item = results[i];
        if (item.id === spaceFolder.id) continue;
        try {
          const resolved = await resolveChain(env, item.id, rootId, cache);
          if (resolved.spaceFolder.id !== spaceFolder.id) continue;
          const relSegments = resolved.chain.slice(1, -1).map((n) => n.name);
          const relPath = relSegments.length > 0 ? relSegments.join("/") : null;
          const entry = { ...toClientFile(item, session, spaceFolder), path: relPath };
          if (item.mimeType === "application/vnd.google-apps.folder") folders.push(entry);
          else files.push(entry);
        } catch {
          continue;
        }
      }
      return json({ files, folders }, {}, origin);
    }

    // ── UPLOAD HELPERS (Owner only) ────────────────────────────────────────

    if (path === "/upload/start" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        spaceId?: unknown;
        filename?: unknown;
        mimeType?: unknown;
        size?: unknown;
        parentId?: unknown;
      } | null;
      if (
        !body ||
        typeof body.spaceId !== "string" ||
        !body.spaceId ||
        typeof body.filename !== "string" ||
        typeof body.mimeType !== "string" ||
        typeof body.size !== "number"
      ) {
        return err("INVALID_PAYLOAD", "spaceId, filename, mimeType, dan size wajib diisi.", 400, origin);
      }

      const targetParentId = typeof body.parentId === "string" && body.parentId ? body.parentId : body.spaceId;
      const { spaceFolder } = await resolveChain(env, targetParentId, rootId);
      if (spaceFolder.id !== body.spaceId) {
        return err("FORBIDDEN", "Folder tujuan berada di luar ruang aktif.", 403, origin);
      }
      assertOwnerAccess(session, spaceFolder);

      const result = await startResumableUpload(env, {
        filename: body.filename,
        mimeType: body.mimeType,
        size: body.size,
        parentId: targetParentId,
      });
      return json(result, {}, origin);
    }

    if (path === "/upload/chunk" && request.method === "POST") {
      if (Object.keys(session.owned).length === 0) {
        return err("FORBIDDEN", "Hanya pemilik folder yang dapat mengupload file.", 403, origin);
      }
      const headers = request.headers;
      const start = Number(headers.get("x-upload-start"));
      const end = Number(headers.get("x-upload-end"));
      const total = Number(headers.get("x-upload-total"));
      const sessionUri = headers.get("x-session-uri") || "";
      const mimeType = headers.get("content-type") || "application/octet-stream";
      if (!sessionUri || !Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(total)) {
        return err("INVALID_PAYLOAD", "Header upload chunk tidak lengkap.", 400, origin);
      }
      const body = await request.arrayBuffer();
      const result = await forwardChunk(env, { sessionUri, start, end, total, mimeType, body });
      return json(result, {}, origin);
    }

    if (path === "/upload/finish" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { fileId?: unknown } | null;
      if (!body || typeof body.fileId !== "string" || !body.fileId) {
        return err("INVALID_PAYLOAD", "fileId wajib diisi.", 400, origin);
      }
      const { spaceFolder, chain } = await resolveChain(env, body.fileId, rootId);
      assertOwnerAccess(session, spaceFolder);
      const file = chain[chain.length - 1];
      return json({ ok: true, file: toClientFile(file, session, spaceFolder) }, {}, origin);
    }

    // ── PREVIEW & MEDIA (Owner + Authorized Read-Only Visitors) ────────────

    if (path === "/preview" && request.method === "GET") {
      const fileId = url.searchParams.get("id");
      if (!fileId) return err("MISSING_QUERY_PARAM", "Parameter 'id' wajib disertakan.", 400, origin);
      const { spaceFolder, chain } = await resolveChain(env, fileId, rootId);
      const role = assertReadAccess(session, spaceFolder, chain);
      const file = chain[chain.length - 1];

      const thumbnailUrl =
        file.thumbnailLink && typeof file.thumbnailLink === "string"
          ? file.thumbnailLink.startsWith("data:")
            ? file.thumbnailLink
            : file.thumbnailLink.replace(/=s\d+/, "=s1024")
          : null;
      const contentUrl = `/media?id=${encodeURIComponent(fileId)}`;
      return json(
        {
          id: file.id,
          spaceId: spaceFolder.id,
          role,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size ? Number(file.size) : null,
          thumbnailUrl,
          contentUrl,
          webViewLink: null,
          trashed: file.trashed,
        },
        {},
        origin
      );
    }

    if (path === "/media" && request.method === "GET") {
      const fileId = url.searchParams.get("id");
      if (!fileId) return err("MISSING_QUERY_PARAM", "Parameter 'id' wajib disertakan.", 400, origin);
      const { spaceFolder, chain } = await resolveChain(env, fileId, rootId);
      assertReadAccess(session, spaceFolder, chain);
      const file = chain[chain.length - 1];

      const range = request.headers.get("range");
      const media = await fetchMedia(env, fileId, range);
      const headers = new Headers(CORS_HEADERS(origin));
      headers.set("Content-Type", file.mimeType);
      for (const name of ["content-range", "accept-ranges", "content-length", "etag", "last-modified"]) {
        const value = media.headers.get(name);
        if (value) headers.set(name, value);
      }
      return new Response(media.body, { status: media.status, headers });
    }

    // ── SEARCH (Scoped to spaceId; respects subfolder locks!) ──────────────

    if (path === "/search" && request.method === "GET") {
      const spaceId = url.searchParams.get("spaceId");
      if (!spaceId) return err("MISSING_QUERY_PARAM", "Parameter 'spaceId' wajib disertakan.", 400, origin);
      const query = (url.searchParams.get("q") ?? "").trim();
      const cache = new Map<string, DriveFile>();
      const { spaceFolder, chain: spaceChain } = await resolveChain(env, spaceId, rootId, cache);
      assertReadAccess(session, spaceFolder, spaceChain);

      if (!query) return json({ files: [], folders: [] }, {}, origin);
      const results = await searchDrive(env, query);
      const owner = isOwnerOfSpace(session, spaceFolder);

      const files: Array<ClientDriveFile & { path: string | null }> = [];
      const folders: Array<ClientDriveFile & { path: string | null }> = [];

      for (const item of results) {
        if (item.id === spaceFolder.id) continue;
        try {
          const resolved = await resolveChain(env, item.id, rootId, cache);
          if (resolved.spaceFolder.id !== spaceFolder.id) continue;

          // Check all ancestor folders (excluding item itself so a locked folder can still show up as locked if its parent is accessible)
          const ancestors = resolved.chain.slice(0, -1);
          if (!owner) {
            const blocked = ancestors.some((anc) => !isFolderUnlocked(session, spaceFolder, anc));
            if (blocked) continue;
          }

          const relSegments = resolved.chain.slice(1, -1).map((n) => n.name);
          const relPath = relSegments.length > 0 ? relSegments.join("/") : null;
          const entry = { ...toClientFile(item, session, spaceFolder), path: relPath };
          if (item.mimeType === "application/vnd.google-apps.folder") folders.push(entry);
          else files.push(entry);
        } catch {
          continue;
        }
      }
      return json({ files, folders }, {}, origin);
    }

    // ── SHARE (Owner only) ─────────────────────────────────────────────────

    if (path === "/share" && request.method === "GET") {
      const fileId = url.searchParams.get("id");
      if (!fileId) return err("MISSING_QUERY_PARAM", "Parameter 'id' wajib disertakan.", 400, origin);
      const { spaceFolder, chain } = await resolveChain(env, fileId, rootId);
      assertOwnerAccess(session, spaceFolder);
      const file = chain[chain.length - 1];
      if (file.trashed) return err("ITEM_IN_TRASH", "Tidak dapat membagikan item di Sampah.", 400, origin);
      const permissions = await listPermissions(env, fileId);
      const publicPerm = permissions.find((p) => p.type === "anyone" && p.role === "reader");
      return json({ public: Boolean(publicPerm), role: publicPerm?.role ?? null, webViewLink: file.webViewLink ?? null }, {}, origin);
    }

    if (path === "/share" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { fileId?: unknown } | null;
      if (!body || typeof body.fileId !== "string" || !body.fileId.trim()) {
        return err("INVALID_PAYLOAD", "fileId wajib diisi.", 400, origin);
      }
      const { spaceFolder, chain } = await resolveChain(env, body.fileId, rootId);
      assertOwnerAccess(session, spaceFolder);
      const file = chain[chain.length - 1];
      if (file.trashed) return err("ITEM_IN_TRASH", "Tidak dapat membagikan item di Sampah.", 400, origin);
      return err("FORBIDDEN", "Berbagi langsung melalui Google Drive dinonaktifkan agar penguncian PersonalDrive tidak bisa dilewati. Ubah folder menjadi Publik untuk membagikan isinya.", 403, origin);
    }

    // ── MOVE (Owner only, within same space) ───────────────────────────────

    if (path === "/move" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        spaceId?: unknown;
        fileIds?: unknown;
        parentId?: unknown;
      } | null;
      if (!body || typeof body.spaceId !== "string" || !body.spaceId) {
        return err("INVALID_PAYLOAD", "spaceId wajib diisi.", 400, origin);
      }
      const fileIds = validateBatchIds(body);
      const destId = typeof body.parentId === "string" && body.parentId ? body.parentId : body.spaceId;

      const cache = new Map<string, DriveFile>();
      const { spaceFolder } = await resolveChain(env, destId, rootId, cache);
      if (spaceFolder.id !== body.spaceId) {
        return err("FORBIDDEN", "Folder tujuan berada di luar ruang aktif.", 403, origin);
      }
      assertOwnerAccess(session, spaceFolder);

      const destFile = cache.get(destId) ?? (await getFile(env, destId));
      if (destFile.mimeType !== "application/vnd.google-apps.folder") {
        return err("INVALID_PAYLOAD", "Tujuan pemindahan harus berupa folder.", 400, origin);
      }

      let moved = 0;
      const failed: string[] = [];
      for (const fileId of fileIds) {
        if (fileId === spaceFolder.id || fileId === destId) {
          failed.push(fileId);
          continue;
        }
        try {
          const resolved = await resolveChain(env, fileId, rootId, cache);
          if (resolved.spaceFolder.id !== spaceFolder.id) {
            failed.push(fileId);
            continue;
          }
          await moveFile(env, fileId, destId);
          moved += 1;
        } catch {
          failed.push(fileId);
        }
      }
      return json({ ok: true, moved, failed }, {}, origin);
    }

    // ── DOWNLOAD (Owner + Authorized Read-Only Visitors) ───────────────────

    if (path === "/download" && request.method === "GET") {
      const fileId = url.searchParams.get("id");
      if (!fileId) return err("MISSING_QUERY_PARAM", "Parameter 'id' wajib disertakan.", 400, origin);
      const { spaceFolder, chain } = await resolveChain(env, fileId, rootId);
      assertReadAccess(session, spaceFolder, chain);
      const file = chain[chain.length - 1];

      const media = await fetchMedia(env, fileId);
      const headers = new Headers(CORS_HEADERS(origin));
      headers.set("Content-Type", file.mimeType);
      headers.set("Content-Disposition", `attachment; filename="${sanitizeFilename(file.name)}"`);
      const length = media.headers.get("content-length");
      if (length) headers.set("Content-Length", length);
      return new Response(media.body, { status: media.status, headers });
    }

    if (path === "/download/folder" && request.method === "GET") {
      const folderId = url.searchParams.get("id");
      if (!folderId) return err("MISSING_QUERY_PARAM", "Parameter 'id' wajib disertakan.", 400, origin);
      const { spaceFolder, chain } = await resolveChain(env, folderId, rootId);
      assertReadAccess(session, spaceFolder, chain);
      const folder = chain[chain.length - 1];

      const subtree = await collectSubtree(env, folderId, folder.name, (childFolder) =>
        isFolderUnlocked(session, spaceFolder, childFolder)
      );
      const entries = [{ path: `${folder.name}/`, data: new Uint8Array(0) }, ...subtree];
      const zip = buildZip(entries);
      const zipBuf = new ArrayBuffer(zip.byteLength);
      new Uint8Array(zipBuf).set(zip);
      const headers = new Headers(CORS_HEADERS(origin));
      headers.set("Content-Type", "application/zip");
      headers.set("Content-Disposition", `attachment; filename="${sanitizeFilename(folder.name)}.zip"`);
      headers.set("Content-Length", String(zip.byteLength));
      return new Response(zipBuf, { status: 200, headers });
    }

    return err("NOT_FOUND", `Unknown route: ${request.method} ${path}`, 404, origin);
  } catch (e) {
    if (e instanceof HttpError) {
      return err(e.code, e.message, e.status, origin, e.extra);
    }
    const message = e instanceof Error ? e.message : "Unknown error";
    return err("INTERNAL_ERROR", message, 500, origin);
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/["\r\n]/g, "_").replace(/\\/g, "_");
}
