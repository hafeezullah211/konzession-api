import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { z } from "zod";

import type { Config } from "../config.js";
import { authenticate } from "../auth-middleware.js";
import { fulfillBuyerCreditsFromCheckoutSession } from "../lib/fulfill-buyer-credits.js";
import { getStripe } from "../lib/stripe-client.js";
import { sendStripeReceiptEmail } from "../lib/stripe-receipt-mail.js";
import { sellerMonthlyAmountCents } from "../lib/seller-plan-amount.js";
import { InvoiceModel } from "../models/Invoice.js";
import { UserModel } from "../models/User.js";

function sellerSubscriptionLineItem(
  cfg: Config,
  plan: "basic" | "vip"
): Stripe.Checkout.SessionCreateParams.LineItem {
  const priceId = plan === "vip" ? cfg.STRIPE_PRICE_VIP : cfg.STRIPE_PRICE_BASIC;
  if (priceId) {
    return { price: priceId, quantity: 1 };
  }
  const unitAmount =
    plan === "vip"
      ? cfg.STRIPE_SUBSCRIPTION_VIP_UNIT_AMOUNT_CENTS
      : cfg.STRIPE_SUBSCRIPTION_BASIC_UNIT_AMOUNT_CENTS;
  const euros = (unitAmount / 100).toFixed(0);
  const name =
    plan === "vip"
      ? `Konzession VIP listing partner — €${euros}/mo after trial`
      : `Konzession Basic listing partner — €${euros}/mo after trial`;
  return {
    price_data: {
      currency: "eur",
      unit_amount: unitAmount,
      product_data: { name },
      recurring: { interval: "month" },
    },
    quantity: 1,
  };
}

const sessionBody = z.object({
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

export async function registerBillingRoutes(fastify: FastifyInstance, cfg: Config) {
  const sellerOnly = async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) =>
    authenticate(cfg, request, reply, ["seller"]);

  fastify.post("/billing/seller-subscription-session", { preHandler: sellerOnly }, async (request, reply) => {
    const stripe = getStripe(cfg);
    if (!stripe) {
      return { url: null as string | null, sessionId: null as string | null };
    }
    const parsed = sessionBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }

    const user = await UserModel.findById(request.authUser!.id);
    if (!user || user.role !== "seller") return reply.code(403).send({ error: "forbidden" });

    const plan = (user.subscriptionPlan ?? "basic") as "basic" | "vip";

    const successUrl =
      parsed.data.successUrl ??
      cfg.CHECKOUT_SUCCESS_URL ??
      "http://localhost:3001/seller/checkout/success?session_id={CHECKOUT_SESSION_ID}";
    const cancelUrl =
      parsed.data.cancelUrl ?? cfg.CHECKOUT_CANCEL_URL ?? "http://localhost:3001/seller/checkout/cancel";

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: user.email,
      line_items: [sellerSubscriptionLineItem(cfg, plan)],
      subscription_data: {
        trial_period_days: cfg.SELLER_TRIAL_PERIOD_DAYS,
        metadata: {
          userId: String(user._id),
          plan,
        },
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        kind: "seller_subscription",
        userId: String(user._id),
        plan,
      },
    });

    return { url: session.url, sessionId: session.id };
  });
}

async function handleSellerCheckoutCompleted(
  cfg: Config,
  session: Stripe.Checkout.Session,
  meta: Record<string, string>
) {
  const stripe = getStripe(cfg);
  if (!stripe || !session.customer || !meta.userId || meta.kind !== "seller_subscription") return;

  const dupInv = await InvoiceModel.findOne({
    stripeCheckoutSessionId: session.id,
    type: "subscription",
  }).lean();

  const user = await UserModel.findById(meta.userId);
  if (!user || user.role !== "seller") return;

  user.stripeCustomerId =
    typeof session.customer === "string" ? session.customer : session.customer.id;
  if (session.subscription) {
    user.stripeSubscriptionId =
      typeof session.subscription === "string" ? session.subscription : session.subscription.id;
  }
  user.subscriptionStatus = session.status === "complete" ? "trialing" : user.subscriptionStatus;

  const trialEnds = new Date(Date.now() + cfg.SELLER_TRIAL_PERIOD_DAYS * 86_400_000);
  user.trialEndsAt = trialEnds;
  await user.save();

  if (!dupInv) {
    const amountCents = session.amount_total ?? 0;
    const planLabel = (meta.plan ?? "basic") as "basic" | "vip";
    const monthlyAfterTrial = sellerMonthlyAmountCents(cfg, planLabel);
    await InvoiceModel.create({
      userId: user._id,
      type: "subscription",
      amountCents,
      currency: (session.currency ?? "eur").toLowerCase(),
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id ?? null,
      description: `Listing partner subscription — ${cfg.SELLER_TRIAL_PERIOD_DAYS}-day free trial (${planLabel}); then €${(monthlyAfterTrial / 100).toFixed(2)}/month`,
      metadata: {
        sessionId: session.id,
        plan: meta.plan,
        trialDays: cfg.SELLER_TRIAL_PERIOD_DAYS,
        recurringMonthlyCents: monthlyAfterTrial,
        billingKind: "seller_subscription_checkout",
        receiptUrl:
          (session as Stripe.Checkout.Session & { receipt_url?: string | null }).receipt_url ??
          undefined,
      },
    });
  }

  try {
    const planLabel = (meta.plan ?? "basic") as "basic" | "vip";
    const monthly = sellerMonthlyAmountCents(cfg, planLabel);
    await sendStripeReceiptEmail(cfg, {
      to: user.email,
      subject: `Konzession — listing partner subscription (${planLabel})`,
      lines: [
        `Your subscription is set up with a ${cfg.SELLER_TRIAL_PERIOD_DAYS}-day free trial.`,
        `During the trial there is no subscription charge.`,
        `After the trial ends, you will be billed €${(monthly / 100).toFixed(2)} per month automatically for the ${planLabel} plan (same card).`,
      ],
      primaryUrl:
        (session as Stripe.Checkout.Session & { receipt_url?: string | null }).receipt_url ?? null,
      urlLabel: "View Stripe checkout receipt",
    });
  } catch {
    /* optional */
  }
}

