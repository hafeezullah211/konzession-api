import type { Config } from "./config.js";
import { hashPassword } from "./lib/auth-hash.js";
import { UserModel } from "./models/User.js";

export async function seedAdminIfNeeded(cfg: Config) {
  if (!cfg.ADMIN_EMAIL || !cfg.ADMIN_PASSWORD) return;
  const exists = await UserModel.exists({ email: cfg.ADMIN_EMAIL.toLowerCase() });
  if (exists) return;
  const passwordHash = await hashPassword(cfg.ADMIN_PASSWORD);
  await UserModel.create({
    email: cfg.ADMIN_EMAIL.toLowerCase(),
    passwordHash,
    role: "admin",
    firstName: "Admin",
    lastName: "User",
    subscriptionStatus: "none",
    creditBalance: 0,
  });
  console.log("Seeded admin user from ADMIN_EMAIL");
}
