import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { verifyAccessToken } from "./lib/jwt.js";
import type { UserRole } from "./models/User.js";
import { UserModel } from "./models/User.js";

declare module "fastify" {
  interface FastifyRequest {
    authUser?: { id: string; role: UserRole; email: string };
  }
}

export {}; // preserve module augmentation

export async function authenticate(
  cfg: Config,
  request: FastifyRequest,
  reply: FastifyReply,
  roles?: UserRole[]
) {
  const h = request.headers.authorization;
  if (!h?.startsWith("Bearer ")) {
    return reply.code(401).send({ error: "missing_token" });
  }
  const token = h.slice("Bearer ".length).trim();
  try {
    const payload = verifyAccessToken(cfg, token);
    const dbUser = await UserModel.findById(payload.sub).lean();
    if (!dbUser) return reply.code(401).send({ error: "invalid_user" });
    if (roles && !roles.includes(dbUser.role)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    request.authUser = {
      id: dbUser._id.toString(),
      role: dbUser.role,
      email: dbUser.email,
    };
  } catch {
    return reply.code(401).send({ error: "invalid_token" });
  }
  return undefined;
}
