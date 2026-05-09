import mongoose from "mongoose";

/**
 * Set explicit timeouts so a misconfigured `MONGODB_URI` (e.g. blocked Atlas IP
 * allowlist on Railway) fails fast with a clear error instead of hanging the
 * platform's deploy/health check until it kills the container.
 */
export async function connectDb(uri: string) {
  mongoose.set("strictQuery", true);
  mongoose.connection.on("error", (err) => {
    console.error("[mongo] connection error:", err);
  });
  mongoose.connection.on("disconnected", () => {
    console.warn("[mongo] disconnected");
  });
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 15_000,
    socketTimeoutMS: 45_000,
    maxPoolSize: 20,
  });
}