async function handleInvoicePaid(cfg: Config, invoice: Stripe.Invoice) {
  const stripe = getStripe(cfg);
  if (!stripe) return;

  /** Recurring seller subscription charges only (not unrelated Stripe invoices). */
  if (!invoice.subscription) return;

  const existing = await InvoiceModel.findOne({ stripeInvoiceId: invoice.id }).lean();
  if (existing) return;

  const customerId =
    typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? null;
  if (!customerId) return;

  const user = await UserModel.findOne({
    stripeCustomerId: customerId,
    role: "seller",
  });
  if (!user) return;

  const hostedUrl = invoice.hosted_invoice_url ?? null;
  const pdfUrl = invoice.invoice_pdf ?? null;

  await InvoiceModel.create({
    userId: user._id,
    type: "subscription",
    amountCents: invoice.amount_paid,
    currency: (invoice.currency ?? "eur").toLowerCase(),
    stripeInvoiceId: invoice.id,
    stripeCheckoutSessionId: null,
    description:
      invoice.billing_reason === "subscription_cycle"
        ? `Monthly subscription (recurring)`
        : invoice.description?.trim() ||
          `Subscription invoice (${invoice.billing_reason ?? "subscription"})`,
    metadata: {
      billingKind: "seller_recurring",
      billingReason: invoice.billing_reason,
      hostedInvoiceUrl: hostedUrl ?? undefined,
      invoicePdf: pdfUrl ?? undefined,
      subscriptionId:
        typeof invoice.subscription === "string"
          ? invoice.subscription
          : invoice.subscription?.id,
      periodEnd: invoice.period_end,
    },
  });

  try {
    await sendStripeReceiptEmail(cfg, {
      to: user.email,
      subject: `Konzession — invoice paid €${(invoice.amount_paid / 100).toFixed(2)}`,
      lines: [
        `We received your subscription payment.`,
        `Amount: €${(invoice.amount_paid / 100).toFixed(2)} ${(invoice.currency ?? "eur").toUpperCase()}.`,
      ],
      primaryUrl: hostedUrl ?? pdfUrl,
      urlLabel: hostedUrl ? "View invoice on Stripe" : "Download invoice PDF",
    });
  } catch {
    /* optional */
  }
}

async function handleSubscriptionUpdated(sub: Stripe.Subscription) {
  const userId = sub.metadata?.userId;
  if (!userId) return;
  const user = await UserModel.findById(userId);
  if (!user || user.role !== "seller") return;

  user.stripeSubscriptionId = sub.id;
  if (sub.trial_end) {
    user.trialEndsAt = new Date(sub.trial_end * 1000);
  }
  switch (sub.status) {
    case "trialing":
      user.subscriptionStatus = "trialing";
      break;
    case "active":
      user.subscriptionStatus = "active";
      break;
    case "past_due":
      user.subscriptionStatus = "past_due";
      break;
    case "canceled":
    case "unpaid":
      user.subscriptionStatus = "canceled";
      break;
    default:
      break;
  }
  await user.save();
}

export async function handleStripeWebhook(
  cfg: Config,
  rawBody: Buffer,
  signature: string | undefined
) {
  const stripe = getStripe(cfg);
  if (!stripe || !cfg.STRIPE_WEBHOOK_SECRET) {
    return { status: 503 as const, body: { error: "stripe_webhook_not_configured" } };
  }
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature!, cfg.STRIPE_WEBHOOK_SECRET);
  } catch {
    return { status: 400 as const, body: { error: "invalid_signature" } };
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const meta = session.metadata ?? {};
      if (meta.kind === "seller_subscription") {
        await handleSellerCheckoutCompleted(cfg, session, meta as Record<string, string>);
      }
      if (meta.kind === "buyer_credits") {
        await fulfillBuyerCreditsFromCheckoutSession(session, cfg);
      }
      break;
    }
    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      await handleInvoicePaid(cfg, invoice);
      break;
    }
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      await handleSubscriptionUpdated(sub);
      break;
    }
    default:
      break;
  }

  return { status: 200 as const, body: { received: true } };
}
