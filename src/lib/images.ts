/**
 * Resize and compress a photo in the browser before it is stored, so the
 * catalog stays small on the device and cheap to upload later.
 * Output: JPEG, longest side at most 800 px.
 */
export const MAX_IMAGE_SIDE = 800;
export const JPEG_QUALITY = 0.8;

export function fitWithin(width: number, height: number, max = MAX_IMAGE_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function compressImage(file: Blob): Promise<{ blob: Blob; mime: string; width: number; height: number }> {
  if (!file.type.startsWith("image/")) throw new Error("Please choose an image file.");
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const { width, height } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This device cannot process images.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  if (!blob) throw new Error("Could not compress the photo.");
  return { blob, mime: "image/jpeg", width, height };
}
