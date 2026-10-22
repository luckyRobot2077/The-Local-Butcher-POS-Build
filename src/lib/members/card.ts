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
  /** Printed under the QR code with small icons; empty ones are left off. */
  socials?: { facebook?: string; tiktok?: string; whatsapp?: string };
}

type Social = "facebook" | "tiktok" | "whatsapp";

/** Small round icon for a social account, drawn with shapes so it looks the same on every device. */
function drawSocialIcon(ctx: CanvasRenderingContext2D, kind: Social, x: number, y: number, size: number) {
  const r = size / 2;
  const cx = x + r;
  const cy = y + r;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = kind === "facebook" ? "#1877f2" : kind === "tiktok" ? "#000000" : "#25d366";
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#ffffff";
  if (kind === "facebook") {
    ctx.font = `bold ${Math.round(size * 0.78)}px ${SANS}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("f", cx + size * 0.04, y + size * 0.86);
  } else if (kind === "tiktok") {
    // A music note: stem, flag and note head.
    ctx.lineWidth = size * 0.11;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx + size * 0.04, cy + size * 0.18);
    ctx.lineTo(cx + size * 0.04, cy - size * 0.28);
    ctx.quadraticCurveTo(cx + size * 0.1, cy - size * 0.1, cx + size * 0.28, cy - size * 0.12);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx - size * 0.08, cy + size * 0.18, size * 0.13, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // A speech bubble with a handset inside.
    ctx.lineWidth = size * 0.08;
    ctx.beginPath();
    ctx.arc(cx, cy - size * 0.02, size * 0.3, Math.PI * 0.75, Math.PI * 2.6);
    ctx.lineTo(cx - size * 0.3, cy + size * 0.3);
    ctx.closePath();
    ctx.stroke();
    ctx.lineWidth = size * 0.1;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx, cy - size * 0.02, size * 0.13, Math.PI * 0.6, Math.PI * 1.4);
    ctx.stroke();
  }
  ctx.restore();
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
  // It is a little smaller when social accounts are listed under it.
  const socials = (["facebook", "tiktok", "whatsapp"] as const)
    .map((kind) => ({ kind, text: d.socials?.[kind]?.trim() ?? "" }))
    .filter((x) => x.text);
  const rowH = 44;
  const qrSize = socials.length ? Math.min(400, bandY - 40 - socials.length * rowH - 14) : 400;
  const qrX = CARD_WIDTH_PX - 400 - 40 + Math.round((400 - qrSize) / 2);
  const qrY = socials.length ? 22 : Math.round((bandY - qrSize) / 2);
  const qrCanvas = document.createElement("canvas");
  await QRCode.toCanvas(qrCanvas, memberQrPayload(d.memberId), {
    errorCorrectionLevel: "M",
    margin: 2,
    width: qrSize,
    color: { dark: "#000000", light: "#ffffff" },
  });
  ctx.drawImage(qrCanvas, qrX, qrY, qrSize, qrSize);

  const colX = CARD_WIDTH_PX - 400 - 40;
  socials.forEach((sc, i) => {
    const y = qrY + qrSize + 8 + i * rowH;
    drawSocialIcon(ctx, sc.kind, colX + 16, y + 4, 34);
    ctx.fillStyle = NAVY;
    fitText(ctx, sc.text, 400 - 70, 28, "600");
    ctx.textBaseline = "middle";
    ctx.fillText(sc.text, colX + 62, y + 22);
    ctx.textBaseline = "alphabetic";
  });

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
