import mongoose, { Schema, type InferSchemaType } from "mongoose";

export type UserRole = "seller" | "buyer" | "admin";

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["seller", "buyer", "admin"], required: true },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    phone: { type: String, trim: true },
    whatsapp: { type: String, trim: true },
    tradeType: { type: String, trim: true },
    displayName: { type: String, trim: true },
    subscriptionPlan: { type: String, default: null },
    subscriptionStatus: {
      type: String,
      enum: ["none", "pending_checkout", "trialing", "active", "past_due", "canceled"],
      default: "none",
    },
    trialEndsAt: { type: Date, default: null },
    stripeCustomerId: { type: String, default: null, index: true },
    stripeSubscriptionId: { type: String, default: null },
    /** Legacy (unused): buyer profile-access trial end; unlocks always cost credits now. */
    buyerProfileTrialEndsAt: { type: Date, default: null },
    creditBalance: { type: Number, default: 0, min: 0 },
    /** When true, login and API access are denied until an admin unblocks. */
    accountBlocked: { type: Boolean, default: false, index: true },
    /**
     * Mirrored from Stripe for seller subscriptions: when true, subscription ends at
     * `subscriptionCurrentPeriodEnd` (no further charges). Updated via webhooks and cancel flows.
     */
    subscriptionCancelAtPeriodEnd: { type: Boolean, default: false },
    subscriptionCurrentPeriodEnd: { type: Date, default: null },
    passwordResetTokenHash: { type: String, default: null, index: true, sparse: true },
    passwordResetExpiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.index({ role: 1 });

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: mongoose.Types.ObjectId };

export const UserModel = mongoose.model("User", userSchema);
