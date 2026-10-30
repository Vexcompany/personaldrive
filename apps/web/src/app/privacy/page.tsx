import Link from "next/link";

export const metadata = {
  title: "Kebijakan Privasi — Personal Drive",
  description: "Kebijakan Privasi untuk Personal Drive.",
};

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-12 text-slate-800">
      <article className="mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-10">
        <div className="mb-8">
          <Link href="/" className="text-sm font-medium text-brand-600 hover:text-brand-700">
            ← Kembali ke Personal Drive
          </Link>
          <h1 className="mt-5 text-3xl font-bold tracking-tight text-slate-900">Kebijakan Privasi</h1>
          <p className="mt-2 text-sm text-slate-500">Terakhir diperbarui: 30 Oktober 2026</p>
        </div>

        <div className="space-y-6 text-sm leading-7 text-slate-600">
          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-900">1. Ringkasan</h2>
            <p>
              Personal Drive menyediakan ruang penyimpanan terpisah milik masing-masing pengguna di atas Google Drive
              tanpa mengekspos token OAuth Google ke browser. Setiap pemilik ruang dapat menentukan apakah foldernya
               maupun subfolder di dalamnya bersifat publik (Read-Only untuk pengunjung) atau terkunci dengan password.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-900">2. Keamanan Password & Akses</h2>
            <p>
              Password pemilik maupun password folder tidak pernah disimpan dalam bentuk teks biasa (plaintext).
              Password di-hash di sisi server menggunakan PBKDF2-HMAC-SHA256 beserta salt acak unik dan disimpan pada
              metadata privat aplikasi (`appProperties`) yang tidak dapat dilihat oleh publik.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-900">3. Penyimpanan Google Drive</h2>
            <p>
              Seluruh kredensial Google OAuth dikelola sepenuhnya di sisi server (Cloudflare Worker). Browser hanya
              berkomunikasi dengan API Worker untuk membaca daftar file yang diizinkan, melakukan preview, download,
              dan upload bertahap (chunked resumable upload).
            </p>
          </section>
        </div>
      </article>
    </main>
  );
}
