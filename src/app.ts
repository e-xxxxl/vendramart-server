import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { env } from "./config/env.js";
import { csrfGuard } from "./middleware/csrfGuard.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { adminRouter, customerRouter, handlerRouter } from "./modules/roleShells.js";
import { vendorRouter } from "./modules/vendors/vendor.routes.js";
import { referenceRouter } from "./modules/cities/cities.routes.js";
import { catalogRouter } from "./modules/products/catalog.routes.js";
import { cartRouter, checkoutRouter } from "./modules/checkout/checkout.routes.js";
import { LOCAL_UPLOAD_ROOT, LOCAL_URL_PREFIX } from "./services/storage/LocalDiskStorage.js";
import { isProd } from "./config/env.js";
import { devPaymentsRouter } from "./modules/orders/devPayments.routes.js";
import { ordersRouter } from "./modules/orders/orders.routes.js";
import { notificationsRouter } from "./modules/notifications/notifications.routes.js";
import { receiptRouter } from "./modules/payouts/receipt.routes.js";
import { mountPaystackWebhook } from "./modules/orders/webhook.routes.js";
import { ok } from "./utils/respond.js";

export function createApp() {
  const app = express();

  // The client proxies /api to this server, so the real IP arrives in X-Forwarded-For.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(helmet());
  app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }));

  // The Paystack webhook (Phase 4) needs the raw body for signature checks, so it is mounted
  // BEFORE express.json() with express.raw(). Everything else gets parsed JSON.
  mountPaystackWebhook(app);
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  // Local-disk image fallback (dev and tests only; production uses Cloudinary).
  if (!isProd) {
    app.use(LOCAL_URL_PREFIX, express.static(LOCAL_UPLOAD_ROOT, { index: false, dotfiles: "deny" }));
  }

  const api = express.Router();
  api.use(csrfGuard);
  api.get("/health", (_req, res) => ok(res, { status: "ok" }));
  api.use(referenceRouter);
  api.use(catalogRouter);
  api.use("/cart", cartRouter);
  api.use("/checkout", checkoutRouter);
  api.use("/orders", ordersRouter);
  api.use("/notifications", notificationsRouter);
  api.use("/payouts", receiptRouter);
  if (!isProd) api.use("/dev/paystack", devPaymentsRouter);
  api.use("/auth", authRouter);
  api.use("/admin", adminRouter);
  api.use("/vendor", vendorRouter);
  api.use("/handler", handlerRouter);
  api.use("/me", customerRouter);
  app.use("/api", api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
