import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { authenticate } from "../auth-middleware.js";
import type { Config } from "../config.js";
import { hashPassword, verifyPassword } from "../lib/auth-hash.js";
import { createTransport, sendPasswordResetEmail } from "../lib/mail.js";
import { getStripe } from "../lib/stripe-client.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../lib/jwt.js";
import { RefreshTokenModel } from "../models/RefreshToken.js";
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
    plan: z.enum(["basic", "vip"]),
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
  fastify.post("/auth/register/seller", async (request, reply) => {
    const parsed = registerSellerBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    const b = parsed.data;
    const exists = await UserModel.exists({ email: b.email.toLowerCase() });
    if (exists) return reply.code(409).send({ error: "email_taken" });

    const passwordHash = await hashPassword(b.password);
    const stripeReady = Boolean(getStripe(cfg));
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
      subscriptionPlan: b.plan,
      subscriptionStatus: stripeReady ? "pending_checkout" : "trialing",
      trialEndsAt: stripeReady
        ? undefined
        : new Date(Date.now() + cfg.SELLER_TRIAL_PERIOD_DAYS * 86_400_000),
    });

    const access = signAccessToken(cfg, user);
    const refresh = signRefreshToken(cfg, String(user._id));
    await RefreshTokenModel.create({
      token: refresh,
      userId: user._id,
      expiresAt: refreshExpiryDate(cfg),
    });

    return {
      userId: String(user._id),
      plan: b.plan,
      accessToken: access,
      refreshToken: refresh,
      message: "complete_checkout",
    };
  });

  fastify.post("/auth/register/buyer", async (request, reply) => {
    const parsed = registerBuyerBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    const b = parsed.data;
    const exists = await UserModel.exists({ email: b.email.toLowerCase() });
    if (exists) return reply.code(409).send({ error: "email_taken" });

    const passwordHash = await hashPassword(b.password);
    const stripeConfigured = Boolean(getStripe(cfg));

    const user = await UserModel.create({
      email: b.email.toLowerCase(),
      passwordHash,
      role: "buyer",
      firstName: b.firstName,
      lastName: b.lastName,
      phone: b.phone,
      whatsapp: b.whatsapp ?? b.phone,
      /** Each profile unlock costs one credit (€5). Offline dev without Stripe grants complimentary credits. */
      creditBalance: stripeConfigured ? 0 : 10,
    });

    const access = signAccessToken(cfg, user);
    const refresh = signRefreshToken(cfg, String(user._id));
    await RefreshTokenModel.create({
      token: refresh,
      userId: user._id,
      expiresAt: refreshExpiryDate(cfg),
    });

    return { accessToken: access, refreshToken: refresh };
  });

  fastify.post("/auth/forgot-password", async (request, reply) => {
    const parsed = forgotPasswordBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    const email = parsed.data.email.toLowerCase();
    const user = await UserModel.findOne({ email });
    const generic = {
      ok: true,
      message: "If an account exists for this email, you will receive password reset instructions shortly.",
    };

    if (!user) {
      request.log.info({ email }, "forgot_password_unknown_email");
      return generic;
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
    if (transport && cfg.SMTP_FROM) {
      try {
        await sendPasswordResetEmail({
          transport,
          from: cfg.SMTP_FROM,
          to: user.email,
          resetUrl,
        });
      } catch (err) {
        request.log.error({ err }, "forgot_password_email_failed");
      }
    } else {
      request.log.warn({ resetUrl, email: user.email }, "password_reset_link (configure SMTP to email users)");
    }

    return generic;
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
      };
    }
  );
}
