export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="card max-w-sm w-full p-6 text-center">
        <h1 className="text-2xl font-semibold mb-2">Halaman tidak ditemukan</h1>
        <p className="text-sm text-slate-500 mb-4">
          Halaman yang kamu cari tidak tersedia atau sudah dipindahkan.
        </p>
        <a className="btn-primary inline-flex" href="/">
          Kembali ke Personal Drive
        </a>
      </div>
    </main>
  );
}
