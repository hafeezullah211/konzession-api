import type { UserDoc } from "../models/User.js";

export type SellerAccessReason =
  | "active_subscription"
  | "trialing"
  | "trial_expired"
  | "no_subscription"
  | "canceled"
  | "past_due"
  | "blocked"
  | "not_seller";

export interface SellerAccess {
  /** True when the seller is allowed to add listings and receive inquiries. */
  allowed: boolean;
  reason: SellerAccessReason;
  trialEndsAt: Date | null;
  daysLeftInTrial: number | null;
}

/**
 * Decide whether a seller is currently allowed to publish listings and receive inquiries.
 *
 * Rules:
 *   - Sellers get a 2-month free trial starting from registration.
 *   - During the trial (status === "trialing" AND trialEndsAt > now), all features are unlocked.
 *   - After the trial expires, the seller MUST hold an active paid subscription
 *     (Basic or VIP) — i.e. status === "active".
 *   - Statuses "past_due", "canceled" and "none" all gate the account out of
 *     listing creation and inquiry delivery until they re-subscribe.
 *   - `accountBlocked` (admin lock) always denies access.
 */
export function evaluateSellerAccess(user: Pick<
  UserDoc,
  "role" | "subscriptionStatus" | "trialEndsAt" | "accountBlocked"
>): SellerAccess {
  if (user.role !== "seller") {
    return { allowed: false, reason: "not_seller", trialEndsAt: null, daysLeftInTrial: null };
  }
  if (user.accountBlocked) {
    return { allowed: false, reason: "blocked", trialEndsAt: null, daysLeftInTrial: null };
  }

  const now = Date.now();
  const trialEndsAt = user.trialEndsAt ? new Date(user.trialEndsAt) : null;
  const daysLeftInTrial = trialEndsAt
    ? Math.max(0, Math.ceil((trialEndsAt.getTime() - now) / 86_400_000))
    : null;

  if (user.subscriptionStatus === "active") {
    return { allowed: true, reason: "active_subscription", trialEndsAt, daysLeftInTrial };
  }
  if (user.subscriptionStatus === "trialing") {
    if (trialEndsAt && trialEndsAt.getTime() > now) {
      return { allowed: true, reason: "trialing", trialEndsAt, daysLeftInTrial };
    }
    return { allowed: false, reason: "trial_expired", trialEndsAt, daysLeftInTrial: 0 };
  }
  if (user.subscriptionStatus === "past_due") {
    return { allowed: false, reason: "past_due", trialEndsAt, daysLeftInTrial };
  }
  if (user.subscriptionStatus === "canceled") {
    return { allowed: false, reason: "canceled", trialEndsAt, daysLeftInTrial };
  }
  return { allowed: false, reason: "no_subscription", trialEndsAt, daysLeftInTrial };
}
