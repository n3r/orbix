import "@orbix/ui/src/tokens.css";
import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Orbix" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
