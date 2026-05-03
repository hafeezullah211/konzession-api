import type Stripe from "stripe";

import type { Config } from "../config.js";
import { BUYER_CREDIT_UNIT_AMOUNT_CENTS } from "./credit-pricing.js";

function dashboardOrigin(cfg: Config): string {
  return (cfg.DASHBOARD_ORIGIN ?? "http://localhost:3001").replace(/\/$/, "");
}

export async function createBuyerCreditsCheckoutSession(
  stripe: Stripe,
  cfg: Config,
  params: {
    buyerId: string;
    buyerEmail: string;
    credits: number;
    successUrl?: string;
    cancelUrl?: string;
  }
): Promise<Stripe.Checkout.Session> {
  const base = dashboardOrigin(cfg);
  const successUrl =
    params.successUrl ??
    cfg.CHECKOUT_SUCCESS_URL ??
    `${base}/buyer/checkout/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl =
    params.cancelUrl ?? cfg.CHECKOUT_CANCEL_URL ?? `${base}/buyer/checkout/cancel`;

  return stripe.checkout.sessions.create({
    mode: "payment",
    currency: "eur",
    customer_email: params.buyerEmail,
    line_items: [
      {
        price_data: {
          currency: "eur",
          unit_amount: BUYER_CREDIT_UNIT_AMOUNT_CENTS,
          product_data: {
            name: `Konzession profile credits — €5 each (×${params.credits})`,
          },
        },
        quantity: params.credits,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      kind: "buyer_credits",
      billing_kind: "buyer_one_time",
      userId: params.buyerId,
      credits: String(params.credits),
    },
  });
}
