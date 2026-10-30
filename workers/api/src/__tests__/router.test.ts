import { describe, it, expect, beforeEach } from "vitest";
import { signJwt, verifyJwt } from "../jwt";
import { handle } from "../router";
import { resetMockDrive } from "../mock-drive";
import type { Env } from "../env";

const SECRET = "test-secret-do-not-use-in-prod";

const ENV: Env = {
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
  GOOGLE_REFRESH_TOKEN: "",
  GOOGLE_DRIVE_ROOT: "root_folder_id",
  JWT_SECRET: SECRET,
  MOCK_DRIVE: "true",
};

function req(
  path: string,
  init: RequestInit & { token?: string; jsonBody?: unknown } = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  let body = init.body;
  if (init.jsonBody !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.jsonBody);
  }
  return handle(new Request(`https://api.test${path}`, { ...init, headers, body }), ENV);
}

async function uploadMockFile(
  token: string,
  spaceId: string,
  parentId: string | null,
  filename: string,
  content: string,
  mimeType = "text/plain"
): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const startRes = await req("/upload/start", {
    method: "POST",
    token,
    jsonBody: { spaceId, parentId, filename, mimeType, size: bytes.byteLength },
  });
  expect(startRes.status).toBe(200);
  const { sessionUri } = (await startRes.json()) as { sessionUri: string };

  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const chunkRes = await req("/upload/chunk", {
    method: "POST",
    token,
    headers: {
      "Content-Type": mimeType,
      "X-Session-Uri": sessionUri,
      "X-Upload-Start": "0",
      "X-Upload-End": String(bytes.byteLength),
      "X-Upload-Total": String(bytes.byteLength),
    },
    body: buf,
  });
  expect(chunkRes.status).toBe(200);
  const finished = (await chunkRes.json()) as { driveFileId: string; finished: boolean };
  expect(finished.finished).toBe(true);
  return finished.driveFileId;
}

describe("jwt", () => {
  it("round-trips multi-space owned and unlocked claims", async () => {
    const tok = await signJwt({ owned: { sp1: "tag1" }, unlocked: { fld1: "ltag1" } }, SECRET, 60);
    const decoded = await verifyJwt(tok, SECRET);
    expect(decoded?.owned).toEqual({ sp1: "tag1" });
    expect(decoded?.unlocked).toEqual({ fld1: "ltag1" });
  });

  it("rejects tampered and expired tokens", async () => {
    const tok = await signJwt({ owned: { sp1: "tag1" } }, SECRET, 60);
    expect(await verifyJwt(tok.slice(0, -3) + "AAA", SECRET)).toBeNull();
    const expired = await signJwt({ owned: { sp1: "tag1" } }, SECRET, -1);
    expect(await verifyJwt(expired, SECRET)).toBeNull();
  });
});

