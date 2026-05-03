import mongoose, { Schema, type InferSchemaType } from "mongoose";

const inquirySchema = new Schema(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sellerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", default: null },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    whatsapp: { type: String, trim: true },
    tradeInfo: { type: String, trim: true },
    locationLabel: { type: String, trim: true },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
  },
  { timestamps: true }
);

export type InquiryDoc = InferSchemaType<typeof inquirySchema> & {
  _id: mongoose.Types.ObjectId;
};

export const InquiryModel = mongoose.model("Inquiry", inquirySchema);
