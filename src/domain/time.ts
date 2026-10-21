export const BUSINESS_TIMEZONE = "Asia/Manila";

const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dateTimeFmt = new Intl.DateTimeFormat("en-PH", {
  timeZone: BUSINESS_TIMEZONE,
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

/** Business date (YYYY-MM-DD) in Manila for a UTC instant. */
export function businessDate(at: Date): string {
  return dateFmt.format(at);
}

/** Human date and time in Manila, e.g. "Oct 22, 2026, 05:25 AM". */
export function formatManila(iso: string): string {
  return dateTimeFmt.format(new Date(iso));
}
