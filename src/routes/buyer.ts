import type { FastifyInstance } from "fastify";
import { Types } from "mongoose";
import { z } from "zod";

import type { Config } from "../config.js";
import { authenticate } from "../auth-middleware.js";
import { createBuyerCreditsCheckoutSession } from "../lib/buyer-credits-checkout.js";
import { fulfillBuyerCreditsFromCheckoutSession } from "../lib/fulfill-buyer-credits.js";
import { evaluateSellerAccess } from "../lib/seller-access.js";
import { getStripe } from "../lib/stripe-client.js";
import { createTransport, sendSellerInquiryNotification } from "../lib/mail.js";
import { InquiryModel } from "../models/Inquiry.js";
import { InvoiceModel } from "../models/Invoice.js";
import { ListingModel } from "../models/Listing.js";
import { UserModel } from "../models/User.js";
import { parsePageLimitQuery, totalPages } from "../lib/pagination.js";
import {
  isSellerProfileUnlockingEnabled,
  SELLER_PROFILE_UNLOCKING_DISABLED_MESSAGE,
} from "../lib/platform-settings.js";
import { UnlockEventModel } from "../models/UnlockEvent.js";
import { formatInquiryAddressLine } from "../lib/inquiry-address.js";
import { normalizeLicenseImageUrlForBrowser } from "../lib/minio-license.js";
import { AUSTRIA_BUNDESLAENDER } from "../lib/austria-bundeslaender.js";

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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstQueryString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

/**
 * Builds the Mongo filter for the buyer-directory teaser list. Mirrors the
 * landing page's `/public/listings/search` semantics: `state` narrows by
 * Bundesland, `q` does case-insensitive substring search across the listing's
 * public-safe fields. Locked teasers still get scrubbed by `listingToTeaser`.
 */
