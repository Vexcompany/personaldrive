/**
 * Shared types between the Next.js app, the Cloudflare Worker, and the
 * upload engine. Anything in here MUST be safe to import in all three
 * runtimes (browser, edge worker, node tests).
 */

export type FolderVisibility = "public" | "locked";
export type AccessRole = "owner" | "viewer";

/**
 * Summary of a person's top-level personal folder ("space") displayed
 * on the home directory.
 */
export interface SpaceSummary {
  id: string;
  name: string;
  visibility: FolderVisibility;
  /** True when visitors need a password to open this space. */
  isLocked: boolean;
  /** True when the current client holds a valid owner session for this space. */
  isOwner: boolean;
  /** True when the current client can immediately open this space (public, owner, or already unlocked). */
  isUnlocked: boolean;
  /** True when a dedicated visitor password is set (separate from owner password). */
  hasVisitorPassword?: boolean;
  modifiedTime: string | null;
  createdTime: string | null;
}

export interface ListSpacesResponse {
  spaces: SpaceSummary[];
}

export interface CreateSpaceRequest {
  /** Person / folder name (e.g. "Vex"). */
  name: string;
  /** Owner password used to upload, edit, delete, and manage security from any device. */
  ownerPassword: string;
  /** Whether visitors can open this space without a password ("public") or need a password ("locked"). */
  visibility: FolderVisibility;
  /** Required, separate read-only unlock password when visibility is locked. */
  visitorPassword?: string;
}

export interface SessionInfo {
  /** Signed multi-space JWT stored by the client. */
  token: string;
  /** IDs of spaces where this client currently has Owner access. */
  ownedSpaceIds: string[];
  /** IDs of locked folders/spaces this client has unlocked as Viewer. */
  unlockedFolderIds: string[];
  /** Unix epoch seconds. */
  issuedAt: number;
}

export interface CreateSpaceResponse {
  space: SpaceSummary;
  session: SessionInfo;
}

export interface UnlockRequest {
  /** Root space id. */
  spaceId: string;
  /** Specific folder id to unlock (defaults to spaceId when unlocking a root space). */
  folderId?: string;
  /** Password entered by the user. */
  password: string;
  /** When true, specifically verifies ownerPassword to grant Owner ("edit") access. */
  asOwner?: boolean;
}

export interface UnlockResponse {
  session: SessionInfo;
  role: AccessRole;
  space: SpaceSummary;
}

export interface LogoutSpaceRequest {
  /** Space id to drop owner/unlocked privileges from (omit to clear all). */
  spaceId?: string;
}

export interface LogoutSpaceResponse {
  session: SessionInfo;
}

export interface UpdateFolderSecurityRequest {
  /** Target folder id (can be a root space id or any subfolder id inside the space). */
  folderId: string;
  /** Space id that owns this folder. */
  spaceId: string;
  /** New visibility ("public" = no password to view; "locked" = password required). */
  visibility: FolderVisibility;
  /**
   * For subfolders: required when setting visibility="locked" (unless keeping existing password).
   * For root spaces: optional separate read-only visitor password (pass "" to clear separate visitor password so owner password unlocks).
   */
  password?: string;
  /** Optional: change the root space's owner password (requires currentOwnerPassword). */
  newOwnerPassword?: string;
  currentOwnerPassword?: string;
  /** Optional: rename the root space at the same time. */
  name?: string;
}

export interface UpdateFolderSecurityResponse {
  ok: true;
  folder: DriveFolder;
  space?: SpaceSummary;
  session?: SessionInfo;
}

export interface DeleteSpaceRequest {
  ownerPassword: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  /** Drive parents (folder ids). */
  parents: string[];
  /** WebView / thumbnail link from Drive. */
  thumbnailLink: string | null;
  webViewLink: string | null;
  modifiedTime: string | null;
  /** Whether the item is in the trash. */
  trashed: boolean;
  /** For folders: visibility ("public" | "locked"). */
  visibility?: FolderVisibility;
  /** For folders: true when protected by a password. */
  isLocked?: boolean;
  /** For folders: true when accessible to the current requester without entering another password. */
  isUnlocked?: boolean;
}

export interface DriveFolder extends DriveFile {
  mimeType: "application/vnd.google-apps.folder";
}

export interface ListFilesResponse {
  space: SpaceSummary;
  role: AccessRole;
  folder: DriveFolder | null;
  files: DriveFile[];
  folders: DriveFolder[];
  /** Resolved path segments inside the space (excludes GOOGLE_DRIVE_ROOT and space root). */
  breadcrumb: { id: string; name: string; isLocked?: boolean }[];
  /** Statistics for the current folder (file count, folder count, total size). */
  stats?: FolderStats;
}

