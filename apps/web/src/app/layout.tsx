import "@orbix/ui/src/tokens.css";
import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Orbix" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex flex-col min-h-screen">
        <div className="flex-1">{children}</div>
        <footer className="py-4 px-8 text-center text-xs text-[var(--text-dim)]">
          This product uses the TMDB API but is not endorsed or certified by TMDB.
        </footer>
      </body>
    </html>
  );
}
