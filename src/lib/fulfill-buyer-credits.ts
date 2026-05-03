import type Stripe from "stripe";

import type { Config } from "../config.js";
import { BUYER_CREDIT_UNIT_AMOUNT_CENTS } from "./credit-pricing.js";
import { sendStripeReceiptEmail } from "./stripe-receipt-mail.js";
import { CreditTransactionModel } from "../models/CreditTransaction.js";
import { InvoiceModel } from "../models/Invoice.js";
import { UserModel } from "../models/User.js";

export type BuyerCreditsFulfillmentResult =
  | "fulfilled"
  | "already_fulfilled"
  | "skipped_not_buyer_credits"
  | "skipped_not_paid"
  | "skipped_invalid_credits";

/**
 * Idempotent: grants profile credits for a completed Checkout session (same rules as the Stripe webhook).
 * Call after verifying the session belongs to the current user, or from `checkout.session.completed`.
 */
export async function fulfillBuyerCreditsFromCheckoutSession(
  session: Stripe.Checkout.Session,
  cfg?: Config
): Promise<BuyerCreditsFulfillmentResult> {
  const meta = session.metadata ?? {};
  if (meta.kind !== "buyer_credits" || !meta.userId || !meta.credits) {
    return "skipped_not_buyer_credits";
  }
  if (session.mode !== "payment") {
    return "skipped_not_buyer_credits";
  }
  const credits = Number(meta.credits);
  if (!Number.isFinite(credits) || credits < 1) {
    return "skipped_invalid_credits";
  }
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
    return "skipped_not_paid";
  }

  const dupTx = await CreditTransactionModel.findOne({
    stripeCheckoutSessionId: session.id,
  }).lean();
  if (dupTx) return "already_fulfilled";

  const user = await UserModel.findById(meta.userId);
  if (!user || user.role !== "buyer") return "skipped_not_buyer_credits";

  user.creditBalance = (user.creditBalance ?? 0) + credits;
  await user.save();

  const amountCents =
    (session.amount_total ?? credits * BUYER_CREDIT_UNIT_AMOUNT_CENTS) ||
    credits * BUYER_CREDIT_UNIT_AMOUNT_CENTS;
  await CreditTransactionModel.create({
    buyerId: user._id,
    credits,
    amountCents,
    stripeCheckoutSessionId: session.id,
  });

  const receiptUrl =
    (session as Stripe.Checkout.Session & { receipt_url?: string | null }).receipt_url ?? null;
  await InvoiceModel.create({
    userId: user._id,
    type: "credits",
    amountCents,
    currency: (session.currency ?? "eur").toLowerCase(),
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId:
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id ?? null,
    description: `Profile credits (one-time, ×${credits})`,
    metadata: {
      credits,
      billingKind: "buyer_one_time",
      receiptUrl: receiptUrl ?? undefined,
    },
  });

  if (cfg) {
    try {
      await sendStripeReceiptEmail(cfg, {
        to: user.email,
        subject: `Konzession — payment receipt (${credits} profile credit${credits === 1 ? "" : "s"})`,
        lines: [
          `Thank you for your purchase.`,
          `One-time payment for ${credits} profile credit${credits === 1 ? "" : "s"} (unlock listings).`,
          `Amount: €${(amountCents / 100).toFixed(2)} ${(session.currency ?? "eur").toUpperCase()}.`,
        ],
        primaryUrl: receiptUrl,
        urlLabel: "View Stripe receipt",
      });
    } catch {
      /* email optional */
    }
  }

  return "fulfilled";
}
