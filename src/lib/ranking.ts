import type { HydratedDocument } from "mongoose";
import type { UserDoc } from "../models/User.js";
import type { ListingDoc } from "../models/Listing.js";

/** VIP first, then basic, then by recency */
export function sortListingsForPublic(
  listings: HydratedDocument<ListingDoc>[],
  sellers: Map<string, HydratedDocument<UserDoc>>
) {
  return [...listings].sort((a, b) => {
    const ua = sellers.get(String(a.sellerId)) ?? null;
    const ub = sellers.get(String(b.sellerId)) ?? null;
    const rank = (u: HydratedDocument<UserDoc> | null) => {
      if (!u) return 0;
      if (u.subscriptionPlan === "vip") return 2;
      if (u.subscriptionPlan === "basic") return 1;
      return 0;
    };
    const dr = rank(ub) - rank(ua);
    if (dr !== 0) return dr;
    return (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0);
  });
}
