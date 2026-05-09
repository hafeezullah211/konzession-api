import type { FastifyInstance } from "fastify";
import { Types } from "mongoose";
import { z } from "zod";

import type { Config } from "../config.js";
import { authenticate } from "../auth-middleware.js";
import { getStripe } from "../lib/stripe-client.js";
import { parsePageLimitQuery, totalPages } from "../lib/pagination.js";
import {
  isSellerProfileUnlockingEnabled,
  setSellerProfileUnlockingEnabled,
} from "../lib/platform-settings.js";
import { ContactSubmissionModel } from "../models/ContactSubmission.js";
import { CreditTransactionModel } from "../models/CreditTransaction.js";
import { InquiryModel } from "../models/Inquiry.js";
import { InvoiceModel } from "../models/Invoice.js";
import { ListingModel } from "../models/Listing.js";
import { RefreshTokenModel } from "../models/RefreshToken.js";
import { UnlockEventModel } from "../models/UnlockEvent.js";
import { UserModel } from "../models/User.js";

async function deleteUserAndRelatedData(
  cfg: Config,
  userId: Types.ObjectId,
  stripeSubscriptionId: string | null | undefined
): Promise<void> {
  const stripe = getStripe(cfg);
  if (stripe && stripeSubscriptionId) {
    try {
      await stripe.subscriptions.cancel(stripeSubscriptionId);
    } catch {
      /* already removed */
    }
  }
  await RefreshTokenModel.deleteMany({ userId });
  await UnlockEventModel.deleteMany({ $or: [{ buyerId: userId }, { sellerId: userId }] });
  await InquiryModel.deleteMany({ $or: [{ buyerId: userId }, { sellerId: userId }] });
  await InvoiceModel.deleteMany({ userId });
  await CreditTransactionModel.deleteMany({ buyerId: userId });
  await ListingModel.deleteMany({ sellerId: userId });
  await UserModel.deleteOne({ _id: userId });
}

