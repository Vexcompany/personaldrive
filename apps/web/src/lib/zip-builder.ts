import type { DriveFile } from "@personaldrive/shared";

interface ZipEntry {
  name: string;
  data: Uint8Array;
  compressed: Uint8Array;
  method: number;
  crc32: number;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isCompressible(mimeType: string): boolean {
  if (mimeType.startsWith("text/")) return true;
  if (mimeType === "application/json") return true;
  if (mimeType === "application/javascript") return true;
  if (mimeType === "application/xml") return true;
  if (mimeType === "application/svg+xml") return true;
  return false;
}

async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    const cs = new CompressionStream("deflate-raw");
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();

    const ab = new ArrayBuffer(data.byteLength);
    new Uint8Array(ab).set(data);

    writer.write(new Uint8Array(ab));
    writer.close();

    const chunks: Uint8Array[] = [];
    let totalLen = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLen += value.length;
    }

    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  } catch {
    return null;
  }
}

function writeU16(buf: Uint8Array, offset: number, val: number) {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >> 8) & 0xff;
}

function writeU32(buf: Uint8Array, offset: number, val: number) {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >> 8) & 0xff;
  buf[offset + 2] = (val >> 16) & 0xff;
  buf[offset + 3] = (val >> 24) & 0xff;
}

async function parallelMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function fetchItem(
  item: DriveFile,
  apiUrl: string,
  headers: Record<string, string>
): Promise<{ name: string; data: Uint8Array; mimeType: string } | null> {
  try {
    const url =
      item.mimeType === "application/vnd.google-apps.folder"
        ? `${apiUrl}/download/folder?id=${encodeURIComponent(item.id)}`
        : `${apiUrl}/download?id=${encodeURIComponent(item.id)}`;

    const res = await fetch(url, { headers });
    if (!res.ok) return null;

    const blob = await res.blob();
    const data = new Uint8Array(await blob.arrayBuffer());
    const name = item.mimeType === "application/vnd.google-apps.folder" ? `${item.name}.zip` : item.name;
    return { name, data, mimeType: item.mimeType };
  } catch {
    return null;
  }
}

export async function buildClientZip(items: DriveFile[]): Promise<Blob> {
  const { API_URL, authHeaders } = await import("./api");
  const headers = authHeaders();

  const downloaded = await parallelMap(items, (item) => fetchItem(item, API_URL, headers), 4);

  const entries: ZipEntry[] = [];
  for (const result of downloaded) {
    if (!result) continue;
    const { name, data, mimeType } = result;
    const crc = crc32(data);

    let compressed = data;
    let method = 0;
    if (isCompressible(mimeType)) {
      const deflated = await deflate(data);
      if (deflated && deflated.length < data.length) {
        compressed = deflated;
        method = 8;
      }
    }
    entries.push({ name, data, compressed, method, crc32: crc });
  }

  let localSize = 0;
  let centralSize = 0;
  const offsets: number[] = [];

  for (const entry of entries) {
    offsets.push(localSize);
    const nameBytes = new TextEncoder().encode(entry.name);
    localSize += 30 + nameBytes.length + entry.compressed.length;
    centralSize += 46 + nameBytes.length;
  }

  const eocdSize = 22;
  const totalSize = localSize + centralSize + eocdSize;
  const buf = new Uint8Array(totalSize);
  let pos = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const nameBytes = new TextEncoder().encode(entry.name);

    writeU32(buf, pos, 0x04034b50); pos += 4;
    writeU16(buf, pos, 20); pos += 2;
    writeU16(buf, pos, 0); pos += 2;
    writeU16(buf, pos, entry.method); pos += 2;
    writeU16(buf, pos, 0); pos += 2;
    writeU16(buf, pos, 0); pos += 2;
    writeU32(buf, pos, entry.crc32); pos += 4;
    writeU32(buf, pos, entry.compressed.length); pos += 4;
    writeU32(buf, pos, entry.data.length); pos += 4;
    writeU16(buf, pos, nameBytes.length); pos += 2;
    writeU16(buf, pos, 0); pos += 2;
    buf.set(nameBytes, pos); pos += nameBytes.length;
    buf.set(entry.compressed, pos); pos += entry.compressed.length;
  }

  const centralStart = pos;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const nameBytes = new TextEncoder().encode(entry.name);

    writeU32(buf, pos, 0x02014b50); pos += 4;
    writeU16(buf, pos, 20); pos += 2;
    writeU16(buf, pos, 20); pos += 2;
    writeU16(buf, pos, 0); pos += 2;
    writeU16(buf, pos, entry.method); pos += 2;
    writeU16(buf, pos, 0); pos += 2;
    writeU16(buf, pos, 0); pos += 2;
    writeU32(buf, pos, entry.crc32); pos += 4;
    writeU32(buf, pos, entry.compressed.length); pos += 4;
    writeU32(buf, pos, entry.data.length); pos += 4;
    writeU16(buf, pos, nameBytes.length); pos += 2;
    writeU16(buf, pos, 0); pos += 2;
    writeU16(buf, pos, 0); pos += 2;
    writeU16(buf, pos, 0); pos += 2;
    writeU16(buf, pos, 0); pos += 2;
    writeU32(buf, pos, 0); pos += 4;
    writeU32(buf, pos, offsets[i]); pos += 4;
    buf.set(nameBytes, pos); pos += nameBytes.length;
  }

  writeU32(buf, pos, 0x06054b50); pos += 4;
  writeU16(buf, pos, 0); pos += 2;
  writeU16(buf, pos, 0); pos += 2;
  writeU16(buf, pos, entries.length); pos += 2;
  writeU16(buf, pos, entries.length); pos += 2;
  writeU32(buf, pos, centralSize); pos += 4;
  writeU32(buf, pos, centralStart); pos += 4;
  writeU16(buf, pos, 0); pos += 2;

  const outBuf = new ArrayBuffer(buf.byteLength);
  new Uint8Array(outBuf).set(buf);
  return new Blob([outBuf], { type: "application/zip" });
}
