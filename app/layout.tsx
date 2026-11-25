import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CVMaster — Your experience universe",
  description: "A quiet, interactive universe for the experiences behind your CV.",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#04050D",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
