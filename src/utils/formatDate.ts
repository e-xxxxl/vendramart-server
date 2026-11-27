const TZ = "Africa/Lagos";

/** "26 November 2026 at 14:30" on the Lagos clock, for a moment named in a message to a person. */
export function formatLagosDateTime(d: Date): string {
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: TZ });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });
  return `${date} at ${time}`;
}
