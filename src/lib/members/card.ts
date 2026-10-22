import QRCode from "qrcode";
import { memberQrPayload } from "@/domain/members";

/**
 * Member card artwork, drawn on a canvas at ID-card size (CR80, 85.6 × 54
 * mm) and 300 dpi, so the same image can be printed here, saved for a
 * print shop, or shown on screen.
 */
export const CARD_WIDTH_PX = 1012;
export const CARD_HEIGHT_PX = 638;

export interface CardData {
  memberId: string;
  memberNo: string;
  name: string;
  storeName: string;
  tagline?: string;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, startPx: number, weight = "bold") {
  let size = startPx;
  do {
    ctx.font = `${weight} ${size}px system-ui, "Segoe UI", Roboto, Arial, sans-serif`;
    size -= 2;
  } while (ctx.measureText(text).width > maxWidth && size > 18);
}

/** PNG data URL of the front of the member card. */
export async function renderMemberCard(d: CardData): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH_PX;
  canvas.height = CARD_HEIGHT_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot draw the card.");

  // Background and band.
  ctx.fillStyle = "#fffdf9";
  ctx.fillRect(0, 0, CARD_WIDTH_PX, CARD_HEIGHT_PX);
  ctx.fillStyle = "#7a1f2b";
  ctx.fillRect(0, 0, CARD_WIDTH_PX, 150);
  ctx.fillStyle = "#e4d8c4";
  ctx.fillRect(0, 150, CARD_WIDTH_PX, 8);

  const logo = await loadImage("/icons/icon-192.png");
  if (logo) ctx.drawImage(logo, 40, 27, 96, 96);
  ctx.fillStyle = "#fffdf9";
  fitText(ctx, d.storeName.toUpperCase(), CARD_WIDTH_PX - 220, 52);
  ctx.textBaseline = "alphabetic";
  ctx.fillText(d.storeName.toUpperCase(), 160, d.tagline ? 80 : 95);
  if (d.tagline) {
    ctx.font = `28px system-ui, "Segoe UI", Roboto, Arial, sans-serif`;
    ctx.fillText(d.tagline, 160, 122);
  }

  // QR code on the right, with a quiet zone so phone cameras read it easily.
  const qrSize = 400;
  const qrX = CARD_WIDTH_PX - qrSize - 40;
  const qrY = 190;
  const qrCanvas = document.createElement("canvas");
  await QRCode.toCanvas(qrCanvas, memberQrPayload(d.memberId), {
    errorCorrectionLevel: "M",
    margin: 2,
    width: qrSize,
    color: { dark: "#000000", light: "#ffffff" },
  });
  ctx.drawImage(qrCanvas, qrX, qrY, qrSize, qrSize);

  // Member name and number on the left.
  const leftW = qrX - 80;
  ctx.fillStyle = "#3a3936";
  ctx.font = `600 30px system-ui, "Segoe UI", Roboto, Arial, sans-serif`;
  ctx.fillText("MEMBER", 48, 250);
  ctx.fillStyle = "#22211f";
  // Up to two lines; the font shrinks until the longest word fits.
  const words = d.name.split(/\s+/).filter(Boolean);
  const longest = words.reduce((a, b) => (b.length > a.length ? b : a), "");
  fitText(ctx, longest, leftW, 52);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (!cur || ctx.measureText(t).width <= leftW) cur = t;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > 2) lines.splice(1, lines.length - 1, lines.slice(1).join(" ").slice(0, 24) + "…");
  lines.forEach((l, i) => ctx.fillText(l, 48, 320 + i * 64));

  ctx.fillStyle = "#7a1f2b";
  ctx.font = `bold 44px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace`;
  ctx.fillText(d.memberNo, 48, 520);
  ctx.fillStyle = "#5c5a57";
  ctx.font = `24px system-ui, "Segoe UI", Roboto, Arial, sans-serif`;
  ctx.fillText("Show this card at the counter.", 48, 566);

  return canvas.toDataURL("image/png");
}
