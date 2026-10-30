import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/providers";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Personal Drive",
  description: "Drive pribadi terpisah milik masing-masing orang dengan opsi folder publik atau berpassword.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
