"use client";

import { ErrorScreen } from "@/components/error-screen";
import "./globals.css";

export default function GlobalError(props: { error: unknown; retry: () => void }) {
  return (
    <html lang="en-PH">
      <body className="min-h-full bg-cream-50">
        <title>The Local Butcher POS</title>
        <ErrorScreen {...props} />
      </body>
    </html>
  );
}
