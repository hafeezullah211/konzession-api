import jwt, { type SignOptions } from "jsonwebtoken";
import type { Types } from "mongoose";
import type { Config } from "../config.js";
import type { UserRole } from "../models/User.js";

export type AccessPayload = {
  sub: string;
  role: UserRole;
  email: string;
};

export function signAccessToken(cfg: Config, user: { _id: Types.ObjectId; role: UserRole; email: string }) {
  const payload: AccessPayload = {
    sub: user._id.toString(),
    role: user.role,
    email: user.email,
  };
  const opts: SignOptions = {
    expiresIn: cfg.JWT_ACCESS_EXPIRES as NonNullable<SignOptions["expiresIn"]>,
  };
  return jwt.sign(payload, cfg.JWT_SECRET, opts);
}

export function verifyAccessToken(cfg: Config, token: string): AccessPayload {
  const decoded = jwt.verify(token, cfg.JWT_SECRET);
  if (typeof decoded !== "object" || decoded == null || !("sub" in decoded)) {
    throw new Error("Invalid token");
  }
  const o = decoded as Record<string, unknown>;
  return {
    sub: String(o.sub),
    role: o.role as UserRole,
    email: String(o.email),
  };
}

export function signRefreshToken(cfg: Config, userId: string): string {
  const opts: SignOptions = {
    expiresIn: cfg.JWT_REFRESH_EXPIRES as NonNullable<SignOptions["expiresIn"]>,
  };
  return jwt.sign({ sub: userId, typ: "refresh" }, cfg.JWT_SECRET, opts);
}

export function verifyRefreshToken(cfg: Config, token: string): string {
  const decoded = jwt.verify(token, cfg.JWT_SECRET);
  if (typeof decoded !== "object" || decoded == null || !("sub" in decoded)) {
    throw new Error("Invalid refresh");
  }
  return String((decoded as { sub: unknown }).sub);
}
