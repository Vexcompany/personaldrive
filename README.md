# Personal Drive

Aplikasi penyimpanan berbasis Google Drive milik masing-masing orang (diadaptasi dan dikembangkan dari arsitektur `pagaska-drive`).

Setiap pengunjung dapat membuat folder utama atas namanya sendiri (misalnya `Vex`) tanpa login akun Google. Pemilik folder dapat memilih apakah foldernya maupun subfolder di dalamnya bersifat **Publik** (pengunjung lain bisa melihat preview & download saja / *Read-Only*) atau **Terkunci Password** (tidak dapat dibuka sama sekali tanpa password).

```
.
├── apps/
│   └── web/                  # Next.js 15 (App Router) + React 19 + Tailwind CSS
├── workers/
│   └── api/                  # Cloudflare Worker REST API (Wrangler)
├── packages/
│   └── upload-engine/        # Chunked resumable upload engine
└── shared/                   # Shared TypeScript types
```

## Fitur Utama

- **Ruang Terpisah per Orang (Dinamis)** — Siapa saja dapat membuat ruang/folder utamanya sendiri langsung dari halaman depan tanpa perlu hardcode di `.env`.
- **Opsi Publik atau Password di Semua Level Folder**:
  - **Folder Utama Terkunci (`locked`)** — Tidak ada yang bisa membuka atau melihat isinya tanpa memasukkan password.
  - **Folder Utama Publik (`public`)** — Semua orang bebas membuka, melihat preview (foto, video, audio, PDF, teks), dan mendownload file/folder ZIP (**Read-Only**).
  - **Subfolder Berpassword** — Di dalam ruang publik sekalipun, pemilik tetap bisa mengunci subfolder tertentu dengan password terpisah (dan isi subfolder terkunci otomatis tersembunyi dari pencarian maupun download ZIP pengunjung).
- **Password Pemilik Lintas Perangkat** — Pemilik bisa klik **Masuk Pemilik** dari HP atau laptop mana pun untuk upload file/folder, membuat subfolder, memindahkan, mengganti nama, mengelola Sampah (*Trash*), serta memasang/melepas password folder kapan saja.
- **Tanpa Database Tambahan** — Hash password (PBKDF2-HMAC-SHA256 + salt unik) disimpan secara privat di `appProperties` Google Drive (hanya dapat dibaca oleh OAuth client Worker di server, tidak pernah terekspos ke publik atau browser).
- **Resumable Chunked Upload** — Mendukung upload file besar, banyak file sekaligus, maupun struktur folder penuh (drag-and-drop) dengan panel progress mengambang (*pause*, *resume*, *retry*, deteksi duplikat).

## Quick Start (Pengembangan Lokal)

```bash
# 1. Install dependencies (otomatis membuild @personaldrive/shared & @personaldrive/upload-engine)
npm install

# 2. Konfigurasi Worker di workers/api/.dev.vars
# Untuk mencoba langsung tanpa kredensial Google Drive (mode simulasi memori):
cat <<EOF > workers/api/.dev.vars
MOCK_DRIVE=true
JWT_SECRET=dev-secret-key-change-me
EOF

# Atau isi kredensial Google Drive asli (lihat DEPLOYMENT.md):
# GOOGLE_CLIENT_ID=...
# GOOGLE_CLIENT_SECRET=...
# GOOGLE_REFRESH_TOKEN=...
# GOOGLE_DRIVE_ROOT=...
# JWT_SECRET=...

# 3. Jalankan Worker API (port 8787) dan Web UI (port 3000)
npm --workspace @personaldrive/worker-api run dev
# Di terminal lain:
npm --workspace @personaldrive/web run dev
```

Secara default di lokal, Next.js meneruskan request `/api/*` ke `http://127.0.0.1:8787`. Saat dideploy ke Vercel, set `NEXT_PUBLIC_API_URL` ke URL Cloudflare Worker Anda.

## Perintah Penting

```bash
npm run typecheck   # Cek tipe TypeScript di seluruh workspace
npm test            # Jalankan unit & integration tests (Vitest)
npm run build       # Build seluruh paket & aplikasi Next.js
```

## Panduan Deploy

Lihat [`DEPLOYMENT.md`](./DEPLOYMENT.md) untuk panduan lengkap deploy ke **Cloudflare Workers** + **Vercel** + **Google Drive API**.

## Lisensi

MIT