describe("Personal Drive API router", () => {
  beforeEach(() => {
    resetMockDrive();
  });

  it("creates public and locked personal spaces and prevents duplicate names", async () => {
    const vexRes = await req("/spaces", {
      method: "POST",
      jsonBody: { name: "Vex", ownerPassword: "vex-owner-pw", visibility: "public" },
    });
    expect(vexRes.status).toBe(201);
    const vexData = (await vexRes.json()) as { space: { id: string; isLocked: boolean; isOwner: boolean }; session: { token: string } };
    expect(vexData.space.isLocked).toBe(false);
    expect(vexData.space.isOwner).toBe(true);
    expect(vexData.session.token).toBeTruthy();

    // Case-insensitive duplicate check
    const dupRes = await req("/spaces", {
      method: "POST",
      jsonBody: { name: "vex", ownerPassword: "other", visibility: "locked" },
    });
    expect(dupRes.status).toBe(409);

    // Create a locked space
    const lockedRes = await req("/spaces", {
      method: "POST",
      jsonBody: { name: "RahasiaBudi", ownerPassword: "budi-secret", visibility: "locked" },
    });
    expect(lockedRes.status).toBe(201);

    // Anonymous visitor lists spaces
    const listRes = await req("/spaces");
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as { spaces: Array<{ name: string; isLocked: boolean; isUnlocked: boolean; isOwner: boolean }> };
    expect(listData.spaces).toHaveLength(2);
    const budi = listData.spaces.find((s) => s.name === "RahasiaBudi")!;
    const vex = listData.spaces.find((s) => s.name === "Vex")!;
    expect(budi.isLocked).toBe(true);
    expect(budi.isUnlocked).toBe(false);
    expect(budi.isOwner).toBe(false);
    expect(vex.isLocked).toBe(false);
    expect(vex.isUnlocked).toBe(true);
    expect(vex.isOwner).toBe(false);
  });

  it("enforces Read-Only on public spaces for visitors while allowing Owner full control", async () => {
    const createRes = await req("/spaces", {
      method: "POST",
      jsonBody: { name: "Vex", ownerPassword: "owner123", visibility: "public" },
    });
    const { space, session } = (await createRes.json()) as { space: { id: string }; session: { token: string } };
    const ownerToken = session.token;

    // Owner uploads a file
    const fileId = await uploadMockFile(ownerToken, space.id, null, "halo.txt", "Halo Dunia!");

    // Anonymous visitor CAN browse, preview, and download
    const browseRes = await req(`/files?spaceId=${space.id}`);
    expect(browseRes.status).toBe(200);
    const browseData = (await browseRes.json()) as { role: string; files: Array<{ id: string; name: string }> };
    expect(browseData.role).toBe("viewer");
    expect(browseData.files).toHaveLength(1);

    const dlRes = await req(`/download?id=${fileId}`);
    expect(dlRes.status).toBe(200);
    expect(await dlRes.text()).toBe("Halo Dunia!");

    // Anonymous visitor CANNOT upload, create folder, rename, or delete
    const visitorFolder = await req("/folders", {
      method: "POST",
      jsonBody: { spaceId: space.id, name: "Hacked", parentId: null },
    });
    expect(visitorFolder.status).toBe(403);

    const visitorUpload = await req("/upload/start", {
      method: "POST",
      jsonBody: { spaceId: space.id, filename: "evil.txt", mimeType: "text/plain", size: 5, parentId: null },
    });
    expect(visitorUpload.status).toBe(403);

    const visitorRename = await req("/rename", {
      method: "PATCH",
      jsonBody: { spaceId: space.id, fileId, name: "hacked.txt" },
    });
    expect(visitorRename.status).toBe(403);

    const visitorDelete = await req(`/files/${fileId}`, { method: "DELETE" });
    expect(visitorDelete.status).toBe(403);

    // Owner logging in from another device gets Owner role
    const loginRes = await req("/auth/unlock", {
      method: "POST",
      jsonBody: { spaceId: space.id, password: "owner123", asOwner: true },
    });
    expect(loginRes.status).toBe(200);
    const loginData = (await loginRes.json()) as { role: string; session: { token: string } };
    expect(loginData.role).toBe("owner");
  });

  it("blocks locked spaces and locked subfolders until unlocked, and prevents search/ZIP leaks", async () => {
    // Create public space "Vex"
    const createRes = await req("/spaces", {
      method: "POST",
      jsonBody: { name: "Vex", ownerPassword: "vex-master", visibility: "public" },
    });
    const { space, session } = (await createRes.json()) as { space: { id: string }; session: { token: string } };
    const ownerToken = session.token;

    // Upload public file at root
    await uploadMockFile(ownerToken, space.id, null, "publik-catatan.txt", "Isi publik");

    // Create password-locked subfolder inside public space "Vex"
    const subRes = await req("/folders", {
      method: "POST",
      token: ownerToken,
      jsonBody: { spaceId: space.id, name: "Arsip Pribadi", parentId: null, password: "sub-secret" },
    });
    expect(subRes.status).toBe(200);
    const { folder: lockedSub } = (await subRes.json()) as { folder: { id: string; isLocked: boolean } };
    expect(lockedSub.isLocked).toBe(true);

    // Upload secret file inside locked subfolder
    const secretFileId = await uploadMockFile(ownerToken, space.id, lockedSub.id, "rahasia-catatan.txt", "Sangat rahasia");

    // Visitor sees subfolder as locked, cannot enter it
    const subBrowse = await req(`/files?spaceId=${space.id}&folder=${lockedSub.id}`);
    expect(subBrowse.status).toBe(403);
    const subErr = (await subBrowse.json()) as { code: string; lockedFolderId: string };
    expect(subErr.code).toBe("FOLDER_LOCKED");
    expect(subErr.lockedFolderId).toBe(lockedSub.id);

    // Visitor cannot bypass via direct file download or media
    expect((await req(`/download?id=${secretFileId}`)).status).toBe(403);
    expect((await req(`/media?id=${secretFileId}`)).status).toBe(403);

    // Visitor search does NOT leak secret file inside locked subfolder
    const searchBefore = await req(`/search?spaceId=${space.id}&q=catatan`);
    const searchBeforeData = (await searchBefore.json()) as { files: Array<{ name: string }> };
    expect(searchBeforeData.files.map((f) => f.name)).toEqual(["publik-catatan.txt"]);

    // Visitor ZIP download of space root skips locked subfolder
    const zipRes = await req(`/download/folder?id=${space.id}`);
    expect(zipRes.status).toBe(200);
    const zipBytes = new TextDecoder().decode(await zipRes.arrayBuffer());
    expect(zipBytes).toContain("publik-catatan.txt");
    expect(zipBytes).not.toContain("rahasia-catatan.txt");

    // Wrong password rejected
    const wrongUnlock = await req("/auth/unlock", {
      method: "POST",
      jsonBody: { spaceId: space.id, folderId: lockedSub.id, password: "wrong" },
    });
    expect(wrongUnlock.status).toBe(401);

    // Correct subfolder password grants Viewer access to that subfolder
    const okUnlock = await req("/auth/unlock", {
      method: "POST",
      jsonBody: { spaceId: space.id, folderId: lockedSub.id, password: "sub-secret" },
    });
    expect(okUnlock.status).toBe(200);
    const { session: viewerSession, role } = (await okUnlock.json()) as { session: { token: string }; role: string };
    expect(role).toBe("viewer");

    // Now visitor CAN browse and download from the unlocked subfolder
    const unlockedBrowse = await req(`/files?spaceId=${space.id}&folder=${lockedSub.id}`, {
      token: viewerSession.token,
    });
    expect(unlockedBrowse.status).toBe(200);
    expect((await req(`/download?id=${secretFileId}`, { token: viewerSession.token })).status).toBe(200);

    // Search now includes the unlocked subfolder's file for this visitor
    const searchAfter = await req(`/search?spaceId=${space.id}&q=catatan`, { token: viewerSession.token });
    const searchAfterData = (await searchAfter.json()) as { files: Array<{ name: string }> };
    expect(searchAfterData.files.map((f) => f.name).sort()).toEqual(["publik-catatan.txt", "rahasia-catatan.txt"]);

    // Still Read-Only: visitor with subfolder unlock cannot delete the file!
    expect((await req(`/files/${secretFileId}`, { method: "DELETE", token: viewerSession.token })).status).toBe(403);

    // Owner changes subfolder password -> immediately invalidates visitor's old unlock token!
    const changePw = await req(`/folders/${lockedSub.id}/security`, {
      method: "PATCH",
      token: ownerToken,
      jsonBody: { spaceId: space.id, visibility: "locked", password: "new-sub-password" },
    });
    expect(changePw.status).toBe(200);

    const staleBrowse = await req(`/files?spaceId=${space.id}&folder=${lockedSub.id}`, {
      token: viewerSession.token,
    });
    expect(staleBrowse.status).toBe(403);

    // Owner unlocks subfolder (makes it public) -> visitor can access without token!
    const makePublic = await req(`/folders/${lockedSub.id}/security`, {
      method: "PATCH",
      token: ownerToken,
      jsonBody: { spaceId: space.id, visibility: "public" },
    });
    expect(makePublic.status).toBe(200);
    expect((await req(`/files?spaceId=${space.id}&folder=${lockedSub.id}`)).status).toBe(200);
  });

  it("isolates Trash strictly per person's space", async () => {
    const vexRes = await req("/spaces", {
      method: "POST",
      jsonBody: { name: "Vex", ownerPassword: "pw1", visibility: "public" },
    });
    const vex = (await vexRes.json()) as { space: { id: string }; session: { token: string } };

    const andiRes = await req("/spaces", {
      method: "POST",
      jsonBody: { name: "Andi", ownerPassword: "pw2", visibility: "public" },
    });
    const andi = (await andiRes.json()) as { space: { id: string }; session: { token: string } };

    const vexFileId = await uploadMockFile(vex.session.token, vex.space.id, null, "vex-doc.txt", "vex");
    await req(`/files/${vexFileId}`, { method: "DELETE", token: vex.session.token });

    // Andi's trash is empty
    const andiTrash = await req(`/trash?spaceId=${andi.space.id}`, { token: andi.session.token });
    const andiTrashData = (await andiTrash.json()) as { files: unknown[] };
    expect(andiTrashData.files).toHaveLength(0);

    // Andi cannot permanently delete Vex's trashed file
    const crossDelete = await req("/trash", {
      method: "DELETE",
      token: andi.session.token,
      jsonBody: { spaceId: andi.space.id, fileIds: [vexFileId] },
    });
    const crossData = (await crossDelete.json()) as { deleted: number; failed: string[] };
    expect(crossData.deleted).toBe(0);
    expect(crossData.failed).toEqual([vexFileId]);

    // Vex sees and restores his own trashed file
    const vexTrash = await req(`/trash?spaceId=${vex.space.id}`, { token: vex.session.token });
    const vexTrashData = (await vexTrash.json()) as { files: Array<{ id: string }> };
    expect(vexTrashData.files.map((f) => f.id)).toEqual([vexFileId]);
  });
});
