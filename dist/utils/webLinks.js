// Addresses of website pages that show one record, used in notifications and emails. The website is a static site, so a
// record is named in the address after a question mark (see client/src/lib/routes.ts, which must match these).
export const orderPage = (orderId) => `/order/?id=${String(orderId)}`;
export const deliveryPage = (subOrderId) => `/handler/delivery/?id=${String(subOrderId)}`;
export const adminPayoutPage = (payoutId) => `/admin/payouts/?id=${String(payoutId)}`;
