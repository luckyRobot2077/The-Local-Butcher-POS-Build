"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { getDb } from "@/lib/db/db";

/** The locally stored photo blob for a product image, if any. */
export function useImageBlob(imageId: string | undefined): Blob | undefined {
  return useLiveQuery(async () => (imageId ? (await getDb().productImages.get(imageId))?.blob : undefined), [imageId]);
}