/** Statistics for a folder's direct children. */
export interface FolderStats {
  fileCount: number;
  folderCount: number;
  totalSize: number;
}

export interface StartUploadRequest {
  /** Space id where the upload takes place. */
  spaceId: string;
  /** Original filename as it should appear in Drive. */
  filename: string;
  mimeType: string;
  /** Total file size in bytes. */
  size: number;
  /** Drive folder id to upload into (null = space root). */
  parentId: string | null;
}

export interface StartUploadResponse {
  /** The Google Drive resumable session URI to PUT chunks to. */
  sessionUri: string;
  /** Total size echoed back so the client can sanity-check. */
  totalBytes: number;
}

export interface FinishUploadRequest {
  spaceId: string;
  sessionUri: string;
  size: number;
  parentId: string | null;
  filename: string;
  mimeType: string;
}

export interface FinishUploadResponse {
  driveFileId: string;
  name: string;
  size: number;
}

export interface CreateFolderRequest {
  spaceId: string;
  name: string;
  parentId: string | null;
  /** Optional subfolder lock password. Empty or omitted = public subfolder. */
  password?: string;
}

export interface RenameRequest {
  spaceId: string;
  fileId: string;
  name: string;
}

export interface PreviewResponse {
  id: string;
  spaceId: string;
  role: AccessRole;
  name: string;
  mimeType: string;
  size: number | null;
  /** A short-lived, signed Google thumbnail URL (or `null` if not available). */
  thumbnailUrl: string | null;
  /** Worker-proxied content URL (GET /media?id=…). */
  contentUrl: string | null;
  webViewLink: string | null;
  trashed: boolean;
}

export interface ShareRequest {
  spaceId: string;
  fileId: string;
}

export interface ShareResponse {
  webViewLink: string;
}

export interface ShareStatusResponse {
  public: boolean;
  role: string | null;
  webViewLink: string | null;
}

export interface SearchItem extends DriveFile {
  /** Resolved path from the space root, e.g. "A/B" (null when directly under space root). */
  path: string | null;
}

export interface SearchResponse {
  files: SearchItem[];
  folders: SearchItem[];
}

export interface MoveRequest {
  spaceId: string;
  fileIds: string[];
  /** Destination folder id (null = space root). */
  parentId: string | null;
}

export interface MoveResponse {
  ok: boolean;
  moved: number;
  failed: string[];
}

// ── Trash ──────────────────────────────────────────────────────────────────

export interface TrashRequest {
  spaceId: string;
  fileIds: string[];
}

export interface TrashResponse {
  ok: boolean;
  trashed: number;
  failed: string[];
}

export interface TrashRestoreRequest {
  spaceId: string;
  fileIds: string[];
}

export interface TrashRestoreResponse {
  ok: boolean;
  restored: number;
  failed: string[];
}

export interface TrashDeleteForeverRequest {
  spaceId: string;
  fileIds: string[];
}

export interface TrashDeleteForeverResponse {
  ok: boolean;
  deleted: number;
  failed: string[];
}

export interface TrashListResponse {
  files: DriveFile[];
  folders: DriveFolder[];
  breadcrumb: { id: string; name: string }[];
  hasMore?: boolean;
}

export interface TrashSearchResponse {
  files: SearchItem[];
  folders: SearchItem[];
}

/** Storage quota from the Drive about endpoint. */
export interface StorageResponse {
  limit: number;
  usage: number;
  workspaceUsage: number;
}

export interface ApiErrorResponse {
  success: false;
  code: ApiErrorCode;
  message: string;
  status: number;
  /** Populated when code === "FOLDER_LOCKED" so the UI can prompt for that exact folder's password. */
  lockedFolderId?: string;
  lockedFolderName?: string;
  spaceId?: string;
}

export type ApiErrorCode =
  | "INVALID_LOGIN_PAYLOAD"
  | "INVALID_CREDENTIALS"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "FOLDER_LOCKED"
  | "NAME_TAKEN"
  | "INVALID_PAYLOAD"
  | "MISSING_QUERY_PARAM"
  | "DRIVE_ERROR"
  | "INTERNAL_ERROR"
  | "NOT_FOUND"
  | "MISSING_CONFIG"
  | "CONFIG_ERROR"
  | "ITEM_IN_TRASH";
