/** Shared offset pagination for list endpoints. */

export type PageLimit = {
  page: number;
  limit: number;
  skip: number;
};

const DEFAULT_MAX_LIMIT = 100;
const DEFAULT_MAX_PAGE = 10_000;

export function totalPages(total: number, limit: number): number {
  if (total <= 0) return 1;
  return Math.ceil(total / limit);
}

/**
 * Reads `page` and `limit` from query, or `{prefix}Page` / `{prefix}Limit` when prefix is set (e.g. `teaser` → teaserPage).
 */
export function parsePageLimitQuery(
  query: Record<string, unknown> | undefined,
  options?: {
    prefix?: string;
    defaultPage?: number;
    defaultLimit?: number;
    maxLimit?: number;
    maxPage?: number;
  }
): PageLimit {
  const prefix = options?.prefix ?? "";
  const pageKey = prefix ? `${prefix}Page` : "page";
  const limitKey = prefix ? `${prefix}Limit` : "limit";
  const defaultPage = options?.defaultPage ?? 1;
  const defaultLimit = options?.defaultLimit ?? 20;
  const maxLimit = options?.maxLimit ?? DEFAULT_MAX_LIMIT;
  const maxPage = options?.maxPage ?? DEFAULT_MAX_PAGE;

  const pageRaw = parseInt(String(query?.[pageKey] ?? query?.page ?? defaultPage), 10);
  const limitRaw = parseInt(String(query?.[limitKey] ?? query?.limit ?? defaultLimit), 10);

  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, maxPage) : defaultPage;
  const limit = Number.isFinite(limitRaw) ? Math.min(maxLimit, Math.max(1, limitRaw)) : defaultLimit;

  return { page, limit, skip: (page - 1) * limit };
}
