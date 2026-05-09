import mongoose, { Schema, type InferSchemaType } from "mongoose";

const registrationIntentSchema = new Schema(
  {
    kind: { type: String, enum: ["buyer", "seller"], required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    stripeCheckoutSessionId: { type: String, default: null, index: true },
    completedUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

registrationIntentSchema.index({ kind: 1, email: 1, createdAt: -1 });

export type RegistrationIntentDoc = InferSchemaType<typeof registrationIntentSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const RegistrationIntentModel = mongoose.model("RegistrationIntent", registrationIntentSchema);
