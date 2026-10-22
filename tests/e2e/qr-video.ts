import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";

/**
 * Writes a Y4M video showing one QR code, for Chromium's fake camera
 * (--use-file-for-fake-video-capture). Returns the file path.
 */
export function writeQrVideo(text: string, name: string): string {
  const W = 640;
  const H = 480;
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const scale = Math.floor(360 / (size + 8));
  const side = (size + 8) * scale;
  const ox = Math.floor((W - side) / 2);
  const oy = Math.floor((H - side) / 2);
  const y = Buffer.alloc(W * H, 200); // light grey background, like a counter top
  for (let r = 0; r < side; r++) for (let c = 0; c < side; c++) y[(oy + r) * W + ox + c] = 235;
  for (let my = 0; my < size; my++)
    for (let mx = 0; mx < size; mx++) {
      if (!qr.modules.get(mx, my)) continue;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) y[(oy + (my + 4) * scale + dy) * W + ox + (mx + 4) * scale + dx] = 16;
    }
  const chroma = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  const frame = Buffer.concat([Buffer.from("FRAME\n"), y, chroma]);
  const dir = join(tmpdir(), "tlb-e2e");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.y4m`);
  writeFileSync(path, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), frame, frame]));
  return path;
}
