import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Config } from "../config.js";
import { evaluateSellerAccess } from "../lib/seller-access.js";
import { ContactSubmissionModel } from "../models/ContactSubmission.js";
import { ListingModel } from "../models/Listing.js";
import { UserModel } from "../models/User.js";
import { normalizeLicenseImageUrlForBrowser } from "../lib/minio-license.js";
import { sortListingsForPublic } from "../lib/ranking.js";
import type { ListingDoc } from "../models/Listing.js";
import type { UserDoc } from "../models/User.js";
import type { HydratedDocument } from "mongoose";

import { isValidTradeCategory } from "../lib/trade-categories.js";

/**
 * Sellers whose listing-partner subscription is dormant (trial expired without
 * a Basic/VIP subscription, past_due, canceled, or admin-blocked) should not
 * surface on the public landing/search anymore — buyers should not be led to
 * profiles whose owners cannot currently receive inquiries.
 */
function buildAllowedSellerIdSet(
  sellerMap: Map<string, HydratedDocument<UserDoc>>
): Set<string> {
  const allowed = new Set<string>();
  for (const [id, seller] of sellerMap.entries()) {
    if (evaluateSellerAccess(seller).allowed) allowed.add(id);
  }
  return allowed;
}

const contactBody = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(4),
  whatsapp: z.string().optional(),
  tradeCategory: z
    .string()
    .trim()
    .min(1)
    .refine((v) => isValidTradeCategory(v), { message: "invalid_trade_category" }),
});

const publicListingsSearchQuery = z.object({
  /** `all` or a canonical trade category value from `trade-categories.ts`. */
  category: z
    .string()
    .optional()
    .transform((s) => (s ?? "all").trim()),
  q: z
    .string()
    .max(200)
    .optional()
    .transform((s) => (s ?? "").trim()),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(6),
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstQueryString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

export async function registerPublicRoutes(fastify: FastifyInstance, cfg: Config) {
  fastify.get("/health", async () => ({ ok: true }));

  fastify.get("/public/listings", async () => {
    const approved = await ListingModel.find({ status: "approved", active: true });
    const sellerIds = [...new Set(approved.map((l) => String(l.sellerId)))];
    const sellers = await UserModel.find({ _id: { $in: sellerIds }, role: "seller" });
    const sellerMap = new Map<string, HydratedDocument<UserDoc>>(
      sellers.map((s) => [String(s._id), s as HydratedDocument<UserDoc>])
    );
    const allowedSellerIds = buildAllowedSellerIdSet(sellerMap);
    const visible = approved.filter((l) => allowedSellerIds.has(String(l.sellerId)));

    const sorted = sortListingsForPublic(
      visible as HydratedDocument<ListingDoc>[],
      sellerMap
    );

    return {
      listings: sorted.map((l) => ({
        id: String(l._id),
        slug: l.slug,
        displayName: l.companyName?.trim() || l.tradeCategory,
        tradeCategory: l.tradeCategory,
        tradeCategoryDe: l.tradeCategoryDe ?? null,
        city: l.city ?? null,
        bundesland: l.bundesland ?? null,
        licenseImageUrl: normalizeLicenseImageUrlForBrowser(cfg, l.licenseImageUrl),
      })),
    };
  });

  fastify.get("/public/listings/search", async (request, reply) => {
    const raw = (request.query ?? {}) as Record<string, unknown>;
    const parsed = publicListingsSearchQuery.safeParse({
      category: firstQueryString(raw.category) ?? firstQueryString(raw.state),
      q: firstQueryString(raw.q),
      page: firstQueryString(raw.page),
      limit: firstQueryString(raw.limit),
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }

    const { category: categoryRaw, q, page, limit } = parsed.data;
    const category =
      categoryRaw === "all" || !categoryRaw
        ? "all"
        : isValidTradeCategory(categoryRaw)
          ? categoryRaw
          : "all";
    const baseFilter: Record<string, unknown> = { status: "approved", active: true };
    if (category !== "all") {
      baseFilter.tradeCategory = category;
    }
    if (q.length > 0) {
      const rx = new RegExp(escapeRegex(q), "i");
      baseFilter.$or = [
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

    const approved = await ListingModel.find(baseFilter);
    const sellerIds = [...new Set(approved.map((l) => String(l.sellerId)))];
    const sellers = await UserModel.find({ _id: { $in: sellerIds }, role: "seller" });
    const sellerMap = new Map<string, HydratedDocument<UserDoc>>(
      sellers.map((s) => [String(s._id), s as HydratedDocument<UserDoc>])
    );
    const allowedSellerIds = buildAllowedSellerIdSet(sellerMap);
    const visible = approved.filter((l) => allowedSellerIds.has(String(l.sellerId)));

    const sorted = sortListingsForPublic(
      visible as HydratedDocument<ListingDoc>[],
      sellerMap
    );

    const total = sorted.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, totalPages);
    const skip = (safePage - 1) * limit;
    const slice = sorted.slice(skip, skip + limit);

    return {
      listings: slice.map((l) => ({
        id: String(l._id),
        slug: l.slug,
        displayName: l.companyName?.trim() || l.tradeCategory,
        tradeCategory: l.tradeCategory,
        tradeCategoryDe: l.tradeCategoryDe ?? null,
        city: l.city ?? null,
        bundesland: l.bundesland ?? null,
        licenseImageUrl: normalizeLicenseImageUrlForBrowser(cfg, l.licenseImageUrl),
      })),
      total,
      page: safePage,
      limit,
      totalPages,
    };
  });

  /**
   * Public detail view — exposes the verified license metadata that mirrors what users
   * already see in the search results plus the structured fields rendered on the
   * detail page (address summary, status). Sensitive contact
   * details remain behind the buyer workspace unlock flow.
   */
  fastify.get<{ Params: { slug: string } }>("/public/listings/by-slug/:slug", async (request, reply) => {
    const listing = await ListingModel.findOne({
      slug: request.params.slug,
      status: "approved",
    }).lean();

    if (!listing) return reply.code(404).send({ error: "not_found" });

    const detail = {
      id: String(listing._id),
      slug: listing.slug,
      displayName: listing.companyName?.trim() || listing.tradeCategory,
      tradeCategory: listing.tradeCategory,
      tradeCategoryDe: listing.tradeCategoryDe ?? null,
      companyName: listing.companyName ?? null,
      summary: listing.summary ?? null,
      summaryDe: listing.summaryDe ?? null,
      addressLine: listing.addressLine ?? null,
      city: listing.city ?? null,
      bundesland: listing.bundesland ?? null,
      active: Boolean(listing.active),
      licenseImageUrl: normalizeLicenseImageUrlForBrowser(cfg, listing.licenseImageUrl),
    };

    return { teaserOnly: false, listing: detail };
  });

  fastify.post("/public/contact", async (request, reply) => {
    const parsed = contactBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    await ContactSubmissionModel.create(parsed.data);
    return { ok: true };
  });
}
