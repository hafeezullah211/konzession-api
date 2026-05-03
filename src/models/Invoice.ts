import mongoose, { Schema, type InferSchemaType } from "mongoose";

const invoiceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: ["subscription", "credits"], required: true },
    amountCents: { type: Number, required: true },
    currency: { type: String, default: "eur" },
    stripeCheckoutSessionId: { type: String, default: null },
    stripePaymentIntentId: { type: String, default: null },
    stripeInvoiceId: { type: String, default: null },
    description: { type: String, trim: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

export type InvoiceDoc = InferSchemaType<typeof invoiceSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const InvoiceModel = mongoose.model("Invoice", invoiceSchema);
