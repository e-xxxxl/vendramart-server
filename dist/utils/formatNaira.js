/** Integer kobo to text such as "₦43,740" or "₦1,920.50". For messages and emails; the web UI has its own formatter. */
export function formatNaira(kobo) {
    const whole = Math.floor(Math.abs(kobo) / 100);
    const rest = Math.abs(kobo) % 100;
    const text = `${whole.toLocaleString("en-NG")}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
    return `${kobo < 0 ? "-" : ""}₦${text}`;
}
