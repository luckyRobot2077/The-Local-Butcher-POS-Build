/**
 * Printer adapter abstraction (spec section 14). The receipt renderer in
 * src/domain/receipt.ts produces plain text lines; adapters only move
 * those lines to a printer.
 *
 * Implemented now:
 *  - BrowserPrintAdapter: the system print dialog, with a page sized for
 *    58 mm paper. Works with any printer the phone or computer can print to.
 *
 * Not implemented until the real PT-210 is tested (docs/PRINTER_INTEGRATION.md):
 *  - Web Bluetooth (BLE) ESC/POS adapter
 *  - Android native bridge for Bluetooth Classic (SPP)
 *  - WebUSB / desktop adapter
 */
import { RECEIPT_WIDTH_58MM } from "@/domain/receipt";
import { printInFrame } from "./print-frame";

export interface PrintResult {
  ok: boolean;
  /** Human-readable reason when ok is false. */
  error?: string;
  /** True when the adapter cannot confirm paper actually came out. */
  unconfirmed?: boolean;
}

export interface PrinterAdapter {
  id: string;
  label: string;
  isAvailable(): boolean;
  print(lines: string[]): Promise<PrintResult>;
}

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Printable width of 58 mm paper on PT-210 class printers. */
const PRINT_WIDTH_MM = 48;

/**
 * The receipt as a page for 58 mm paper: the grey logo, then the text lines
 * in a monospace size that fits a full-width receipt line in the printable
 * width.
 */
export function receiptPrintHtml(lines: string[], logoSrc = "/brand/logo-receipt.png"): string {
  // Monospace characters are about 0.6 em wide.
  const fontPt = ((PRINT_WIDTH_MM / RECEIPT_WIDTH_58MM / 0.6) * 72) / 25.4;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Receipt</title><style>
@page { size: 58mm 200mm; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
body { width: ${PRINT_WIDTH_MM}mm; padding: 3mm ${(58 - PRINT_WIDTH_MM) / 2}mm 6mm; }
img { display: block; width: 30mm; height: auto; margin: 0 auto 2mm; filter: grayscale(1); }
pre { margin: 0; font: ${fontPt.toFixed(2)}pt/1.25 ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace; white-space: pre; }
</style></head><body>${logoSrc ? `<img src="${logoSrc}" alt="">` : ""}<pre>${escapeHtml(lines.join("\n"))}</pre></body></html>`;
}

/** Sizes the page to the receipt's length, so it prints as one strip. */
export function fitReceiptPage(doc: Document) {
  const mm = Math.ceil((doc.body.getBoundingClientRect().height * 25.4) / 96) + 2;
  const style = doc.createElement("style");
  style.textContent = `@page { size: 58mm ${mm}mm; margin: 0; }`;
  doc.head.appendChild(style);
}

export const browserPrintAdapter: PrinterAdapter = {
  id: "browser",
  label: "System print dialog",
  isAvailable: () => typeof window !== "undefined" && typeof window.print === "function",
  async print(lines) {
    try {
      await printInFrame(receiptPrintHtml(lines), fitReceiptPage);
      return { ok: true, unconfirmed: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Printing failed." };
    }
  },
};
