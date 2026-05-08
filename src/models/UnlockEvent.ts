import mongoose, { Schema, type InferSchemaType } from "mongoose";

const unlockEventSchema = new Schema(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /**
     * Owning seller — kept for analytics/joins, but uniqueness is per `listingId`
     * (each listing must be unlocked separately).
     */
    sellerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /**
     * The unlocked listing. Required: unlocking is per-listing — unlocking one
     * listing of a seller does NOT grant access to their other listings.
     */
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", required: true, index: true },
    creditsUsed: { type: Number, required: true, default: 1 },
    stripePaymentIntentId: { type: String, default: null },
  },
  { timestamps: true }
);

unlockEventSchema.index({ buyerId: 1, listingId: 1 }, { unique: true });

export type UnlockEventDoc = InferSchemaType<typeof unlockEventSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const UnlockEventModel = mongoose.model("UnlockEvent", unlockEventSchema);