export async function registerAdminRoutes(fastify: FastifyInstance, cfg: Config) {
  const adminOnly = async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) =>
    authenticate(cfg, request, reply, ["admin"]);

  fastify.get("/admin/stats", { preHandler: adminOnly }, async () => {
    const [sellers, buyers, invoices, inquiriesByDay, invoiceAmountByDay] = await Promise.all([
      UserModel.countDocuments({ role: "seller" }),
      UserModel.countDocuments({ role: "buyer" }),
      InvoiceModel.aggregate([
        {
          $group: {
            _id: null,
            totalCents: { $sum: "$amountCents" },
          },
        },
      ]),
      InquiryModel.aggregate([
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
        { $limit: 120 },
      ]),
      InvoiceModel.aggregate([
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" },
            },
            amountCents: { $sum: "$amountCents" },
          },
        },
        { $sort: { _id: 1 } },
        { $limit: 120 },
      ]),
    ]);
    const inquiries = await InquiryModel.countDocuments();
    const pendingListings = await ListingModel.countDocuments({ status: "pending" });
    const contacts = await ContactSubmissionModel.countDocuments();

    return {
      users: { sellers, buyers },
      revenueCents: invoices[0]?.totalCents ?? 0,
      inquiries,
      pendingListings,
      contactSubmissions: contacts,
      inquiriesByDay: inquiriesByDay.map((r) => ({ day: r._id as string, count: r.count as number })),
      invoiceAmountByDay: invoiceAmountByDay.map((r) => ({
        day: r._id as string,
        amountCents: r.amountCents as number,
      })),
    };
  });

  fastify.get<{ Querystring: { role?: string; page?: string; limit?: string } }>(
    "/admin/users",
    { preHandler: adminOnly },
    async (request) => {
      const role = request.query.role as "seller" | "buyer" | undefined;
      const q =
        role === "seller" || role === "buyer" ? { role } : { role: { $in: ["seller", "buyer"] } };
      const { page, limit, skip } = parsePageLimitQuery(
        (request.query ?? {}) as Record<string, unknown>,
        { defaultLimit: 20, maxLimit: 100 }
      );
      const [users, total] = await Promise.all([
        UserModel.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        UserModel.countDocuments(q),
      ]);
      return {
        users: users.map((u) => ({
          id: String(u._id),
          email: u.email,
          role: u.role,
          firstName: u.firstName,
          lastName: u.lastName,
          phone: u.phone,
          tradeType: u.tradeType,
          subscriptionPlan: u.subscriptionPlan,
          subscriptionStatus: u.subscriptionStatus,
          creditBalance: u.creditBalance,
          accountBlocked: u.accountBlocked ?? false,
          subscriptionCancelAtPeriodEnd: u.subscriptionCancelAtPeriodEnd ?? false,
          subscriptionCurrentPeriodEnd: u.subscriptionCurrentPeriodEnd ?? null,
          stripeSubscriptionId: u.stripeSubscriptionId ?? null,
          createdAt: u.createdAt,
        })),
        total,
        page,
        limit,
        totalPages: totalPages(total, limit),
      };
    }
  );

  fastify.get("/admin/contact-submissions", { preHandler: adminOnly }, async (request) => {
    const { page, limit, skip } = parsePageLimitQuery(
      (request.query ?? {}) as Record<string, unknown>,
      { defaultLimit: 20, maxLimit: 100 }
    );
    const [rows, total] = await Promise.all([
      ContactSubmissionModel.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      ContactSubmissionModel.countDocuments(),
    ]);
    return {
      rows: rows.map((r) => ({
        id: String(r._id),
        name: r.name,
        email: r.email,
        phone: r.phone,
        whatsapp: r.whatsapp,
        tradeCategory: r.tradeCategory,
        createdAt: r.createdAt,
      })),
      total,
      page,
      limit,
      totalPages: totalPages(total, limit),
    };
  });

  fastify.get("/admin/listings/pending", { preHandler: adminOnly }, async (request) => {
    const { page, limit, skip } = parsePageLimitQuery(
      (request.query ?? {}) as Record<string, unknown>,
      { defaultLimit: 20, maxLimit: 100 }
    );
    const filter = { status: "pending" as const };
    const [listings, total] = await Promise.all([
      ListingModel.find(filter).sort({ createdAt: 1 }).skip(skip).limit(limit).lean(),
      ListingModel.countDocuments(filter),
    ]);
    return {
      listings: listings.map((l) => ({
        id: String(l._id),
        sellerId: String(l.sellerId),
        slug: l.slug,
        status: l.status,
        active: l.active,
        tradeCategory: l.tradeCategory,
        tradeCategoryDe: l.tradeCategoryDe,
        companyName: l.companyName,
        summary: l.summary,
        summaryDe: l.summaryDe,
        gisaNumber: l.gisaNumber,
        authority: l.authority,
        addressLine: l.addressLine,
        city: l.city,
        bundesland: l.bundesland,
        adminNote: l.adminNote,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
      })),
      total,
      page,
      limit,
      totalPages: totalPages(total, limit),
    };
  });

  const idParam = z.object({ id: z.string().min(1) });
  const noteBody = z.object({ note: z.string().optional() });

  fastify.post<{ Params: { id: string }; Body: unknown }>(
    "/admin/listings/:id/approve",
    { preHandler: adminOnly },
    async (request, reply) => {
      const p = idParam.safeParse(request.params);
      if (!p.success) return reply.code(400).send({ error: "bad_id" });
      const doc = await ListingModel.findById(p.data.id);
      if (!doc) return reply.code(404).send({ error: "not_found" });
      doc.status = "approved";
      doc.adminNote = noteBody.safeParse(request.body).data?.note ?? doc.adminNote;
      await doc.save();
      return { ok: true };
    }
  );

  fastify.post<{ Params: { id: string }; Body: unknown }>(
    "/admin/listings/:id/reject",
    { preHandler: adminOnly },
    async (request, reply) => {
      const p = idParam.safeParse(request.params);
      if (!p.success) return reply.code(400).send({ error: "bad_id" });
      const parsedNote = noteBody.safeParse(request.body);
      const doc = await ListingModel.findById(p.data.id);
      if (!doc) return reply.code(404).send({ error: "not_found" });
      doc.status = "rejected";
      if (parsedNote.success) doc.adminNote = parsedNote.data.note;
      await doc.save();
      return { ok: true };
    }
  );

  fastify.get("/admin/unlocks", { preHandler: adminOnly }, async (request) => {
    const { page, limit, skip } = parsePageLimitQuery(
      (request.query ?? {}) as Record<string, unknown>,
      { defaultLimit: 20, maxLimit: 100 }
    );
    const [rows, total] = await Promise.all([
      UnlockEventModel.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      UnlockEventModel.countDocuments(),
    ]);
    return {
      rows: rows.map((r) => ({
        buyerId: String(r.buyerId),
        sellerId: String(r.sellerId),
        creditsUsed: r.creditsUsed,
        createdAt: r.createdAt,
      })),
      total,
      page,
      limit,
      totalPages: totalPages(total, limit),
    };
  });

  fastify.get("/admin/credit-transactions", { preHandler: adminOnly }, async (request) => {
    const { page, limit, skip } = parsePageLimitQuery(
      (request.query ?? {}) as Record<string, unknown>,
      { defaultLimit: 20, maxLimit: 100 }
    );
    const [rows, total] = await Promise.all([
      CreditTransactionModel.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CreditTransactionModel.countDocuments(),
    ]);
    return {
      rows: rows.map((r) => ({
        buyerId: String(r.buyerId),
        credits: r.credits,
        amountCents: r.amountCents,
        createdAt: r.createdAt,
      })),
      total,
      page,
      limit,
      totalPages: totalPages(total, limit),
    };
  });

  fastify.get("/admin/platform-settings", { preHandler: adminOnly }, async () => {
    const sellerProfileUnlockingEnabled = await isSellerProfileUnlockingEnabled();
    return { sellerProfileUnlockingEnabled };
  });

  const platformSettingsPatch = z.object({
    sellerProfileUnlockingEnabled: z.boolean(),
  });

  fastify.patch<{ Body: unknown }>("/admin/platform-settings", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = platformSettingsPatch.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    const sellerProfileUnlockingEnabled = await setSellerProfileUnlockingEnabled(
      parsed.data.sellerProfileUnlockingEnabled
    );
    return { sellerProfileUnlockingEnabled };
  });

  const userIdParam = z.object({
    id: z.string().refine((s) => Types.ObjectId.isValid(s), { message: "bad_id" }),
  });
  const accountBlockBody = z.object({
    accountBlocked: z.boolean(),
  });

  fastify.patch<{ Params: { id: string }; Body: unknown }>(
    "/admin/users/:id/account",
    { preHandler: adminOnly },
    async (request, reply) => {
      const p = userIdParam.safeParse(request.params);
      if (!p.success) return reply.code(400).send({ error: "bad_id" });
      const body = accountBlockBody.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "validation", details: body.error.flatten() });
      }
      const adminId = request.authUser!.id;
      if (p.data.id === adminId) return reply.code(400).send({ error: "cannot_modify_self" });

      const target = await UserModel.findById(p.data.id);
      if (!target) return reply.code(404).send({ error: "not_found" });
      if (target.role === "admin") return reply.code(403).send({ error: "cannot_modify_admin" });

      target.accountBlocked = body.data.accountBlocked;
      await target.save();
      if (body.data.accountBlocked) {
        await RefreshTokenModel.deleteMany({ userId: target._id });
      }
      return { ok: true, accountBlocked: target.accountBlocked };
    }
  );

  fastify.delete<{ Params: { id: string } }>("/admin/users/:id", { preHandler: adminOnly }, async (request, reply) => {
    const p = userIdParam.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "bad_id" });
    const adminId = request.authUser!.id;
    if (p.data.id === adminId) return reply.code(400).send({ error: "cannot_delete_self" });

    const target = await UserModel.findById(p.data.id);
    if (!target) return reply.code(404).send({ error: "not_found" });
    if (target.role === "admin") return reply.code(403).send({ error: "cannot_delete_admin" });

    await deleteUserAndRelatedData(cfg, target._id, target.stripeSubscriptionId);
    return { ok: true };
  });

  fastify.post<{ Params: { id: string } }>(
    "/admin/users/:id/cancel-subscription",
    { preHandler: adminOnly },
    async (request, reply) => {
      const p = userIdParam.safeParse(request.params);
      if (!p.success) return reply.code(400).send({ error: "bad_id" });
      const target = await UserModel.findById(p.data.id);
      if (!target || target.role !== "seller") {
        return reply.code(400).send({ error: "seller_only" });
      }
      if (!target.stripeSubscriptionId) {
        return reply.code(400).send({ error: "no_subscription" });
      }
      const stripe = getStripe(cfg);
      if (!stripe) return reply.code(503).send({ error: "stripe_not_configured" });
      try {
        const sub = await stripe.subscriptions.update(target.stripeSubscriptionId, {
          cancel_at_period_end: true,
        });
        target.subscriptionCancelAtPeriodEnd = Boolean(sub.cancel_at_period_end);
        target.subscriptionCurrentPeriodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000)
          : null;
        await target.save();
        return {
          ok: true,
          currentPeriodEnd: target.subscriptionCurrentPeriodEnd?.toISOString() ?? null,
        };
      } catch (err) {
        request.log.error({ err }, "admin_cancel_subscription_failed");
        return reply.code(502).send({ error: "stripe_failed" });
      }
    }
  );
}
