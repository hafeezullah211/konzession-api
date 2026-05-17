import { z } from "zod";

/**
 * MinIO expects `endPoint` as hostname only (no scheme, no path).
 * Accepts values like `127.0.0.1`, `minio`, `https://minio.example.com:9000`.
 */
export function parseMinioEndpoint(raw: string): { host: string; portFromUrl?: number } {
  const trimmed = raw.trim();
  if (!trimmed) return { host: "" };

  let toParse = trimmed;
  if (!/^https?:\/\//i.test(toParse)) {
    toParse = `http://${toParse}`;
  }
  try {
    const u = new URL(toParse);
    const portFromUrl = u.port ? Number.parseInt(u.port, 10) : undefined;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    return { host, portFromUrl: Number.isFinite(portFromUrl) ? portFromUrl : undefined };
  } catch {
    const noScheme = trimmed.replace(/^https?:\/\//i, "");
    const [hostPort] = noScheme.split("/");
    const [h, p] = hostPort.split(":");
    const portFromUrl = p ? Number.parseInt(p, 10) : undefined;
    return {
      host: h.replace(/^\[|\]$/g, ""),
      portFromUrl: Number.isFinite(portFromUrl) ? portFromUrl : undefined,
    };
  }
}

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  MONGODB_URI: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES: z.string().default("15m"),
  JWT_REFRESH_EXPIRES: z.string().default("7d"),
  CORS_ORIGINS: z.string().default("http://localhost:3000,http://localhost:3001"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_BASIC: z.string().optional(),
  STRIPE_PRICE_VIP: z.string().optional(),
  /**
   * Monthly EUR cents when STRIPE_PRICE_* is unset (Checkout `price_data`; matches landing: Basic €30, VIP €50).
   * If STRIPE_PRICE_BASIC/VIP are set, Stripe uses those Product Prices instead — they must match those amounts.
   */
  STRIPE_SUBSCRIPTION_BASIC_UNIT_AMOUNT_CENTS: z.coerce.number().int().positive().default(3000),
  STRIPE_SUBSCRIPTION_VIP_UNIT_AMOUNT_CENTS: z.coerce.number().int().positive().default(5000),
  /** Seller listing-partner subscription free trial length (Stripe `trial_period_days`, ~2 months). */
  SELLER_TRIAL_PERIOD_DAYS: z.coerce.number().int().min(1).max(730).default(60),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /** Display name + email, e.g. `Konzession <noreply@example.com>` */
  SMTP_FROM: z.string().optional(),
  /**
   * Override TLS mode: `true` = implicit TLS (typical for port 465).
   * Omit to infer: port 465 → secure; 587 / 2525 → STARTTLS (SiteGround-friendly).
   */
  SMTP_SECURE: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  /** Set to `false` only for debugging with broken certs (default: verify TLS). */
  SMTP_TLS_REJECT_UNAUTHORIZED: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v !== "false"),
  BREVO_API_KEY: z.string().optional(),
  EMAIL_FROM_ADDRESS: z.string().optional(),
  EMAIL_FROM_NAME: z.string().optional(),
  CHECKOUT_SUCCESS_URL: z.string().optional(),
  CHECKOUT_CANCEL_URL: z.string().optional(),
  /** Base URL of the dashboard app (password reset links). Default: http://localhost:3001 */
  DASHBOARD_ORIGIN: z.string().url().optional(),
  /** MinIO / S3-compatible host (hostname only preferred; URLs and host:port are normalized in loadConfig). */
  MINIO_ENDPOINT: z.string().min(1).optional(),
  MINIO_PORT: z.coerce.number().int().positive().optional(),
  MINIO_USE_SSL: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v === "true"),
  MINIO_ACCESS_KEY: z.string().optional(),
  MINIO_SECRET_KEY: z.string().optional(),
  /** Bucket name. Alias: set `MINIO_BUCKET_NAME` instead (read in loadConfig for Railway templates). */
  MINIO_BUCKET: z.string().optional(),
  /** Region for MinIO client and makeBucket. */
  MINIO_REGION: z.string().min(1).default("us-east-1"),
  /** Public browser base for objects, e.g. `https://cdn.example.com/my-bucket` (no trailing slash). */
  MINIO_PUBLIC_BASE_URL: z.string().url().optional(),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment variables");
  }
  const d = parsed.data;

  const bucket =
    d.MINIO_BUCKET?.trim() || process.env.MINIO_BUCKET_NAME?.trim() || undefined;

  let minioEndpoint = d.MINIO_ENDPOINT?.trim() || undefined;
  let minioPort = d.MINIO_PORT;
  if (minioEndpoint) {
    const { host, portFromUrl } = parseMinioEndpoint(minioEndpoint);
    minioEndpoint = host || undefined;
    minioPort = minioPort ?? portFromUrl;
  }

  return {
    ...d,
    EMAIL_FROM_NAME: d.EMAIL_FROM_NAME ?? "Konzession",
    MINIO_ENDPOINT: minioEndpoint,
    MINIO_PORT: minioPort,
    MINIO_BUCKET: bucket,
    MINIO_REGION: d.MINIO_REGION.trim() || "us-east-1",
  };
}
