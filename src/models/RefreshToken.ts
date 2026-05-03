import mongoose, { Schema } from "mongoose";

const refreshTokenSchema = new Schema({
  token: { type: String, required: true, unique: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  expiresAt: { type: Date, required: true, index: true },
});

export const RefreshTokenModel = mongoose.model("RefreshToken", refreshTokenSchema);
