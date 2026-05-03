import type { Config } from "../config.js";

/** Monthly subscription amount in EUR cents for the seller's chosen plan (mirrors Checkout line item). */
export function sellerMonthlyAmountCents(cfg: Config, plan: "basic" | "vip"): number {
  return plan === "vip"
    ? cfg.STRIPE_SUBSCRIPTION_VIP_UNIT_AMOUNT_CENTS
    : cfg.STRIPE_SUBSCRIPTION_BASIC_UNIT_AMOUNT_CENTS;
}
