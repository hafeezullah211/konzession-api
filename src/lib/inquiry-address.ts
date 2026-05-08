/** Format inquiry site-address fields for email / legacy single-line display. */
export function formatInquiryAddressLine(parts: {
  houseNumber?: string | null;
  street?: string | null;
  postalCode?: string | null;
  city?: string | null;
  /** Older inquiries stored only a free-text location label */
  locationLabel?: string | null;
}): string | undefined {
  const streetLine = [parts.street?.trim(), parts.houseNumber?.trim()].filter(Boolean).join(" ").trim();
  const cityLine = [parts.postalCode?.trim(), parts.city?.trim()].filter(Boolean).join(" ").trim();
  const segments = [streetLine, cityLine].filter(Boolean);
  if (segments.length > 0) return segments.join(", ");
  const legacy = parts.locationLabel?.trim();
  return legacy || undefined;
}
