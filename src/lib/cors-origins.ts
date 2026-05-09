/**
 * Resolve `CORS_ORIGINS` (comma-separated env value) into a `@fastify/cors`
 * origin matcher. Supports:
 *   - exact origins:                         https://konzession-dashboard.vercel.app
 *   - wildcard subdomains for previews:      https://*.vercel.app
 *   - bare hostnames (we tolerate trailing slashes / accidental whitespace)
 *
 * The matcher is a function so we can mix exact + wildcard rules and so a
 * malformed Origin header never crashes the process.
 */
export type CorsOriginRule = { kind: "exact"; value: string } | { kind: "regex"; pattern: RegExp };

function normalize(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function ruleFromOrigin(origin: string): CorsOriginRule | null {
  const normalized = normalize(origin);
  if (!normalized) return null;
  if (normalized.includes("*")) {
    const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[a-z0-9-]+");
    return { kind: "regex", pattern: new RegExp(`^${escaped}$`, "i") };
  }
  return { kind: "exact", value: normalized.toLowerCase() };
}

export function parseCorsOrigins(raw: string): CorsOriginRule[] {
  return raw
    .split(",")
    .map((s) => ruleFromOrigin(s))
    .filter((rule): rule is CorsOriginRule => rule !== null);
}

export type CorsOriginCallback = (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => void;

/**
 * Build the function `@fastify/cors` expects for `origin`. Same-origin / curl /
 * server-to-server requests have no Origin header and must always be allowed
 * (otherwise health probes from Railway fail).
 */
export function buildCorsOriginMatcher(rules: CorsOriginRule[]): CorsOriginCallback {
  if (rules.length === 0) {
    return (_origin, cb) => cb(null, true);
  }
  return (origin, cb) => {
    if (!origin) return cb(null, true);
    const candidate = normalize(origin).toLowerCase();
    for (const rule of rules) {
      if (rule.kind === "exact" && rule.value === candidate) return cb(null, true);
      if (rule.kind === "regex" && rule.pattern.test(candidate)) return cb(null, true);
    }
    cb(null, false);
  };
}

export function describeCorsRules(rules: CorsOriginRule[]): string[] {
  return rules.map((r) => (r.kind === "exact" ? r.value : `pattern:${r.pattern}`));
}
