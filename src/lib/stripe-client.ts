import Stripe from "stripe";
import type { Config } from "../config.js";

export function getStripe(cfg: Config): Stripe | null {
  if (!cfg.STRIPE_SECRET_KEY) return null;
  return new Stripe(cfg.STRIPE_SECRET_KEY);
}
