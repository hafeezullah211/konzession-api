import { PlatformSettingsModel } from "../models/PlatformSettings.js";

const SINGLETON_KEY = "default";

/** Shown to buyers when admins disable self-service profile unlocking (API + dashboard). */
export const SELLER_PROFILE_UNLOCKING_DISABLED_MESSAGE =
  "Seller profile unlocking is not available at the moment. Please contact your platform administrator to request access.";

export async function isSellerProfileUnlockingEnabled(): Promise<boolean> {
  const doc = await PlatformSettingsModel.findOne({ singletonKey: SINGLETON_KEY }).lean();
  if (!doc) return true;
  return doc.sellerProfileUnlockingEnabled !== false;
}

export async function setSellerProfileUnlockingEnabled(enabled: boolean): Promise<boolean> {
  const doc = await PlatformSettingsModel.findOneAndUpdate(
    { singletonKey: SINGLETON_KEY },
    { $set: { sellerProfileUnlockingEnabled: enabled } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  )
    .select("sellerProfileUnlockingEnabled")
    .lean();
  return doc?.sellerProfileUnlockingEnabled !== false;
}
