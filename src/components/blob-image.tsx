"use client";

import { useEffect, useRef } from "react";

/** Shows a Blob as an image, creating and revoking its object URL. */
export function BlobImage({ blob, alt, className }: { blob: Blob; alt: string; className?: string }) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const url = URL.createObjectURL(blob);
    if (ref.current) ref.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  // eslint-disable-next-line @next/next/no-img-element -- local blob, next/image cannot optimize it
  return <img ref={ref} alt={alt} className={className} />;
}
