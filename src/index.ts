import "dotenv/config";
import cors from "@fastify/cors";
import rawBodyPlugin from "fastify-raw-body";
import Fastify from "fastify";

import { loadConfig } from "./config.js";
import { connectDb } from "./db.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBillingRoutes, handleStripeWebhook } from "./routes/billing.js";
import { registerBuyerRoutes } from "./routes/buyer.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerSellerRoutes } from "./routes/seller.js";
import { registerRequestLogging } from "./request-logging.js";
import { seedAdminIfNeeded } from "./seed.js";

async function main() {
  const cfg = loadConfig();
  await connectDb(cfg.MONGODB_URI);
  await seedAdminIfNeeded(cfg);

  const app = Fastify({ logger: true });
  registerRequestLogging(app);

  const origins = cfg.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  /** Include PATCH/PUT/DELETE: default @fastify/cors methods are only GET, HEAD, POST — without these, browser preflight blocks cross-origin writes. */
  await app.register(cors, {
    origin: origins.length ? origins : true,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  await registerPublicRoutes(app, cfg);
  await registerAuthRoutes(app, cfg);
  await registerSellerRoutes(app, cfg);
  await registerBuyerRoutes(app, cfg);
  await registerAdminRoutes(app, cfg);
  await registerBillingRoutes(app, cfg);

  await app.register(rawBodyPlugin, {
    field: "rawBody",
    global: false,
    encoding: false,
    runFirst: true,
    routes: ["/stripe/webhook"],
  });

  app.post<{ Body?: unknown }>("/stripe/webhook", {
    config: { rawBody: true },
  }, async (request, reply) => {
    const sig = request.headers["stripe-signature"];
    const raw = (request as { rawBody?: Buffer | string }).rawBody;
    if (raw === undefined || raw === null || raw === "") {
      return reply.code(400).send({ error: "missing_raw_body" });
    }
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
    const result = await handleStripeWebhook(
      cfg,
      buf,
      typeof sig === "string" ? sig : Array.isArray(sig) ? sig[0] : undefined
    );
    return reply.code(result.status).send(result.body);
  });

  await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
