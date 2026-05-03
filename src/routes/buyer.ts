import type { FastifyInstance } from "fastify";
import { Types } from "mongoose";
import { z } from "zod";

import type { Config } from "../config.js";
import { authenticate } from "../auth-middleware.js";
import { createBuyerCreditsCheckoutSession } from "../lib/buyer-credits-checkout.js";
import { fulfillBuyerCreditsFromCheckoutSession } from "../lib/fulfill-buyer-credits.js";
import { getStripe } from "../lib/stripe-client.js";
import { createTransport, sendSellerInquiryNotification } from "../lib/mail.js";
import { InquiryModel } from "../models/Inquiry.js";
import { InvoiceModel } from "../models/Invoice.js";
import { ListingModel } from "../models/Listing.js";
import { UserModel } from "../models/User.js";
import {
  isSellerProfileUnlockingEnabled,
  SELLER_PROFILE_UNLOCKING_DISABLED_MESSAGE,
} from "../lib/platform-settings.js";
import { UnlockEventModel } from "../models/UnlockEvent.js";

const creditsCheckoutBody = z.object({
  credits: z.number().int().min(1).max(500),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

const fulfillSessionBody = z.object({
  sessionId: z.string().min(1),
});

const objectIdString = z.string().refine((s) => Types.ObjectId.isValid(s), {
  message: "invalid_object_id",
});

const unlockBody = z.object({
  sellerId: objectIdString,
});

const inquiryBody = z.object({
  sellerId: objectIdString,
  listingSlug: z.string().optional(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(4),
  whatsapp: z.string().optional(),
  tradeInfo: z.string().optional(),
  locationLabel: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});


export async function registerBuyerRoutes(fastify: FastifyInstance, cfg: Config) {
  const buyerOnly = async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) =>
    authenticate(cfg, request, reply, ["buyer"]);

  async function readBuyerCredits(userId: string): Promise<number> {
    const u = await UserModel.findById(userId).select("creditBalance").lean();
    return typeof u?.creditBalance === "number" ? u.creditBalance : 0;
  }

  fastify.get("/buyer/dashboard/summary", { preHandler: buyerOnly }, async (request) => {
    const buyerId = request.authUser!.id;
    const buyerOid = new Types.ObjectId(buyerId);

    /** Permanent unlocks: one row per buyer–seller pair; never expires or auto-resets. */
    const unlocks = await UnlockEventModel.find({ buyerId: buyerOid }).lean();
    const unlockedSellerIds = new Set(unlocks.map((u) => String(u.sellerId)));

    const invoices = await InvoiceModel.find({ userId: buyerOid }).sort({ createdAt: -1 }).limit(50).lean();

    const user = await UserModel.findById(buyerOid).lean();

    const allApproved = await ListingModel.find({ status: "approved", active: true }).lean();
    const teaser = allApproved.map((l) => ({
      id: String(l._id),
      slug: l.slug,
      displayName: l.companyName?.trim() || l.tradeCategory,
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
      sellerId: String(l.sellerId),
      unlocked: unlockedSellerIds.has(String(l.sellerId)),
    }));

    const inquiries = await InquiryModel.find({ buyerId: buyerOid })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const sellerProfileUnlockingEnabled = await isSellerProfileUnlockingEnabled();

    return {
      creditBalance: user?.creditBalance ?? 0,
      sellerProfileUnlockingEnabled,
      sellerProfileUnlockingDisabledMessage: sellerProfileUnlockingEnabled
        ? null
        : SELLER_PROFILE_UNLOCKING_DISABLED_MESSAGE,
      unlocks: unlocks.map((u) => ({ sellerId: String(u.sellerId), createdAt: u.createdAt })),
      teaserListings: teaser,
      invoices: invoices.map((inv) => ({
        id: String(inv._id),
        type: inv.type,
        amountCents: inv.amountCents,
        currency: inv.currency,
        description: inv.description,
        metadata: inv.metadata,
        stripeCheckoutSessionId: inv.stripeCheckoutSessionId,
        createdAt: inv.createdAt,
      })),
      inquiries: inquiries.map((i) => ({
        id: String(i._id),
        sellerId: String(i.sellerId),
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
    };
  });

  fastify.post("/buyer/credits/checkout-session", { preHandler: buyerOnly }, async (request, reply) => {
    const parsed = creditsCheckoutBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    const stripe = getStripe(cfg);
    if (!stripe) {
      return { url: null as string | null, sessionId: null as string | null };
    }

    const credits = parsed.data.credits;
    const buyer = await UserModel.findById(request.authUser!.id);
    if (!buyer) return reply.code(401).send({ error: "gone" });

    const session = await createBuyerCreditsCheckoutSession(stripe, cfg, {
      buyerId: String(buyer._id),
      buyerEmail: buyer.email,
      credits,
      successUrl: parsed.data.successUrl,
      cancelUrl: parsed.data.cancelUrl,
    });

    return { url: session.url, sessionId: session.id };
  });

  /** Confirms a Checkout Session with Stripe and grants credits (fallback when webhooks are not delivered, e.g. local dev). */
  fastify.post("/buyer/credits/fulfill-session", { preHandler: buyerOnly }, async (request, reply) => {
    const parsed = fulfillSessionBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    const stripe = getStripe(cfg);
    if (!stripe) {
      return reply.code(503).send({ error: "stripe_not_configured" });
    }
    let session: import("stripe").Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(parsed.data.sessionId);
    } catch {
      return reply.code(400).send({ error: "invalid_session" });
    }
    const meta = session.metadata ?? {};
    if (String(meta.userId) !== String(request.authUser!.id)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const result = await fulfillBuyerCreditsFromCheckoutSession(session, cfg);
    return { result };
  });

  /** Persists a permanent unlock for this buyer–seller pair (stored until explicitly removed by admins only). */
  fastify.post("/buyer/unlock", { preHandler: buyerOnly }, async (request, reply) => {
    const parsed = unlockBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    if (!(await isSellerProfileUnlockingEnabled())) {
      return reply.code(403).send({
        error: "unlocking_disabled",
        message: SELLER_PROFILE_UNLOCKING_DISABLED_MESSAGE,
      });
    }
    const sellerId = parsed.data.sellerId;
    const buyerId = request.authUser!.id;
    const buyerOid = new Types.ObjectId(buyerId);
    const sellerOid = new Types.ObjectId(sellerId);

    const listing = await ListingModel.findOne({
      sellerId: sellerOid,
      status: "approved",
      active: true,
    }).lean();
    if (!listing) return reply.code(404).send({ error: "seller_not_listed" });

    const existing = await UnlockEventModel.findOne({ buyerId: buyerOid, sellerId: sellerOid });
    if (existing) {
      return {
        ok: true,
        alreadyUnlocked: true,
        sellerId,
        slug: listing.slug,
        creditBalance: await readBuyerCredits(buyerId),
      };
    }

    const buyerDoc = await UserModel.findById(buyerId);
    if (!buyerDoc || buyerDoc.role !== "buyer") {
      return reply.code(401).send({ error: "gone" });
    }

    const dec = await UserModel.findOneAndUpdate(
      { _id: buyerId, role: "buyer", creditBalance: { $gte: 1 } },
      { $inc: { creditBalance: -1 } },
      { new: true }
    );
    if (!dec) {
      return reply.code(400).send({ error: "insufficient_credits" });
    }

    try {
      await UnlockEventModel.create({
        buyerId: buyerOid,
        sellerId: sellerOid,
        listingId: listing._id,
        creditsUsed: 1,
      });
    } catch (e: unknown) {
      await UserModel.findByIdAndUpdate(buyerId, { $inc: { creditBalance: 1 } });
      if (e && typeof e === "object" && "code" in e && (e as { code?: number }).code === 11000) {
        return {
          ok: true,
          alreadyUnlocked: true,
          sellerId,
          slug: listing.slug,
          creditBalance: await readBuyerCredits(buyerId),
        };
      }
      throw e;
    }

    return {
      ok: true,
      sellerId,
      slug: listing.slug,
      creditBalance: dec.creditBalance ?? 0,
    };
  });

  fastify.post("/buyer/inquiries", { preHandler: buyerOnly }, async (request, reply) => {
    const parsed = inquiryBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    const b = parsed.data;
    const buyerId = request.authUser!.id;

    const unlocked = await UnlockEventModel.exists({
      buyerId: new Types.ObjectId(buyerId),
      sellerId: new Types.ObjectId(b.sellerId),
    });
    if (!unlocked) return reply.code(403).send({ error: "unlock_required" });

    let listingId = null as Types.ObjectId | null;
    if (b.listingSlug) {
      const l = await ListingModel.findOne({
        slug: b.listingSlug,
        sellerId: new Types.ObjectId(b.sellerId),
        status: "approved",
      });
      if (l) listingId = l._id;
    }

    const doc = await InquiryModel.create({
      buyerId,
      sellerId: b.sellerId,
      listingId,
      firstName: b.firstName,
      lastName: b.lastName,
      email: b.email,
      phone: b.phone,
      whatsapp: b.whatsapp,
      tradeInfo: b.tradeInfo,
      locationLabel: b.locationLabel,
      lat: b.lat,
      lng: b.lng,
    });

    try {
      const seller = await UserModel.findById(b.sellerId).lean();
      const transport = createTransport(cfg);
      if (transport && cfg.SMTP_FROM && seller?.email) {
        await sendSellerInquiryNotification({
          transport,
          from: cfg.SMTP_FROM,
          to: seller.email,
          inquiry: {
            firstName: b.firstName,
            lastName: b.lastName,
            email: b.email,
            phone: b.phone,
            whatsapp: b.whatsapp,
            tradeInfo: b.tradeInfo,
            locationLabel: b.locationLabel,
            listingSlug: b.listingSlug,
          },
        });
      }
    } catch (err) {
      request.log.error({ err }, "seller_inquiry_email_failed");
    }

    return { ok: true, id: String(doc._id) };
  });
}
