/**
 * Printer adapter abstraction (spec section 14). The receipt renderer in
 * src/domain/receipt.ts produces plain text lines; adapters only move
 * those lines to a printer.
 *
 * Implemented now:
 *  - BrowserPrintAdapter: the system print dialog, with a 58 mm print
 *    stylesheet. Works with any printer the phone or computer can print to.
 *
 * Not implemented until the real PT-210 is tested (docs/PRINTER_INTEGRATION.md):
 *  - Web Bluetooth (BLE) ESC/POS adapter
 *  - Android native bridge for Bluetooth Classic (SPP)
 *  - WebUSB / desktop adapter
 */
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

export const browserPrintAdapter: PrinterAdapter = {
  id: "browser",
  label: "System print dialog",
  isAvailable: () => typeof window !== "undefined" && typeof window.print === "function",
  async print() {
    try {
      // Prints the element marked .print-area (see globals.css).
      window.print();
      return { ok: true, unconfirmed: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Printing failed." };
    }
  },
};
