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

const timeFmt = new Intl.DateTimeFormat("en-PH", {
  timeZone: BUSINESS_TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

/** Time of day in Manila with seconds, e.g. "08:02:15 AM", for shift timelines. */
export function formatManilaTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}

const dateTimeSecondsFmt = new Intl.DateTimeFormat("en-PH", {
  timeZone: BUSINESS_TIMEZONE,
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

/** Date and time in Manila with seconds, e.g. "Oct 22, 2026, 08:02:15 AM", for CSV time stamps. */
export function formatManilaSeconds(iso: string): string {
  return dateTimeSecondsFmt.format(new Date(iso));
}
