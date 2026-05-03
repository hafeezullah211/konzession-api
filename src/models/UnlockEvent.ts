import mongoose, { Schema, type InferSchemaType } from "mongoose";

const unlockEventSchema = new Schema(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sellerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", default: null },
    creditsUsed: { type: Number, required: true, default: 1 },
    stripePaymentIntentId: { type: String, default: null },
  },
  { timestamps: true }
);

unlockEventSchema.index({ buyerId: 1, sellerId: 1 }, { unique: true });

export type UnlockEventDoc = InferSchemaType<typeof unlockEventSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const UnlockEventModel = mongoose.model("UnlockEvent", unlockEventSchema);
