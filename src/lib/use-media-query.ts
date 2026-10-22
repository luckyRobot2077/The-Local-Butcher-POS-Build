"use client";

import { useSyncExternalStore } from "react";

/** True while the CSS media query matches, e.g. "(min-width: 1024px)" for a landscape tablet. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
