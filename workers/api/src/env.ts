/**
 * Cloudflare Worker bindings + secrets.
 *
 * Secrets are set with `wrangler secret put NAME` and arrive via the
 * `env` argument to the fetch handler.
 */
export interface Env {
  /** Google OAuth credentials (server-side only, never exposed to browser). */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  /** Root Google Drive folder ID containing each person's folder (space). */
  GOOGLE_DRIVE_ROOT: string;
  /** HS256 JWT signing secret. */
  JWT_SECRET: string;
  /** Allowed CORS origin (defaults to "*"). */
  CORS_ORIGIN?: string;
  /**
   * Optional local/preview mode ("true") that backs Drive calls with an
   * in-memory store when Google OAuth credentials are not configured yet.
   */
  MOCK_DRIVE?: string;
}
