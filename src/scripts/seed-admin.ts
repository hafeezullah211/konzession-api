import "dotenv/config";
import { loadConfig } from "../config.js";
import { connectDb } from "../db.js";
import { seedAdminIfNeeded } from "../seed.js";

async function run() {
  const cfg = loadConfig();
  await connectDb(cfg.MONGODB_URI);
  await seedAdminIfNeeded(cfg);
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
