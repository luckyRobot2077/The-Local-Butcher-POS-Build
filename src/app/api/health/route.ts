/**
 * Reachability probe for the online/offline indicator. The POS never
 * depends on this to sell; it only tells the cashier whether the server
 * can be reached (navigator.onLine alone is not proof of that).
 */
export async function GET() {
  return Response.json({ ok: true, time: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
}
