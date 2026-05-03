import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Config } from "../config.js";
import { authenticate } from "../auth-middleware.js";
import {
  isSellerProfileUnlockingEnabled,
  setSellerProfileUnlockingEnabled,
} from "../lib/platform-settings.js";
import { ContactSubmissionModel } from "../models/ContactSubmission.js";
import { CreditTransactionModel } from "../models/CreditTransaction.js";
import { InquiryModel } from "../models/Inquiry.js";
import { InvoiceModel } from "../models/Invoice.js";
import { ListingModel } from "../models/Listing.js";
import { UnlockEventModel } from "../models/UnlockEvent.js";
import { UserModel } from "../models/User.js";

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

  fastify.get<{ Querystring: { role?: string } }>("/admin/users", { preHandler: adminOnly }, async (request) => {
    const role = request.query.role as "seller" | "buyer" | undefined;
    const q =
      role === "seller" || role === "buyer" ? { role } : { role: { $in: ["seller", "buyer"] } };
    const users = await UserModel.find(q).sort({ createdAt: -1 }).limit(500).lean();
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
        createdAt: u.createdAt,
      })),
    };
  });

  fastify.get("/admin/contact-submissions", { preHandler: adminOnly }, async () => {
    const rows = await ContactSubmissionModel.find().sort({ createdAt: -1 }).limit(500).lean();
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
    };
  });

  fastify.get("/admin/listings/pending", { preHandler: adminOnly }, async () => {
    const listings = await ListingModel.find({ status: "pending" })
      .sort({ createdAt: 1 })
      .limit(200)
      .lean();
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

  fastify.get("/admin/unlocks", { preHandler: adminOnly }, async () => {
    const rows = await UnlockEventModel.find().sort({ createdAt: -1 }).limit(300).lean();
    return {
      rows: rows.map((r) => ({
        buyerId: String(r.buyerId),
        sellerId: String(r.sellerId),
        creditsUsed: r.creditsUsed,
        createdAt: r.createdAt,
      })),
    };
  });

  fastify.get("/admin/credit-transactions", { preHandler: adminOnly }, async () => {
    const rows = await CreditTransactionModel.find().sort({ createdAt: -1 }).limit(300).lean();
    return {
      rows: rows.map((r) => ({
        buyerId: String(r.buyerId),
        credits: r.credits,
        amountCents: r.amountCents,
        createdAt: r.createdAt,
      })),
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
}
