# Panduan Deployment (Personal Drive)

Repo ini dideploy sebagai dua layanan terpisah (sama seperti `pagaska-drive`):

- `workers/api` → **Cloudflare Workers** (via Wrangler)
- `apps/web` → **Vercel**

Tidak diperlukan database eksternal (KV/D1/Postgres) karena seluruh pengaturan visibilitas dan hash password disimpan secara terenkripsi (PBKDF2-SHA256) pada `appProperties` privat Google Drive.

---

## 1. Persiapan Google Cloud & Google Drive

1. Buka [Google Cloud Console](https://console.cloud.google.com/) dan buat project baru.
2. Aktifkan **Google Drive API**.
3. Buat **OAuth 2.0 Client ID** (tipe *Web application* atau *Desktop*).
4. Dapatkan **Refresh Token** dengan scope `https://www.googleapis.com/auth/drive` atau `https://www.googleapis.com/auth/drive.file` (misalnya melalui [Google OAuth Playground](https://developers.google.com/oauthplayground) menggunakan Client ID & Client Secret Anda).
5. Buat satu folder kosong di Google Drive Anda sebagai induk seluruh ruang pengguna Personal Drive, lalu salin ID folder tersebut dari URL (`https://drive.google.com/drive/folders/<GOOGLE_DRIVE_ROOT>`).

Siapkan 5 secret berikut:

```
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
GOOGLE_DRIVE_ROOT
JWT_SECRET          # buat dengan: openssl rand -hex 64
```

> Catatan: Berbeda dengan `pagaska-drive`, Anda **tidak perlu lagi** mengatur `PAGASKA_PASSWORD`, `OSAMA_PASSWORD`, atau `PMR_PASSWORD` karena setiap orang membuat ruang dan passwordnya sendiri langsung dari aplikasi web.

---

## 2. Deploy Worker API ke Cloudflare Workers

```bash
npm install
cd workers/api
npx wrangler login
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put GOOGLE_DRIVE_ROOT
npx wrangler secret put JWT_SECRET
npx wrangler deploy
```

Setelah selesai, Wrangler akan menampilkan URL Worker seperti:
`https://personaldrive-api.<subdomain>.workers.dev`

---

## 3. Deploy Frontend ke Vercel

1. Hubungkan repository ini ke **Vercel** dan set **Root Directory** ke `apps/web` (atau deploy dari root dengan konfigurasi workspace).
2. Tambahkan Environment Variable di Vercel:
   - `NEXT_PUBLIC_API_URL` = `https://personaldrive-api.<subdomain>.workers.dev` (URL Worker dari langkah 2, tanpa garis miring di akhir).
3. Jalankan deploy produksi (`vercel --prod`).
