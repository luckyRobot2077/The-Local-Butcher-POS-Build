"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { renderReceipt } from "@/domain/receipt";
import { getSaleDetail, recordReceiptPrint } from "@/lib/db/sales";
import { browserPrintAdapter } from "@/lib/printer/adapter";
import { Button, ErrorText } from "@/components/ui";
import { usePos } from "./pos-context";

export function ReceiptView({ saleId }: { saleId: string }) {
  const { settings, cashierName } = usePos();
  const detail = useLiveQuery(() => getSaleDetail(saleId), [saleId]);
  const [error, setError] = useState<string>();
  if (detail === undefined) return <p className="text-charcoal-500">Loading receipt…</p>;
  if (detail === null) return <ErrorText>Receipt not found on this device.</ErrorText>;

  const lines = renderReceipt({
    header: {
      storeName: settings.storeName,
      tagline: settings.tagline,
      businessLines: settings.businessLines,
      footer: settings.receiptFooter,
    },
    ...detail,
    reprint: detail.sale.receiptPrintCount > 0,
  });

  const print = async () => {
    setError(undefined);
    // Printing never creates or changes a sale; it only logs the print.
    await recordReceiptPrint(saleId, cashierName || "unknown");
    const res = await browserPrintAdapter.print(lines);
    if (!res.ok) setError(`Printing failed: ${res.error}. The sale is saved; you can reprint from History.`);
  };

  return (
    <div className="grid gap-3">
      <div className="mx-auto w-fit overflow-x-auto rounded-lg border border-cream-300 bg-white p-3 font-mono text-[12px] leading-snug text-black shadow-inner">
        {/* eslint-disable-next-line @next/next/no-img-element -- static logo, must work offline */}
        <img
          src="/brand/logo-receipt.png"
          alt=""
          width={144}
          height={161}
          className="mx-auto mb-2 block w-36 grayscale"
        />
        <pre data-testid="receipt-preview">{lines.join("\n")}</pre>
      </div>
      <ErrorText>{error}</ErrorText>
      <Button variant="secondary" onClick={print} data-testid="print-receipt">
        {detail.sale.receiptPrintCount > 0 ? "Reprint receipt" : "Print receipt"}
      </Button>
      <p className="text-center text-xs text-charcoal-500">
        Uses the system print dialog. Direct PT-210 printing is not enabled until it is tested on the real printer.
      </p>
    </div>
  );
}
