import mongoose, { Schema, type InferSchemaType } from "mongoose";

const platformSettingsSchema = new Schema(
  {
    singletonKey: { type: String, default: "default", unique: true, index: true },
    sellerProfileUnlockingEnabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export type PlatformSettingsDoc = InferSchemaType<typeof platformSettingsSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const PlatformSettingsModel = mongoose.model("PlatformSettings", platformSettingsSchema);
