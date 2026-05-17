import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { authenticate } from "../auth-middleware.js";
import type { Config } from "../config.js";
import { hashPassword, verifyPassword } from "../lib/auth-hash.js";
import { createTransport, formatEmailFrom, sendPasswordResetEmail } from "../lib/mail.js";
import { getStripe } from "../lib/stripe-client.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../lib/jwt.js";
import { RefreshTokenModel } from "../models/RefreshToken.js";
import { RegistrationIntentModel } from "../models/RegistrationIntent.js";
import { UserModel } from "../models/User.js";

const registerSellerBody = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    confirmPassword: z.string().min(1),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    phone: z.string().min(4),
    whatsapp: z.string().optional(),
    tradeType: z.string().min(1),
    /**
     * Optional preferred plan recorded at signup. The user is created immediately on
     * a free 2-month trial regardless of this value — no Stripe checkout is required
     * to finish registration. The chosen plan is used later (post-trial) when the
     * seller subscribes from the dashboard.
     */
    plan: z.enum(["basic", "vip"]).optional(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "passwords_mismatch",
    path: ["confirmPassword"],
  });

const registerBuyerBody = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    confirmPassword: z.string().min(1),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    phone: z.string().min(4),
    whatsapp: z.string().optional(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "passwords_mismatch",
    path: ["confirmPassword"],
  });

const forgotPasswordBody = z.object({
  email: z.string().email(),
});

const resetPasswordBody = z.object({
  token: z.string().min(16),
  password: z.string().min(8),
});

function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function dashboardOrigin(cfg: Config): string {
  return (cfg.DASHBOARD_ORIGIN ?? "http://localhost:3001").replace(/\/$/, "");
}

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshBody = z.object({
  refreshToken: z.string().min(10),
});

const completeCheckoutBody = z.object({
  sessionId: z.string().min(1),
});

function refreshExpiryDate(cfg: Config) {
  const match = /^(\d+)([smhd])$/.exec(cfg.JWT_REFRESH_EXPIRES);
  if (!match) return new Date(Date.now() + 7 * 86400_000);
  const n = Number(match[1]);
  const u = match[2];
  const mult =
    u === "s" ? 1000 : u === "m" ? 60_000 : u === "h" ? 3_600_000 : 86_400_000;
  return new Date(Date.now() + n * mult);
}

