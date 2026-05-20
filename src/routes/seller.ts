import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { Types } from "mongoose";
import { z } from "zod";

import type { Config } from "../config.js";
import { authenticate } from "../auth-middleware.js";
import { austriaBundeslandEnum } from "../lib/austria-bundeslaender.js";
import {
  createLicenseImageUploader,
  licenseImageExtension,
  normalizeLicenseImageUrlForBrowser,
} from "../lib/minio-license.js";
import { parsePageLimitQuery, totalPages } from "../lib/pagination.js";
import { evaluateSellerAccess } from "../lib/seller-access.js";
import { sellerMonthlyAmountCents } from "../lib/seller-plan-amount.js";
import { uniqueSlug } from "../lib/slug.js";
import { isValidTradeCategory, tradeCategoryGroupForValue } from "../lib/trade-categories.js";
import { InquiryModel } from "../models/Inquiry.js";
import { InvoiceModel } from "../models/Invoice.js";
import { ListingModel } from "../models/Listing.js";
import { UserModel } from "../models/User.js";

const createListingBody = z.object({
  tradeCategory: z
    .string()
    .trim()
    .min(1)
    .refine((v) => isValidTradeCategory(v), { message: "invalid_trade_category" }),
  tradeCategoryDe: z.string().trim().optional(),
  companyName: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  summaryDe: z.string().trim().optional(),
  addressLine: z.string().trim().min(1),
  city: z.string().trim().min(1),
  bundesland: austriaBundeslandEnum,
  licenseImageUrl: z.string().url().refine((u) => /^https?:\/\//i.test(u), { message: "http_url" }),
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
  await fastify.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });
  const licenseUploader = createLicenseImageUploader(cfg);

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
        houseNumber: i.houseNumber,
        street: i.street,
        postalCode: i.postalCode,
        city: i.city,
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

  fastify.post("/seller/listings/license-image", { preHandler: sellerOnly }, async (request, reply) => {
    if (!licenseUploader) {
      return reply.code(503).send({ error: "minio_not_configured" });
    }
    const sellerId = request.authUser!.id;
    const seller = await UserModel.findById(sellerId)
      .select("role subscriptionStatus trialEndsAt accountBlocked")
      .lean();
    if (!seller) return reply.code(401).send({ error: "invalid_user" });
    const access = evaluateSellerAccess(seller);
    if (!access.allowed) {
      return reply.code(402).send({
        error: "subscription_required",
        reason: access.reason,
        trialEndsAt: access.trialEndsAt ? access.trialEndsAt.toISOString() : null,
        daysLeftInTrial: access.daysLeftInTrial,
      });
    }
    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ error: "file_required" });
    }
    const ext = licenseImageExtension(file.mimetype);
    if (!ext) {
      return reply.code(400).send({ error: "invalid_image_type" });
    }
    const buffer = await file.toBuffer();
    if (!buffer.length) {
      return reply.code(400).send({ error: "empty_file" });
    }
    try {
      const { publicUrl } = await licenseUploader.upload({
        sellerId,
        buffer,
        contentType: file.mimetype,
        extension: ext,
      });
      return { url: publicUrl };
    } catch (err) {
      request.log.error({ err }, "[seller] license-image upload failed");
      return reply.code(500).send({ error: "upload_failed" });
    }
  });

  fastify.post("/seller/listings", { preHandler: sellerOnly }, async (request, reply) => {
    const parsed = createListingBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    const sellerId = request.authUser!.id;
    const seller = await UserModel.findById(sellerId)
      .select("role subscriptionStatus trialEndsAt accountBlocked")
      .lean();
    if (!seller) return reply.code(401).send({ error: "invalid_user" });
    const access = evaluateSellerAccess(seller);
    if (!access.allowed) {
      return reply.code(402).send({
        error: "subscription_required",
        reason: access.reason,
        trialEndsAt: access.trialEndsAt ? access.trialEndsAt.toISOString() : null,
        daysLeftInTrial: access.daysLeftInTrial,
      });
    }
    const base =
      parsed.data.companyName?.trim()?.replace(/\s+/g, "-") ||
      parsed.data.tradeCategory.replace(/\s+/g, "-");
    const slug = await uniqueSlug(base);
    const doc = await ListingModel.create({
      sellerId,
      slug,
      status: "pending",
      tradeCategory: parsed.data.tradeCategory,
      tradeCategoryDe:
        parsed.data.tradeCategoryDe?.trim() ||
        tradeCategoryGroupForValue(parsed.data.tradeCategory)?.labelDe ||
        undefined,
      companyName: parsed.data.companyName,
      summary: parsed.data.summary,
      summaryDe: parsed.data.summaryDe?.trim() || undefined,
      addressLine: parsed.data.addressLine,
      city: parsed.data.city,
      bundesland: parsed.data.bundesland,
      licenseImageUrl: parsed.data.licenseImageUrl,
    });
    return { id: String(doc._id), slug: doc.slug, status: doc.status };
  });

  /**
   * Lightweight read-only endpoint the seller dashboard polls to render the
   * trial banner, paywall state, and to gate the "Add listing" / "Inquiries"
   * UI without having to hit a write endpoint first.
   */
  fastify.get("/seller/access", { preHandler: sellerOnly }, async (request, reply) => {
    const sellerId = request.authUser!.id;
    const seller = await UserModel.findById(sellerId)
      .select("role subscriptionStatus subscriptionPlan trialEndsAt accountBlocked")
      .lean();
    if (!seller) return reply.code(401).send({ error: "invalid_user" });
    const access = evaluateSellerAccess(seller);
    return {
      allowed: access.allowed,
      reason: access.reason,
      subscriptionStatus: seller.subscriptionStatus ?? "none",
      subscriptionPlan: seller.subscriptionPlan ?? null,
      trialEndsAt: access.trialEndsAt ? access.trialEndsAt.toISOString() : null,
      daysLeftInTrial: access.daysLeftInTrial,
      trialPeriodDays: cfg.SELLER_TRIAL_PERIOD_DAYS,
    };
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
        addressLine: l.addressLine,
        city: l.city,
        bundesland: l.bundesland,
        licenseImageUrl: normalizeLicenseImageUrlForBrowser(cfg, l.licenseImageUrl),
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
