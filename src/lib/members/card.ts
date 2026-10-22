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

const SANS = `system-ui, "Segoe UI", Roboto, Arial, sans-serif`;
const MONO = `ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace`;
/** Brand colours from the store logo. */
const RED = "#910101";
const NAVY = "#091d2d";
const CREAM = "#fffdf8";

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, startPx: number, weight = "bold") {
  let size = startPx;
  do {
    ctx.font = `${weight} ${size}px ${SANS}`;
    size -= 2;
  } while (ctx.measureText(text).width > maxWidth && size > 18);
}

function spaced(ctx: CanvasRenderingContext2D, px: number) {
  // Letter spacing is a newer canvas feature; without it the text is just tighter.
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${px}px`;
}

/** PNG data URL of the front of the member card. */
export async function renderMemberCard(d: CardData): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH_PX;
  canvas.height = CARD_HEIGHT_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot draw the card.");
  ctx.textBaseline = "alphabetic";

  // White card with a red stripe and navy band along the bottom, like the logo.
  const bandY = 578;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, CARD_WIDTH_PX, CARD_HEIGHT_PX);
  ctx.fillStyle = RED;
  ctx.fillRect(0, bandY, CARD_WIDTH_PX, 8);
  ctx.fillStyle = NAVY;
  ctx.fillRect(0, bandY + 8, CARD_WIDTH_PX, CARD_HEIGHT_PX - bandY - 8);

  const logo = await loadImage("/brand/logo.jpg");
  if (logo) {
    const h = 300;
    ctx.drawImage(logo, 40, 30, Math.round((h * logo.naturalWidth) / logo.naturalHeight), h);
  } else {
    ctx.fillStyle = RED;
    fitText(ctx, d.storeName.toUpperCase(), 480, 52);
    ctx.fillText(d.storeName.toUpperCase(), 48, 120);
  }

  // QR code on the right, with a quiet zone so phone cameras read it easily.
  const qrSize = 400;
  const qrX = CARD_WIDTH_PX - qrSize - 40;
  const qrY = Math.round((bandY - qrSize) / 2);
  const qrCanvas = document.createElement("canvas");
  await QRCode.toCanvas(qrCanvas, memberQrPayload(d.memberId), {
    errorCorrectionLevel: "M",
    margin: 2,
    width: qrSize,
    color: { dark: "#000000", light: "#ffffff" },
  });
  ctx.drawImage(qrCanvas, qrX, qrY, qrSize, qrSize);

  // Member name and number on the left, under the logo.
  const leftW = qrX - 80;
  ctx.fillStyle = RED;
  ctx.font = `bold 26px ${SANS}`;
  spaced(ctx, 8);
  ctx.fillText("MEMBER", 48, 382);
  spaced(ctx, 0);
  ctx.fillStyle = NAVY;
  // Up to two lines; the font shrinks until the longest word fits.
  const words = d.name.split(/\s+/).filter(Boolean);
  const longest = words.reduce((a, b) => (b.length > a.length ? b : a), "");
  fitText(ctx, longest, leftW, 48);
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
  lines.forEach((l, i) => ctx.fillText(l, 48, 436 + i * 52));

  ctx.fillStyle = RED;
  ctx.font = `bold 40px ${MONO}`;
  ctx.fillText(d.memberNo, 48, 550);

  // Band text: store name on the left, a short instruction on the right.
  ctx.fillStyle = CREAM;
  ctx.font = `bold 22px ${SANS}`;
  spaced(ctx, 4);
  ctx.fillText(d.storeName.toUpperCase(), 48, 622);
  spaced(ctx, 0);
  ctx.font = `22px ${SANS}`;
  ctx.textAlign = "right";
  ctx.fillText("Show this card at the counter", CARD_WIDTH_PX - 40, 622);
  ctx.textAlign = "left";

  return canvas.toDataURL("image/png");
}
