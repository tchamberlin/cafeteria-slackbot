export const CAFETERIA_TZ = "America/New_York";

export function isoDateInZone(date: Date, timeZone: string = CAFETERIA_TZ): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
