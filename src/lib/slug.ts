import { ListingModel } from "../models/Listing.js";
import crypto from "node:crypto";

export async function uniqueSlug(base: string) {
  const normalized =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "listing";
  let slug = normalized;
  for (let i = 0; i < 8; i++) {
    const exists = await ListingModel.exists({ slug });
    if (!exists) return slug;
    slug = `${normalized}-${crypto.randomBytes(3).toString("hex")}`;
  }
  return `${normalized}-${crypto.randomBytes(8).toString("hex")}`;
}
