import "dotenv/config";
import cors from "@fastify/cors";
import rawBodyPlugin from "fastify-raw-body";
import Fastify from "fastify";

import { loadConfig } from "./config.js";
import { connectDb } from "./db.js";
import {
  buildCorsOriginMatcher,
  describeCorsRules,
  parseCorsOrigins,
} from "./lib/cors-origins.js";
import { ensureUnlockEventIndexes } from "./lib/index-migrations.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBillingRoutes, handleStripeWebhook } from "./routes/billing.js";
import { registerBuyerRoutes } from "./routes/buyer.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerSellerRoutes } from "./routes/seller.js";
import { registerRequestLogging } from "./request-logging.js";
import { seedAdminIfNeeded } from "./seed.js";

/**
 * Surface late async failures (Mongo disconnect, email API, etc.) so Railway's logs
 * show the actual cause instead of silently 502-ing on the next request.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

async function main() {
  const cfg = loadConfig();

  const emailVarsOk = Boolean(cfg.BREVO_API_KEY && cfg.EMAIL_FROM_ADDRESS);
  if (!emailVarsOk) {
    console.warn(
      "[startup] Outbound email disabled: set BREVO_API_KEY and EMAIL_FROM_ADDRESS. " +
        "Forgot-password still returns reset_email_sent but will not send until these are set."
    );
  } else if (cfg.BREVO_API_KEY!.startsWith("xsmtpsib-")) {
    console.error(
      "[startup] BREVO_API_KEY looks like an SMTP key (xsmtpsib-). " +
        "Use a REST API key from Brevo → SMTP & API → API Keys (starts with xkeysib-)."
    );
  }

  try {
    await connectDb(cfg.MONGODB_URI);
  } catch (err) {
    console.error(
      "[startup] MongoDB connection failed. Verify MONGODB_URI and that the cluster's IP allowlist accepts requests from Railway (Atlas: Network Access → 0.0.0.0/0 or the Railway egress IPs).",
      err
    );
    throw err;
  }

  if (emailVarsOk) {
    fetch("https://api.brevo.com/v3/account", {
      headers: {
        "api-key": cfg.BREVO_API_KEY!,
        accept: "application/json",
      },
    })
      .then(async (res) => {
        if (res.ok) {
          const data = (await res.json()) as { email?: string };
          console.log(`[BREVO] API key OK — account: ${data.email ?? "unknown"}`);
        } else {
          console.error(`[BREVO] API key check FAILED: ${res.status} ${res.statusText}`);
        }
      })
      .catch((err: Error) => console.error("[BREVO] check ERROR:", err.message));
  }

  await ensureUnlockEventIndexes();
  await seedAdminIfNeeded(cfg);

  const app = Fastify({ logger: true });
  registerRequestLogging(app);

  /**
   * `CORS_ORIGINS` is a comma-separated list. We tolerate trailing slashes and
   * support `*.vercel.app`-style wildcards so Vercel preview deployments work
   * without redeploying the API every time a new preview URL is generated.
   */
  const corsRules = parseCorsOrigins(cfg.CORS_ORIGINS);
  app.log.info({ corsRules: describeCorsRules(corsRules) }, "[startup] CORS origins registered");
  await app.register(cors, {
    origin: buildCorsOriginMatcher(corsRules),
    credentials: true,
    /** Default @fastify/cors methods are only GET, HEAD, POST — without these, browser preflight blocks cross-origin writes. */
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    /** Mirrors the headers the browser asks for in `Access-Control-Request-Headers`. */
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
    /** Some preflights (Safari, older Edge) require an explicit 204. */
    optionsSuccessStatus: 204,
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
  console.error("[fatal] API failed to start:", err);
  process.exit(1);
});
