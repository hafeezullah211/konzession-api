import type { FastifyInstance } from "fastify";
import { Types } from "mongoose";
import { z } from "zod";

import type { Config } from "../config.js";
import { authenticate } from "../auth-middleware.js";
import { parsePageLimitQuery, totalPages } from "../lib/pagination.js";
import { sellerMonthlyAmountCents } from "../lib/seller-plan-amount.js";
import { uniqueSlug } from "../lib/slug.js";
import { InquiryModel } from "../models/Inquiry.js";
import { InvoiceModel } from "../models/Invoice.js";
import { ListingModel } from "../models/Listing.js";
import { UserModel } from "../models/User.js";

const createListingBody = z.object({
  tradeCategory: z.string().min(1),
  tradeCategoryDe: z.string().optional(),
  companyName: z.string().optional(),
  summary: z.string().optional(),
  summaryDe: z.string().optional(),
  gisaNumber: z.string().optional(),
  authority: z.string().optional(),
  addressLine: z.string().optional(),
  city: z.string().optional(),
  bundesland: z.string().optional(),
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSellerListingsQuery(qs: Record<string, unknown>) {
  const qRaw = typeof qs.q === "string" ? qs.q.trim() : "";
  const q = qRaw.length > 200 ? qRaw.slice(0, 200) : qRaw;
  const pageRaw = parseInt(String(qs.page ?? "1"), 10);
  const limitRaw = parseInt(String(qs.limit ?? "10"), 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 10_000) : 1;
  const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 10;
  return { q: q.length ? q : undefined, page, limit };
}

export async function registerSellerRoutes(fastify: FastifyInstance, cfg: Config) {
  const sellerOnly = async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) =>
    authenticate(cfg, request, reply, ["seller"]);

  fastify.get("/seller/dashboard/summary", { preHandler: sellerOnly }, async (request, _reply) => {
    const sellerId = request.authUser!.id;
    const oid = new Types.ObjectId(sellerId);
    const [inquiriesByDay, invoiceAmountByDay, sellerProfile, pendingListings, approvedListings, totalInquiries] =
      await Promise.all([
        InquiryModel.aggregate([
          { $match: { sellerId: oid } },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
          { $limit: 120 },
        ]),
        InvoiceModel.aggregate([
          { $match: { userId: oid } },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } },
              amountCents: { $sum: "$amountCents" },
            },
          },
          { $sort: { _id: 1 } },
          { $limit: 120 },
        ]),
        UserModel.findById(oid).lean(),
        ListingModel.countDocuments({ sellerId: oid, status: "pending" }),
        ListingModel.countDocuments({ sellerId: oid, status: "approved" }),
        InquiryModel.countDocuments({ sellerId: oid }),
      ]);

    const plan = (sellerProfile?.subscriptionPlan === "vip" ? "vip" : "basic") as "basic" | "vip";

    return {
      inquiriesByDay,
      invoiceAmountByDay: invoiceAmountByDay.map((r) => ({
        day: r._id as string,
        amountCents: r.amountCents as number,
      })),
      billing: {
        subscriptionPlan: sellerProfile?.subscriptionPlan ?? null,
        subscriptionStatus: sellerProfile?.subscriptionStatus ?? null,
        trialEndsAt: sellerProfile?.trialEndsAt
          ? new Date(sellerProfile.trialEndsAt).toISOString()
          : null,
        trialPeriodDays: cfg.SELLER_TRIAL_PERIOD_DAYS,
        monthlyAmountCents: sellerMonthlyAmountCents(cfg, plan),
        recurringSubscription: true as const,
        headline:
          "Listing partner subscription is recurring (monthly) after the free trial. Client profile credits are one-time purchases.",
      },
      totals: {
        inquiries: totalInquiries,
      },
      listingCounts: { pending: pendingListings, approved: approvedListings },
    };
  });

  fastify.get("/seller/invoices", { preHandler: sellerOnly }, async (request) => {
    const oid = new Types.ObjectId(request.authUser!.id);
    const { page, limit, skip } = parsePageLimitQuery(
      (request.query ?? {}) as Record<string, unknown>,
      { defaultLimit: 20, maxLimit: 100 }
    );
    const [invoices, total] = await Promise.all([
      InvoiceModel.find({ userId: oid }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      InvoiceModel.countDocuments({ userId: oid }),
    ]);
    return {
      invoices: invoices.map((inv) => ({
        id: String(inv._id),
        type: inv.type,
        amountCents: inv.amountCents,
        currency: inv.currency,
        stripeCheckoutSessionId: inv.stripeCheckoutSessionId,
        stripePaymentIntentId: inv.stripePaymentIntentId,
        stripeInvoiceId: inv.stripeInvoiceId,
        description: inv.description,
        metadata: inv.metadata,
        createdAt: inv.createdAt,
        updatedAt: inv.updatedAt,
      })),
      total,
      page,
      limit,
      totalPages: totalPages(total, limit),
    };
  });

  fastify.get("/seller/inquiries", { preHandler: sellerOnly }, async (request) => {
    const oid = new Types.ObjectId(request.authUser!.id);
    const { page, limit, skip } = parsePageLimitQuery(
      (request.query ?? {}) as Record<string, unknown>,
      { defaultLimit: 20, maxLimit: 100 }
    );
    const [rows, total] = await Promise.all([
      InquiryModel.find({ sellerId: oid }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      InquiryModel.countDocuments({ sellerId: oid }),
    ]);
    return {
      inquiries: rows.map((i) => ({
        id: String(i._id),
        buyerId: String(i.buyerId),
        listingId: i.listingId ? String(i.listingId) : null,
        firstName: i.firstName,
        lastName: i.lastName,
        email: i.email,
        phone: i.phone,
        whatsapp: i.whatsapp,
        tradeInfo: i.tradeInfo,
        locationLabel: i.locationLabel,
        lat: i.lat,
        lng: i.lng,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
      })),
      total,
      page,
      limit,
      totalPages: totalPages(total, limit),
    };
  });

  fastify.post("/seller/listings", { preHandler: sellerOnly }, async (request, reply) => {
    const parsed = createListingBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    const sellerId = request.authUser!.id;
    const base =
      parsed.data.companyName?.trim()?.replace(/\s+/g, "-") ||
      parsed.data.tradeCategory.replace(/\s+/g, "-");
    const slug = await uniqueSlug(base);
    const doc = await ListingModel.create({
      sellerId,
      slug,
      status: "pending",
      tradeCategory: parsed.data.tradeCategory,
      tradeCategoryDe: parsed.data.tradeCategoryDe,
      companyName: parsed.data.companyName,
      summary: parsed.data.summary,
      summaryDe: parsed.data.summaryDe,
      gisaNumber: parsed.data.gisaNumber,
      authority: parsed.data.authority,
      addressLine: parsed.data.addressLine,
      city: parsed.data.city,
      bundesland: parsed.data.bundesland,
    });
    return { id: String(doc._id), slug: doc.slug, status: doc.status };
  });

  fastify.get("/seller/listings", { preHandler: sellerOnly }, async (request) => {
    const { q, page, limit } = parseSellerListingsQuery(
      (request.query ?? {}) as Record<string, unknown>
    );
    const sellerOid = new Types.ObjectId(request.authUser!.id);
    const filter: Record<string, unknown> = { sellerId: sellerOid };
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      filter.$or = [
        { slug: rx },
        { tradeCategory: rx },
        { tradeCategoryDe: rx },
        { companyName: rx },
        { summary: rx },
        { summaryDe: rx },
        { gisaNumber: rx },
        { authority: rx },
        { addressLine: rx },
        { city: rx },
        { bundesland: rx },
      ];
    }
    const skip = (page - 1) * limit;
    const [listings, total] = await Promise.all([
      ListingModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      ListingModel.countDocuments(filter),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return {
      listings: listings.map((l) => ({
        id: String(l._id),
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
      totalPages,
    };
  });
}
