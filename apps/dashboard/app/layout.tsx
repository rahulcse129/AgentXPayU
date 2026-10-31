import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Margin",
  description: "Inference sourcing agent: every AI step bought within the customer's card hold.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
