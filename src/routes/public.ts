import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Config } from "../config.js";
import { ContactSubmissionModel } from "../models/ContactSubmission.js";
import { ListingModel } from "../models/Listing.js";
import { UserModel } from "../models/User.js";
import { sortListingsForPublic } from "../lib/ranking.js";
import type { ListingDoc } from "../models/Listing.js";
import type { UserDoc } from "../models/User.js";
import type { HydratedDocument } from "mongoose";

const contactBody = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(4),
  whatsapp: z.string().optional(),
  tradeCategory: z.string().min(1),
});

const bundeslandEnum = z.enum([
  "Wien",
  "Niederösterreich",
  "Oberösterreich",
  "Steiermark",
  "Tirol",
  "Kärnten",
  "Salzburg",
  "Vorarlberg",
  "Burgenland",
]);

const publicListingsSearchQuery = z.object({
  /** Required filter: `all` or a federal state (must be sent explicitly). */
  state: z.union([z.literal("all"), bundeslandEnum]),
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

export async function registerPublicRoutes(fastify: FastifyInstance, _cfg: Config) {
  fastify.get("/health", async () => ({ ok: true }));

  fastify.get("/public/listings", async () => {
    const approved = await ListingModel.find({ status: "approved", active: true });
    const sellerIds = [...new Set(approved.map((l) => String(l.sellerId)))];
    const sellers = await UserModel.find({ _id: { $in: sellerIds }, role: "seller" });
    const sellerMap = new Map<string, HydratedDocument<UserDoc>>(
      sellers.map((s) => [String(s._id), s as HydratedDocument<UserDoc>])
    );

    const sorted = sortListingsForPublic(
      approved as HydratedDocument<ListingDoc>[],
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
      })),
    };
  });

  fastify.get("/public/listings/search", async (request, reply) => {
    const raw = (request.query ?? {}) as Record<string, unknown>;
    const parsed = publicListingsSearchQuery.safeParse({
      state: firstQueryString(raw.state),
      q: firstQueryString(raw.q),
      page: firstQueryString(raw.page),
      limit: firstQueryString(raw.limit),
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }

    const { state, q, page, limit } = parsed.data;
    const baseFilter: Record<string, unknown> = { status: "approved", active: true };
    if (state !== "all") {
      baseFilter.bundesland = state;
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
        { gisaNumber: rx },
        { authority: rx },
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

    const sorted = sortListingsForPublic(
      approved as HydratedDocument<ListingDoc>[],
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
      })),
      total,
      page: safePage,
      limit,
      totalPages,
    };
  });

  /** Public marketing/teaser only — full profiles are opened only in the buyer workspace after POST /buyer/unlock. */
  fastify.get<{ Params: { slug: string } }>("/public/listings/by-slug/:slug", async (request, reply) => {
    const listing = await ListingModel.findOne({
      slug: request.params.slug,
      status: "approved",
      active: true,
    }).lean();

    if (!listing) return reply.code(404).send({ error: "not_found" });

    const teaser = {
      id: String(listing._id),
      slug: listing.slug,
      displayName: listing.companyName?.trim() || listing.tradeCategory,
      tradeCategory: listing.tradeCategory,
    };

    return { teaserOnly: true, ...teaser };
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
