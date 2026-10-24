import { formatPeso } from "./money";
import { formatQuantity, unitLabel } from "./quantity";
import { lineGross } from "./pricing";
import { formatManila } from "./time";
import { describeDiscount } from "./discount";
import type { PaymentRecord, SaleItemRecord, SaleRecord } from "./checkout";
import type { AppliedDiscountInput } from "./cart";
import { formatRateBp } from "./tax";

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
  /** BIR TIN from the Back Office tax setup; printed with VAT or non-VAT status. */
  tin?: string;
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

/** Program discounts print the program's name; typed ones print the rate. */
function discountLabel(d: AppliedDiscountInput): string {
  if (d.source === "promotion" && d.reason) {
    return d.input.kind === "percent" ? `${d.reason} ${describeDiscount(d.input)}` : d.reason;
  }
  return describeDiscount(d.input);
}

export function renderReceipt(r: ReceiptInput, width = RECEIPT_WIDTH_58MM): string[] {
  const { header, sale, items, payment } = r;
  const rule = "-".repeat(width);
  const lines: string[] = [];
  lines.push(...center(header.storeName.toUpperCase(), width));
  if (header.tagline) lines.push(...center(header.tagline, width));
  for (const b of header.businessLines) if (b.trim()) lines.push(...center(b, width));
  const vat = sale.taxMode === "vat";
  const tin = header.tin?.trim();
  if (vat) lines.push(...center(tin ? `VAT REG TIN ${tin}` : "VAT REGISTERED", width));
  else if (sale.taxMode === "non_vat" && tin)
    lines.push(...center("NON-VAT REGISTERED", width), ...center(`TIN ${tin}`, width));
  lines.push(rule);
  lines.push(...center("NON-FISCAL TEST RECEIPT", width));
  lines.push(...center("Not an official receipt/invoice", width));
  if (r.reprint) lines.push(...center("*** REPRINT ***", width));
  lines.push(rule);
  lines.push(...leftRight("Receipt", sale.receiptNo, width));
  lines.push(...wrap(formatManila(sale.createdAt), width));
  lines.push(...leftRight("Cashier", sale.cashierName, width));
  if (sale.memberNo) lines.push(...leftRight("Member", sale.memberNo, width));
  lines.push(rule);

  for (const it of items) {
    lines.push(...wrap(it.productName, width));
    // Sold by peso amount: the amount is exact and the weight is about what it buys.
    const approx = it.saleUnit === "kg" && it.gross !== lineGross(it.saleUnit, it.unitPrice, it.qty) ? "~" : "";
    const detail = `  ${approx}${formatQuantity(it.saleUnit, it.qty)} @ ${formatPeso(it.unitPrice)}${unitLabel(it.saleUnit)}`;
    // VAT receipts mark each line V (VATable) or E (VAT-exempt).
    const mark = vat ? (it.taxClass === "exempt" ? " E" : " V") : "";
    lines.push(...leftRight(detail, formatPeso(it.gross) + mark, width));
    if (it.itemDiscount > 0) {
      const label = it.discount ? `  Less ${discountLabel(it.discount)}` : "  Less discount";
      lines.push(...leftRight(label, "-" + formatPeso(it.itemDiscount), width));
    }
  }
  lines.push(rule);
  lines.push(...leftRight("Subtotal", formatPeso(sale.subtotal), width));
  if (sale.itemDiscountTotal > 0) {
    lines.push(...leftRight("Item discounts", "-" + formatPeso(sale.itemDiscountTotal), width));
  }
  if (sale.orderDiscount > 0) {
    const d = sale.orderDiscountDetail;
    const label = d
      ? d.source === "promotion"
        ? discountLabel(d)
        : `Order ${describeDiscount(d.input)}`
      : "Order discount";
    lines.push(...leftRight(label, "-" + formatPeso(sale.orderDiscount), width));
  }
  lines.push(...leftRight("TOTAL", formatPeso(sale.total), width));
  lines.push(rule);
  if (vat) {
    lines.push(...leftRight("VATable Sales", formatPeso(sale.vatableSales ?? 0), width));
    lines.push(...leftRight(`VAT (${formatRateBp(sale.vatRateBp ?? 1200)})`, formatPeso(sale.vatAmount ?? 0), width));
    lines.push(...leftRight("VAT-Exempt Sales", formatPeso(sale.vatExemptSales ?? 0), width));
    lines.push(...leftRight("Zero-Rated Sales", formatPeso(0), width));
    lines.push(...center("V = VATable  E = VAT-exempt", width));
    lines.push(rule);
  }
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
