import { formatPeso } from "./money";
import { formatQuantity, unitLabel } from "./quantity";
import { formatManila } from "./time";
import { describeDiscount } from "./discount";
import type { PaymentRecord, SaleItemRecord, SaleRecord } from "./checkout";

/**
 * Transport-independent receipt renderer. It produces plain text lines
 * for a fixed character width. 58 mm thermal printers such as the PT-210
 * usually print 32 characters per line in their default font; this must
 * be confirmed on the real printer (see docs/PRINTER_INTEGRATION.md).
 */
export const RECEIPT_WIDTH_58MM = 32;

export interface ReceiptHeader {
  storeName: string;
  tagline?: string;
  /** Free-form registered business details, one per line. */
  businessLines: string[];
  footer: string;
}

export interface ReceiptInput {
  header: ReceiptHeader;
  sale: SaleRecord;
  items: SaleItemRecord[];
  payment: PaymentRecord;
  reprint?: boolean;
}

/** Word-wrap text to the width, hard-splitting words that are too long. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > width) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += " " + word;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

export function center(text: string, width: number): string[] {
  return wrap(text, width).map((l) => {
    const pad = Math.max(0, Math.floor((width - l.length) / 2));
    return " ".repeat(pad) + l;
  });
}

/** Left text and right text on one line; wraps the left text if needed. */
export function leftRight(left: string, right: string, width: number): string[] {
  const room = width - right.length - 1;
  if (room < 4) return [...wrap(left, width), right.padStart(width)];
  const lefts = wrap(left, room);
  const last = lefts.pop() ?? "";
  return [...lefts, last.padEnd(room) + " " + right];
}

export function renderReceipt(r: ReceiptInput, width = RECEIPT_WIDTH_58MM): string[] {
  const { header, sale, items, payment } = r;
  const rule = "-".repeat(width);
  const lines: string[] = [];
  lines.push(...center(header.storeName.toUpperCase(), width));
  if (header.tagline) lines.push(...center(header.tagline, width));
  for (const b of header.businessLines) if (b.trim()) lines.push(...center(b, width));
  lines.push(rule);
  lines.push(...center("NON-FISCAL TEST RECEIPT", width));
  lines.push(...center("Not an official receipt/invoice", width));
  if (r.reprint) lines.push(...center("*** REPRINT ***", width));
  lines.push(rule);
  lines.push(...leftRight("Receipt", sale.receiptNo, width));
  lines.push(...wrap(formatManila(sale.createdAt), width));
  lines.push(...leftRight("Cashier", sale.cashierName, width));
  lines.push(rule);

  for (const it of items) {
    lines.push(...wrap(it.productName, width));
    const detail = `  ${formatQuantity(it.saleUnit, it.qty)} @ ${formatPeso(it.unitPrice)}${unitLabel(it.saleUnit)}`;
    lines.push(...leftRight(detail, formatPeso(it.gross), width));
    if (it.itemDiscount > 0) {
      const label = it.discount ? `  Less ${describeDiscount(it.discount.input)}` : "  Less discount";
      lines.push(...leftRight(label, "-" + formatPeso(it.itemDiscount), width));
    }
  }
  lines.push(rule);
  lines.push(...leftRight("Subtotal", formatPeso(sale.subtotal), width));
  if (sale.itemDiscountTotal > 0) {
    lines.push(...leftRight("Item discounts", "-" + formatPeso(sale.itemDiscountTotal), width));
  }
  if (sale.orderDiscount > 0) {
    const label = sale.orderDiscountDetail
      ? `Order ${describeDiscount(sale.orderDiscountDetail.input)}`
      : "Order discount";
    lines.push(...leftRight(label, "-" + formatPeso(sale.orderDiscount), width));
  }
  lines.push(...leftRight("TOTAL", formatPeso(sale.total), width));
  lines.push(rule);
  if (payment.method === "cash") {
    lines.push(...leftRight("Cash", formatPeso(payment.tendered), width));
    lines.push(...leftRight("Change", formatPeso(payment.change), width));
  } else {
    lines.push(...leftRight("GCash (manual)", formatPeso(payment.amount), width));
    if (payment.reference) lines.push(...leftRight("Ref", payment.reference, width));
  }
  lines.push(rule);
  if (header.footer.trim()) lines.push(...center(header.footer, width));
  lines.push(...center(`Txn ${sale.id.slice(0, 8)}`, width));
  return lines;
}
