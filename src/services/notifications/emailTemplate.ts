// The HTML and plain-text body of every notification email. Email programs ignore most modern styling, so this is a
// simple table layout with the styling written inline. Anything that came from a person or a store (names, product
// names, reasons) is escaped, so it can never turn into markup.

const ORANGE = "#f26a0f";
const INK = "#171a17";
const MUTED = "#5a615b";

export const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export interface EmailParts {
  /** The person's full name. Only the first name is used. */
  name: string;
  title: string;
  body: string;
  /** Where the button goes, a full address. */
  url: string;
  /** The website's address, for the logo and the footer link. */
  origin: string;
  ctaLabel?: string;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || "there";

export function renderEmail({ name, title, body, url, origin, ctaLabel = "Open VendraMart" }: EmailParts): { html: string; text: string } {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:${INK};">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f5f6f3;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f3;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e3e6e1;border-radius:12px;">
      <tr><td style="padding:24px 28px 8px;">
        <a href="${escapeHtml(origin)}" style="text-decoration:none;"><img src="${escapeHtml(origin)}/logo.png" alt="VendraMart" width="140" style="display:block;border:0;height:auto;"></a>
      </td></tr>
      <tr><td style="padding:8px 28px 4px;">
        <h1 style="margin:16px 0 12px;font-size:21px;line-height:1.3;color:${INK};">${escapeHtml(title)}</h1>
        <p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:${MUTED};">Hi ${escapeHtml(firstName(name))},</p>
        ${paragraphs}
      </td></tr>
      <tr><td style="padding:6px 28px 28px;">
        <a href="${escapeHtml(url)}" style="display:inline-block;background:${ORANGE};color:${INK};font-weight:bold;font-size:16px;text-decoration:none;padding:13px 24px;border-radius:8px;">${escapeHtml(ctaLabel)}</a>
      </td></tr>
      <tr><td style="padding:16px 28px;border-top:1px solid #e3e6e1;font-size:12px;line-height:1.5;color:${MUTED};">
        You are getting this email because of activity on your VendraMart account.<br>
        <a href="${escapeHtml(origin)}" style="color:${MUTED};">${escapeHtml(origin.replace(/^https?:\/\//, ""))}</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = `Hi ${firstName(name)},\n\n${body}\n\n${ctaLabel}: ${url}\n\nVendraMart\n${origin}`;
  return { html, text };
}
