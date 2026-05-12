import { z } from "zod";

/**
 * The nine federal states of Austria (Bundesländer), German names as used
 * nationally. Alphabetical order — matches official listings / statistics tables.
 */
export const AUSTRIA_BUNDESLAENDER = [
  "Burgenland",
  "Kärnten",
  "Niederösterreich",
  "Oberösterreich",
  "Salzburg",
  "Steiermark",
  "Tirol",
  "Vorarlberg",
  "Wien",
] as const;

export type AustriaBundesland = (typeof AUSTRIA_BUNDESLAENDER)[number];

/** Zod enum for API validation (must match stored listing values exactly). */
export const austriaBundeslandEnum = z.enum(
  AUSTRIA_BUNDESLAENDER as unknown as [AustriaBundesland, ...AustriaBundesland[]]
);