export async function registerAuthRoutes(fastify: FastifyInstance, cfg: Config) {
  /**
   * Seller registration is now free of charge:
   *   - The user account is always created immediately.
   *   - `subscriptionStatus` is set to "trialing" with `trialEndsAt` ~2 months out.
   *   - No Stripe Checkout session is opened during registration; the seller can
   *     subscribe to Basic / VIP later via `/seller/checkout` once the trial nears
   *     its end (or already during the trial if they want premium placement).
   *   - `plan` is recorded as the preferred plan but is purely informational here.
   */
  fastify.post("/auth/register/seller", async (request, reply) => {
    const parsed = registerSellerBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    const b = parsed.data;
    const exists = await UserModel.exists({ email: b.email.toLowerCase() });
    if (exists) return reply.code(409).send({ error: "email_taken" });

    const passwordHash = await hashPassword(b.password);
    const trialEndsAt = new Date(
      Date.now() + cfg.SELLER_TRIAL_PERIOD_DAYS * 86_400_000
    );

    const user = await UserModel.create({
      email: b.email.toLowerCase(),
      passwordHash,
      role: "seller",
      firstName: b.firstName,
      lastName: b.lastName,
      phone: b.phone,
      whatsapp: b.whatsapp ?? b.phone,
      tradeType: b.tradeType,
      displayName: `${b.firstName} ${b.lastName}`.trim(),
      subscriptionPlan: b.plan ?? null,
      subscriptionStatus: "trialing",
      trialEndsAt,
    });

    const access = signAccessToken(cfg, user);
    const refresh = signRefreshToken(cfg, String(user._id));
    await RefreshTokenModel.create({
      token: refresh,
      userId: user._id,
      expiresAt: refreshExpiryDate(cfg),
    });
    return {
      accessToken: access,
      refreshToken: refresh,
      requiresCheckout: false,
      trialEndsAt: trialEndsAt.toISOString(),
    };
  });

  /**
   * Buyer registration is also free of charge:
   *   - The user is created with `creditBalance: 0`.
   *   - Credits are purchased later from `/buyer/purchase-credits` (Stripe), and only
   *     when the buyer actually tries to unlock a license-holder profile.
   */
  fastify.post("/auth/register/buyer", async (request, reply) => {
    const parsed = registerBuyerBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    const b = parsed.data;
    const exists = await UserModel.exists({ email: b.email.toLowerCase() });
    if (exists) return reply.code(409).send({ error: "email_taken" });

    const passwordHash = await hashPassword(b.password);
    const user = await UserModel.create({
      email: b.email.toLowerCase(),
      passwordHash,
      role: "buyer",
      firstName: b.firstName,
      lastName: b.lastName,
      phone: b.phone,
      whatsapp: b.whatsapp ?? b.phone,
      creditBalance: 0,
    });
    const access = signAccessToken(cfg, user);
    const refresh = signRefreshToken(cfg, String(user._id));
    await RefreshTokenModel.create({
      token: refresh,
      userId: user._id,
      expiresAt: refreshExpiryDate(cfg),
    });
    return {
      accessToken: access,
      refreshToken: refresh,
      requiresCheckout: false,
    };
  });

  fastify.post("/auth/register/seller/complete-checkout", async (request, reply) => {
    const parsed = completeCheckoutBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    const stripe = getStripe(cfg);
    if (!stripe) return reply.code(503).send({ error: "stripe_not_configured" });

    let session: import("stripe").Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(parsed.data.sessionId);
    } catch {
      return reply.code(400).send({ error: "invalid_session" });
    }

    const meta = session.metadata ?? {};
    if (meta.kind !== "seller_registration" || !meta.intentId) {
      return reply.code(400).send({ error: "invalid_registration_session" });
    }
    if (session.status !== "complete") {
      return reply.code(400).send({ error: "checkout_not_completed" });
    }

    const intent = await RegistrationIntentModel.findById(meta.intentId);
    if (!intent || intent.kind !== "seller") {
      return reply.code(404).send({ error: "registration_not_found" });
    }
    if (intent.completedUserId) {
      const existing = await UserModel.findById(intent.completedUserId);
      if (!existing) return reply.code(409).send({ error: "registration_state_invalid" });
      const access = signAccessToken(cfg, existing);
      const refresh = signRefreshToken(cfg, String(existing._id));
      await RefreshTokenModel.create({
        token: refresh,
        userId: existing._id,
        expiresAt: refreshExpiryDate(cfg),
      });
      return { accessToken: access, refreshToken: refresh };
    }
    if (intent.stripeCheckoutSessionId && intent.stripeCheckoutSessionId !== session.id) {
      return reply.code(400).send({ error: "session_mismatch" });
    }
    const already = await UserModel.exists({ email: intent.email });
    if (already) return reply.code(409).send({ error: "email_taken" });

    const payload = intent.payload as {
      firstName: string;
      lastName: string;
      phone: string;
      whatsapp?: string;
      tradeType: string;
      plan: "basic" | "vip";
    };
    const user = await UserModel.create({
      email: intent.email,
      passwordHash: intent.passwordHash,
      role: "seller",
      firstName: payload.firstName,
      lastName: payload.lastName,
      phone: payload.phone,
      whatsapp: payload.whatsapp ?? payload.phone,
      tradeType: payload.tradeType,
      displayName: `${payload.firstName} ${payload.lastName}`.trim(),
      subscriptionPlan: payload.plan,
      subscriptionStatus: "trialing",
      stripeCustomerId:
        typeof session.customer === "string" ? session.customer : session.customer?.id ?? null,
      stripeSubscriptionId:
        typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null,
      trialEndsAt: new Date(Date.now() + cfg.SELLER_TRIAL_PERIOD_DAYS * 86_400_000),
    });
    intent.completedUserId = user._id;
    intent.completedAt = new Date();
    await intent.save();

    const access = signAccessToken(cfg, user);
    const refresh = signRefreshToken(cfg, String(user._id));
    await RefreshTokenModel.create({
      token: refresh,
      userId: user._id,
      expiresAt: refreshExpiryDate(cfg),
    });
    return { accessToken: access, refreshToken: refresh };
  });

  fastify.post("/auth/register/buyer/complete-checkout", async (request, reply) => {
    const parsed = completeCheckoutBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    const stripe = getStripe(cfg);
    if (!stripe) return reply.code(503).send({ error: "stripe_not_configured" });

    let session: import("stripe").Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(parsed.data.sessionId);
    } catch {
      return reply.code(400).send({ error: "invalid_session" });
    }
    const meta = session.metadata ?? {};
    if (meta.kind !== "buyer_registration" || !meta.intentId) {
      return reply.code(400).send({ error: "invalid_registration_session" });
    }
    if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
      return reply.code(400).send({ error: "checkout_not_paid" });
    }

    const intent = await RegistrationIntentModel.findById(meta.intentId);
    if (!intent || intent.kind !== "buyer") {
      return reply.code(404).send({ error: "registration_not_found" });
    }
    if (intent.completedUserId) {
      const existing = await UserModel.findById(intent.completedUserId);
      if (!existing) return reply.code(409).send({ error: "registration_state_invalid" });
      const access = signAccessToken(cfg, existing);
      const refresh = signRefreshToken(cfg, String(existing._id));
      await RefreshTokenModel.create({
        token: refresh,
        userId: existing._id,
        expiresAt: refreshExpiryDate(cfg),
      });
      return { accessToken: access, refreshToken: refresh };
    }
    if (intent.stripeCheckoutSessionId && intent.stripeCheckoutSessionId !== session.id) {
      return reply.code(400).send({ error: "session_mismatch" });
    }
    const already = await UserModel.exists({ email: intent.email });
    if (already) return reply.code(409).send({ error: "email_taken" });

    const payload = intent.payload as {
      firstName: string;
      lastName: string;
      phone: string;
      whatsapp?: string;
      credits: number;
    };
    const user = await UserModel.create({
      email: intent.email,
      passwordHash: intent.passwordHash,
      role: "buyer",
      firstName: payload.firstName,
      lastName: payload.lastName,
      phone: payload.phone,
      whatsapp: payload.whatsapp ?? payload.phone,
      creditBalance: payload.credits,
    });
    intent.completedUserId = user._id;
    intent.completedAt = new Date();
    await intent.save();

    const access = signAccessToken(cfg, user);
    const refresh = signRefreshToken(cfg, String(user._id));
    await RefreshTokenModel.create({
      token: refresh,
      userId: user._id,
      expiresAt: refreshExpiryDate(cfg),
    });
    return { accessToken: access, refreshToken: refresh };
  });

  /**
   * Forgot-password flow per product spec:
   *   1. Verify the email exists in the DB (return `email_not_found` if not).
   *   2. Refuse password reset for admin accounts (`admin_reset_not_allowed`).
   *   3. Generate a one-hour, single-use token (random 32 bytes, only the SHA-256 hash is persisted).
   *   4. Email the user a `${DASHBOARD_ORIGIN}/reset-password?token=...` link.
   *   5. Respond with a fixed `reset_email_sent` message so the UI can show "we emailed you" copy.
   */
  fastify.post("/auth/forgot-password", async (request, reply) => {
    const parsed = forgotPasswordBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    const email = parsed.data.email.toLowerCase();

    const adminEmail = cfg.ADMIN_EMAIL?.toLowerCase();
    if (adminEmail && email === adminEmail) {
      request.log.warn({ email }, "forgot_password_blocked_admin_email");
      return reply.code(403).send({ error: "admin_reset_not_allowed" });
    }

    const user = await UserModel.findOne({ email });
    if (!user) {
      request.log.info({ email }, "forgot_password_unknown_email");
      return reply.code(404).send({ error: "email_not_found" });
    }
    if (user.role === "admin") {
      request.log.warn({ email }, "forgot_password_blocked_admin_role");
      return reply.code(403).send({ error: "admin_reset_not_allowed" });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashResetToken(token);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await UserModel.updateOne(
      { _id: user._id },
      { $set: { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: expiresAt } }
    );

    const origin = dashboardOrigin(cfg);
    const resetUrl = `${origin}/reset-password?token=${encodeURIComponent(token)}`;
    const transport = createTransport(cfg);
    const from = formatEmailFrom(cfg);
    if (transport && from) {
      try {
        await sendPasswordResetEmail({
          transport,
          from,
          to: user.email,
          resetUrl,
          recipientName:
            [user.firstName, user.lastName].filter((s): s is string => Boolean(s)).join(" ") ||
            undefined,
        });
      } catch (err) {
        request.log.error({ err }, "forgot_password_email_failed");
        return reply.code(502).send({ error: "email_send_failed" });
      }
    } else {
      request.log.warn(
        { resetUrl, email: user.email },
        "password_reset_link (configure BREVO_API_KEY and EMAIL_FROM_ADDRESS to email users)"
      );
    }

    return {
      ok: true,
      message: "reset_email_sent",
      expiresInMinutes: 60,
    };
  });

  /**
   * Lightweight, public token check used by `/reset-password` on mount so we can show
   * an "invalid / expired" screen before the user fills out the form. The token is not
   * consumed here — only `/auth/reset-password` (POST) clears it.
   */
  fastify.get("/auth/reset-password/validate", async (request, reply) => {
    const q = (request.query ?? {}) as { token?: string };
    const token = typeof q.token === "string" ? q.token : "";
    if (!token || token.length < 16) {
      return reply.code(400).send({ ok: false, error: "invalid_or_expired_token" });
    }
    const tokenHash = hashResetToken(token);
    const user = await UserModel.findOne({
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: { $gt: new Date() },
    }).lean();
    if (!user) {
      return reply.code(400).send({ ok: false, error: "invalid_or_expired_token" });
    }
    if (user.role === "admin") {
      return reply.code(403).send({ ok: false, error: "admin_reset_not_allowed" });
    }
    return {
      ok: true,
      expiresAt: user.passwordResetExpiresAt
        ? new Date(user.passwordResetExpiresAt).toISOString()
        : null,
    };
  });

  fastify.post("/auth/reset-password", async (request, reply) => {
    const parsed = resetPasswordBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    const { token, password } = parsed.data;
    const tokenHash = hashResetToken(token);
    const user = await UserModel.findOne({
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: { $gt: new Date() },
    });
    if (!user) {
      return reply.code(400).send({ error: "invalid_or_expired_token" });
    }
    if (user.role === "admin") {
      // Defence-in-depth: admins cannot ever consume a reset token, even if one
      // somehow ended up in the DB.
      user.passwordResetTokenHash = null;
      user.passwordResetExpiresAt = null;
      await user.save();
      return reply.code(403).send({ error: "admin_reset_not_allowed" });
    }
    user.passwordHash = await hashPassword(password);
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;
    await user.save();
    await RefreshTokenModel.deleteMany({ userId: user._id });
    return { ok: true, message: "password_updated" };
  });

  fastify.post("/auth/login", async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    const user = await UserModel.findOne({ email: parsed.data.email.toLowerCase() });
    if (!user) return reply.code(401).send({ error: "invalid_credentials" });
    if (user.accountBlocked) return reply.code(403).send({ error: "account_blocked" });
    const ok = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!ok) return reply.code(401).send({ error: "invalid_credentials" });

    const access = signAccessToken(cfg, user);
    const refresh = signRefreshToken(cfg, String(user._id));
    await RefreshTokenModel.create({
      token: refresh,
      userId: user._id,
      expiresAt: refreshExpiryDate(cfg),
    });

    return {
      accessToken: access,
      refreshToken: refresh,
      role: user.role,
      userId: String(user._id),
    };
  });

  fastify.post("/auth/refresh", async (request, reply) => {
    const parsed = refreshBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation" });
    }
    try {
      const userId = verifyRefreshToken(cfg, parsed.data.refreshToken);
      const stored = await RefreshTokenModel.findOne({
        token: parsed.data.refreshToken,
        userId,
      });
      if (!stored || stored.expiresAt < new Date()) {
        return reply.code(401).send({ error: "invalid_refresh" });
      }
      await RefreshTokenModel.deleteOne({ _id: stored._id });
      const user = await UserModel.findById(userId);
      if (!user) return reply.code(401).send({ error: "invalid_user" });
      if (user.accountBlocked) return reply.code(403).send({ error: "account_blocked" });
      const access = signAccessToken(cfg, user);
      const refresh = signRefreshToken(cfg, String(user._id));
      await RefreshTokenModel.create({
        token: refresh,
        userId: user._id,
        expiresAt: refreshExpiryDate(cfg),
      });
      return { accessToken: access, refreshToken: refresh };
    } catch {
      return reply.code(401).send({ error: "invalid_refresh" });
    }
  });

  fastify.get(
    "/auth/me",
    { preHandler: (request, reply) => authenticate(cfg, request, reply) },
    async (request, reply) => {
      const user = await UserModel.findById(request.authUser!.id).lean();
      if (!user) return reply.code(404).send({ error: "gone" });
      return {
        id: String(user._id),
        email: user.email,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        whatsapp: user.whatsapp,
        tradeType: user.tradeType,
        subscriptionPlan: user.subscriptionPlan,
        subscriptionStatus: user.subscriptionStatus,
        trialEndsAt: user.trialEndsAt ? user.trialEndsAt.toISOString() : null,
        creditBalance: user.creditBalance,
        accountBlocked: user.accountBlocked ?? false,
        subscriptionCancelAtPeriodEnd: user.subscriptionCancelAtPeriodEnd ?? false,
        subscriptionCurrentPeriodEnd: user.subscriptionCurrentPeriodEnd
          ? user.subscriptionCurrentPeriodEnd.toISOString()
          : null,
        stripeSubscriptionId: user.role === "seller" ? user.stripeSubscriptionId ?? null : null,
      };
    }
  );
}
