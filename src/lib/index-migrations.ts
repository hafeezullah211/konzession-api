import mongoose from "mongoose";

import { UnlockEventModel } from "../models/UnlockEvent.js";

/**
 * Mongo will not drop a unique index automatically when its key shape changes.
 * The legacy `unlockevents` index `{ buyerId: 1, sellerId: 1 } (unique)` granted
 * one buyer access to ALL of a seller's listings; we now scope unlocks per
 * listing with `{ buyerId: 1, listingId: 1 } (unique)`. Drop the old index on
 * startup if it still exists, then call `syncIndexes()` so the new spec is
 * applied. Safe to run repeatedly.
 */
export async function ensureUnlockEventIndexes(): Promise<void> {
  const collection = UnlockEventModel.collection;
  try {
    const indexes = (await collection.indexes()) as Array<{
      name?: string;
      key?: Record<string, number>;
    }>;

    for (const ix of indexes) {
      const k = ix.key ?? {};
      const isLegacyBuyerSellerUnique =
        Object.keys(k).length === 2 && k.buyerId === 1 && k.sellerId === 1;
      if (isLegacyBuyerSellerUnique && ix.name) {
        try {
          await collection.dropIndex(ix.name);
        } catch (err) {
          if (
            !(
              err instanceof mongoose.mongo.MongoServerError &&
              (err.codeName === "IndexNotFound" || err.code === 27)
            )
          ) {
            throw err;
          }
        }
      }
    }

    await UnlockEventModel.syncIndexes();
  } catch (err) {
    if (
      err instanceof mongoose.mongo.MongoServerError &&
      (err.code === 14031 || err.codeName === "OutOfDiskSpace")
    ) {
      console.error(
        "[ensureUnlockEventIndexes] MongoDB reports insufficient free disk for index operations " +
          "(typically needs ~500MB free). Fix: in Railway open the MongoDB service → increase the " +
          "volume/plan or free space, then redeploy. The API will start but UnlockEvent indexes may be stale."
      );
      return;
    }
    // Swallow other non-fatal index races — surface in logs upstream.
    console.warn("ensureUnlockEventIndexes:", err);
  }
}