function buildDirectoryListingFilter(
  qs: Record<string, unknown>
): { filter: Record<string, unknown>; q: string; state: string } {
  const filter: Record<string, unknown> = { status: "approved", active: true };

  const stateRaw = firstQueryString(qs.state) ?? "all";
  const state =
    stateRaw === "all" || (AUSTRIA_BUNDESLAENDER as readonly string[]).includes(stateRaw)
      ? stateRaw
      : "all";
  if (state !== "all") {
    filter.bundesland = state;
  }

  const qRaw = firstQueryString(qs.q) ?? "";
  const q = qRaw.trim().slice(0, 200);
  if (q.length > 0) {
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

  return { filter, q, state };
}

/**
 * Unlock is per-listing. Either `listingId` or (`sellerId` + `listingSlug`) is
 * required so older client builds keep working until they migrate.
 */
const unlockBody = z
  .object({
    listingId: objectIdString.optional(),
    sellerId: objectIdString.optional(),
    listingSlug: z.string().optional(),
  })
  .refine((v) => Boolean(v.listingId) || Boolean(v.listingSlug), {
    message: "listing_required",
  });

/**
 * Inquiries also gate on a per-listing unlock — buyers must unlock the exact
 * listing they want to message about, not just any listing of the seller.
 */
const inquiryBody = z.object({
  sellerId: objectIdString,
  listingId: objectIdString.optional(),
  listingSlug: z.string().optional(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(4),
  whatsapp: z.string().optional(),
  tradeInfo: z.string().optional(),
  houseNumber: z.string().optional(),
  street: z.string().optional(),
  postalCode: z.string().optional(),
  city: z.string().optional(),
});

/**
 * Locked teasers expose only public-safe identity (display label, slug, trade
 * category). Sensitive fields — company name, summary, GISA, authority, full
 * address, city, bundesland — are withheld until the buyer unlocks this
 * specific listing.
 */
function listingToTeaser(
  cfg: Config,
  l: {
    _id: Types.ObjectId;
    slug: string;
    tradeCategory: string;
    tradeCategoryDe?: string | null;
    companyName?: string | null;
    summary?: string | null;
    summaryDe?: string | null;
    gisaNumber?: string | null;
    authority?: string | null;
    addressLine?: string | null;
    city?: string | null;
    bundesland?: string | null;
    licenseImageUrl?: string | null;
    sellerId: Types.ObjectId;
  },
  unlockedListingIds: Set<string>
) {
  const id = String(l._id);
  const unlocked = unlockedListingIds.has(id);
  const licenseImageUrl = normalizeLicenseImageUrlForBrowser(cfg, l.licenseImageUrl);
  const base = {
    id,
    slug: l.slug,
    tradeCategory: l.tradeCategory,
    tradeCategoryDe: l.tradeCategoryDe ?? null,
    sellerId: String(l.sellerId),
    unlocked,
    licenseImageUrl,
  };

  if (!unlocked) {
    return {
      ...base,
      displayName: l.tradeCategory,
    };
  }

  return {
    ...base,
    displayName: l.companyName?.trim() || l.tradeCategory,
    companyName: l.companyName ?? null,
    summary: l.summary ?? null,
    summaryDe: l.summaryDe ?? null,
    gisaNumber: l.gisaNumber ?? null,
    authority: l.authority ?? null,
    addressLine: l.addressLine ?? null,
    city: l.city ?? null,
    bundesland: l.bundesland ?? null,
  };
}

export async function registerBuyerRoutes(fastify: FastifyInstance, cfg: Config) {
  const buyerOnly = async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) =>
    authenticate(cfg, request, reply, ["buyer"]);

  async function readBuyerCredits(userId: string): Promise<number> {
    const u = await UserModel.findById(userId).select("creditBalance").lean();
    return typeof u?.creditBalance === "number" ? u.creditBalance : 0;
  }

  fastify.get("/buyer/dashboard/summary", { preHandler: buyerOnly }, async (request) => {
    const qs = (request.query ?? {}) as Record<string, unknown>;
    const buyerId = request.authUser!.id;
    const buyerOid = new Types.ObjectId(buyerId);

    if (qs.compact === "1" || qs.compact === "true") {
      const user = await UserModel.findById(buyerOid).select("creditBalance").lean();
      const sellerProfileUnlockingEnabled = await isSellerProfileUnlockingEnabled();
      return {
        creditBalance: user?.creditBalance ?? 0,
        sellerProfileUnlockingEnabled,
        sellerProfileUnlockingDisabledMessage: sellerProfileUnlockingEnabled
          ? null
          : SELLER_PROFILE_UNLOCKING_DISABLED_MESSAGE,
      };
    }

    const omit = new Set(
      String(qs.omit ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
    const skipTeasers = omit.has("teasers");
    const skipInvoices = omit.has("invoices");
    const skipInquiries = omit.has("inquiries");
    const skipLabels = omit.has("labels");

    const teaserPL = parsePageLimitQuery(qs, { prefix: "teaser", defaultLimit: 25, maxLimit: 100 });
    const invoicePL = parsePageLimitQuery(qs, { prefix: "invoice", defaultLimit: 20, maxLimit: 100 });
    const inquiryPL = parsePageLimitQuery(qs, { prefix: "inquiry", defaultLimit: 20, maxLimit: 100 });

    /**
     * Teaser query honors keyword (`q`) + state (`bundesland`) filters so the
     * buyer directory mirrors the public landing search experience. The label
     * lookup keeps the unfiltered set so cross-references (e.g. inquiry rows)
     * still resolve when the directory is filtered down.
     */
    const { filter: listingFilter, q: teaserQ, state: teaserState } =
      buildDirectoryListingFilter(qs);
    const labelFilter = { status: "approved" as const, active: true };

    const [
      user,
      sellerProfileUnlockingEnabled,
      unlockSellerRows,
      unlockActivityByDay,
      inquiryActivityByDay,
      inquiriesTotal,
      invoicesTotal,
      teaserTotal,
      directoryLabelDocs,
    ] = await Promise.all([
      UserModel.findById(buyerOid).lean(),
      isSellerProfileUnlockingEnabled(),
      UnlockEventModel.find({ buyerId: buyerOid }).select("sellerId listingId").lean(),
      UnlockEventModel.aggregate([
        { $match: { buyerId: buyerOid } },
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
      InquiryModel.aggregate([
        { $match: { buyerId: buyerOid } },
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
      InquiryModel.countDocuments({ buyerId: buyerOid }),
      InvoiceModel.countDocuments({ userId: buyerOid }),
      ListingModel.countDocuments(listingFilter),
      skipLabels
        ? Promise.resolve([] as { sellerId: unknown; companyName?: string | null; tradeCategory: string; slug: string }[])
        : ListingModel.find(labelFilter).select({ sellerId: 1, companyName: 1, tradeCategory: 1, slug: 1 }).lean(),
    ]);

    const unlockedListingIds = new Set(
      unlockSellerRows
        .map((u) => (u.listingId ? String(u.listingId) : null))
        .filter((v): v is string => Boolean(v))
    );
    const unlocksCount = unlockedListingIds.size;

    const directoryLabels = directoryLabelDocs.map((l) => ({
      sellerId: String(l.sellerId),
      slug: l.slug,
      displayName: l.companyName?.trim() || l.tradeCategory,
    }));

    let teaserListings: ReturnType<typeof listingToTeaser>[] = [];
    let invoicesOut: {
      id: string;
      type: string;
      amountCents: number;
      currency: string;
      description?: string | null;
      metadata?: unknown;
      stripeCheckoutSessionId?: string | null;
      createdAt?: Date;
    }[] = [];
    let inquiriesOut: {
      id: string;
      sellerId: string;
      listingId: string | null;
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      whatsapp?: string | null;
      tradeInfo?: string | null;
      locationLabel?: string | null;
      houseNumber?: string | null;
      street?: string | null;
      postalCode?: string | null;
      city?: string | null;
      lat?: number | null;
      lng?: number | null;
      createdAt?: Date;
      updatedAt?: Date;
    }[] = [];

    if (!skipTeasers) {
      const slice = await ListingModel.find(listingFilter)
        .sort({ createdAt: -1 })
        .skip(teaserPL.skip)
        .limit(teaserPL.limit)
        .lean();
      teaserListings = slice.map((l) => listingToTeaser(cfg, l, unlockedListingIds));
    }

    if (!skipInvoices) {
      const inv = await InvoiceModel.find({ userId: buyerOid })
        .sort({ createdAt: -1 })
        .skip(invoicePL.skip)
        .limit(invoicePL.limit)
        .lean();
      invoicesOut = inv.map((invDoc) => ({
        id: String(invDoc._id),
        type: invDoc.type,
        amountCents: invDoc.amountCents,
        currency: invDoc.currency,
        description: invDoc.description,
        metadata: invDoc.metadata,
        stripeCheckoutSessionId: invDoc.stripeCheckoutSessionId,
        createdAt: invDoc.createdAt,
      }));
    }

    if (!skipInquiries) {
      const iq = await InquiryModel.find({ buyerId: buyerOid })
        .sort({ createdAt: -1 })
        .skip(inquiryPL.skip)
        .limit(inquiryPL.limit)
        .lean();
      inquiriesOut = iq.map((i) => ({
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
        houseNumber: i.houseNumber,
        street: i.street,
        postalCode: i.postalCode,
        city: i.city,
        lat: i.lat,
        lng: i.lng,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
      }));
    }

    return {
      creditBalance: user?.creditBalance ?? 0,
      sellerProfileUnlockingEnabled,
      sellerProfileUnlockingDisabledMessage: sellerProfileUnlockingEnabled
        ? null
        : SELLER_PROFILE_UNLOCKING_DISABLED_MESSAGE,
      unlocksCount,
      inquiriesCount: inquiriesTotal,
      unlockActivityByDay: unlockActivityByDay.map((r) => ({
        day: r._id as string,
        count: r.count as number,
      })),
      inquiryActivityByDay: inquiryActivityByDay.map((r) => ({
        day: r._id as string,
        count: r.count as number,
      })),
      directoryLabels,
      teaserListings,
      teaserTotal,
      teaserPage: teaserPL.page,
      teaserLimit: teaserPL.limit,
      teaserTotalPages: totalPages(teaserTotal, teaserPL.limit),
      teaserQ,
      teaserState,
      teaserBundeslaender: [...AUSTRIA_BUNDESLAENDER],
      invoices: invoicesOut,
      invoicesTotal,
      invoicesPage: invoicePL.page,
      invoicesLimit: invoicePL.limit,
      invoicesTotalPages: totalPages(invoicesTotal, invoicePL.limit),
      inquiries: inquiriesOut,
      inquiriesTotal,
      inquiriesPage: inquiryPL.page,
      inquiriesLimit: inquiryPL.limit,
      inquiriesTotalPages: totalPages(inquiriesTotal, inquiryPL.limit),
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

  /**
   * Persists a permanent unlock for this buyer–LISTING pair. Unlocks are per
   * listing — unlocking one listing of a seller does NOT grant access to that
   * seller's other listings.
   */
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
    const buyerId = request.authUser!.id;
    const buyerOid = new Types.ObjectId(buyerId);

    const listingFilter: Record<string, unknown> = { status: "approved", active: true };
    if (parsed.data.listingId) {
      listingFilter._id = new Types.ObjectId(parsed.data.listingId);
    } else if (parsed.data.listingSlug) {
      listingFilter.slug = parsed.data.listingSlug;
      if (parsed.data.sellerId) {
        listingFilter.sellerId = new Types.ObjectId(parsed.data.sellerId);
      }
    }

    const listing = await ListingModel.findOne(listingFilter).lean();
    if (!listing) return reply.code(404).send({ error: "listing_not_found" });

    const existing = await UnlockEventModel.findOne({
      buyerId: buyerOid,
      listingId: listing._id,
    });
    if (existing) {
      return {
        ok: true,
        alreadyUnlocked: true,
        listingId: String(listing._id),
        sellerId: String(listing.sellerId),
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
        sellerId: listing.sellerId,
        listingId: listing._id,
        creditsUsed: 1,
      });
    } catch (e: unknown) {
      await UserModel.findByIdAndUpdate(buyerId, { $inc: { creditBalance: 1 } });
      if (e && typeof e === "object" && "code" in e && (e as { code?: number }).code === 11000) {
        return {
          ok: true,
          alreadyUnlocked: true,
          listingId: String(listing._id),
          sellerId: String(listing.sellerId),
          slug: listing.slug,
          creditBalance: await readBuyerCredits(buyerId),
        };
      }
      throw e;
    }

    return {
      ok: true,
      listingId: String(listing._id),
      sellerId: String(listing.sellerId),
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
    const buyerOid = new Types.ObjectId(buyerId);

    let listingId: Types.ObjectId | null = null;
    if (b.listingId) {
      const l = await ListingModel.findOne({
        _id: new Types.ObjectId(b.listingId),
        sellerId: new Types.ObjectId(b.sellerId),
        status: "approved",
      });
      if (l) listingId = l._id;
    } else if (b.listingSlug) {
      const l = await ListingModel.findOne({
        slug: b.listingSlug,
        sellerId: new Types.ObjectId(b.sellerId),
        status: "approved",
      });
      if (l) listingId = l._id;
    }

    if (!listingId) {
      return reply.code(400).send({ error: "listing_required" });
    }

    const unlocked = await UnlockEventModel.exists({
      buyerId: buyerOid,
      listingId,
    });
    if (!unlocked) return reply.code(403).send({ error: "unlock_required" });

    /**
     * Block delivery if the seller's listing-partner subscription has lapsed:
     *   - During the seller's free 2-month trial (status === "trialing" and
     *     `trialEndsAt` in the future) inquiries flow normally.
     *   - After the trial without an active Basic/VIP subscription, the seller
     *     is in "trial_expired" / "no_subscription" — inquiries are rejected so
     *     the buyer is not led to expect a response. The buyer sees a generic
     *     "currently unavailable" message.
     */
    const sellerDoc = await UserModel.findById(b.sellerId)
      .select("role subscriptionStatus trialEndsAt accountBlocked")
      .lean();
    if (!sellerDoc) {
      return reply.code(404).send({ error: "seller_not_found" });
    }
    const sellerAccess = evaluateSellerAccess(sellerDoc);
    if (!sellerAccess.allowed) {
      return reply.code(403).send({
        error: "seller_unavailable",
        reason: sellerAccess.reason,
      });
    }

    const locationDisplay = formatInquiryAddressLine({
      houseNumber: b.houseNumber,
      street: b.street,
      postalCode: b.postalCode,
      city: b.city,
    });

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
      houseNumber: b.houseNumber,
      street: b.street,
      postalCode: b.postalCode,
      city: b.city,
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
            locationDisplay,
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
