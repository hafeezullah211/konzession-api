import mongoose, { Schema, type InferSchemaType } from "mongoose";

const creditTxSchema = new Schema(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    credits: { type: Number, required: true },
    amountCents: { type: Number, required: true },
    stripeCheckoutSessionId: { type: String, default: null },
  },
  { timestamps: true }
);

export type CreditTransactionDoc = InferSchemaType<typeof creditTxSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const CreditTransactionModel = mongoose.model("CreditTransaction", creditTxSchema);
