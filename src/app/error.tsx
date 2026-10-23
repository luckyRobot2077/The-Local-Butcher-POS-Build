"use client";

import { ErrorScreen } from "@/components/error-screen";

export default function Error(props: { error: unknown; retry: () => void }) {
  return <ErrorScreen {...props} />;
}
