import mongoose, { Schema, type InferSchemaType } from "mongoose";

const contactSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    whatsapp: { type: String, trim: true },
    tradeCategory: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

export type ContactSubmissionDoc = InferSchemaType<typeof contactSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const ContactSubmissionModel = mongoose.model("ContactSubmission", contactSchema);
