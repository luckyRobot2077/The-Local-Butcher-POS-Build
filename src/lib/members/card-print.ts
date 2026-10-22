import { printInFrame } from "@/lib/printer/print-frame";

/**
 * A page holding only the card at ID-card size, so the browser prints
 * exactly one card on one page with no margins.
 */
export function cardPrintHtml(dataUrl: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Member card</title><style>
@page { size: 85.6mm 54mm; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
img { display: block; width: 85.6mm; height: 54mm; break-inside: avoid; }
</style></head><body><img src="${dataUrl}" alt=""></body></html>`;
}

export function printMemberCard(dataUrl: string): Promise<void> {
  return printInFrame(cardPrintHtml(dataUrl));
}
