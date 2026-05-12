import mongoose, { Schema, type InferSchemaType } from "mongoose";

const listingSchema = new Schema(
  {
    sellerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    slug: { type: String, required: true, unique: true, trim: true },
    tradeCategory: { type: String, required: true, trim: true },
    tradeCategoryDe: { type: String, trim: true },
    companyName: { type: String, trim: true },
    summary: { type: String, trim: true },
    summaryDe: { type: String, trim: true },
    gisaNumber: { type: String, trim: true },
    authority: { type: String, trim: true },
    addressLine: { type: String, trim: true },
    city: { type: String, trim: true },
    bundesland: { type: String, trim: true },
    /** Public URL of the uploaded trade license image (MinIO / CDN). */
    licenseImageUrl: { type: String, trim: true },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },
    adminNote: { type: String, trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

listingSchema.index({ status: 1, createdAt: -1 });

export type ListingDoc = InferSchemaType<typeof listingSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const ListingModel = mongoose.model("Listing", listingSchema);
