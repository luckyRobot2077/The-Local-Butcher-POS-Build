/**
 * Prints a self-contained HTML page from a hidden frame, so nothing else on
 * the screen (an open dialog, the page behind it) ends up on the paper.
 * `prepare` runs once the page and its images have loaded, before the
 * print dialog opens.
 */
export async function printInFrame(html: string, prepare?: (doc: Document) => void): Promise<void> {
  document.querySelectorAll("iframe[data-print-frame]").forEach((f) => f.remove());
  const frame = document.createElement("iframe");
  frame.dataset.printFrame = "";
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  const loaded = new Promise<void>((resolve) => frame.addEventListener("load", () => resolve(), { once: true }));
  frame.srcdoc = html;
  document.body.appendChild(frame);
  await loaded;
  const win = frame.contentWindow;
  const doc = frame.contentDocument;
  if (!win || !doc) {
    frame.remove();
    throw new Error("Printing failed.");
  }
  await Promise.all([...doc.images].map((img) => img.decode().catch(() => undefined)));
  prepare?.(doc);
  win.addEventListener("afterprint", () => setTimeout(() => frame.remove(), 0), { once: true });
  win.focus();
  win.print();
}
