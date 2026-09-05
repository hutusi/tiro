/**
 * Library pagination (ADR 0014). Page 1 is `/`, later pages `/page/N/`;
 * the routes in src/pages/index.astro and src/pages/page/[page].astro both
 * slice with these helpers, so the URL scheme is spelled once here.
 */
export const PAGE_SIZE = 10;

export function pageCount(total: number, size: number = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

export function slicePage<T>(
  items: readonly T[],
  page: number,
  size: number = PAGE_SIZE,
): T[] {
  return items.slice((page - 1) * size, page * size);
}

export function pageUrl(page: number): string {
  return page <= 1 ? "/" : `/page/${page}/`;
}

export type PagerItem = number | "…";

/**
 * Which page numbers the pager shows: the first, the last and the current
 * page's neighbours, with an ellipsis for every skipped run — except a run of
 * exactly one page, where the number itself is shorter than "…".
 */
export function pageWindow(current: number, last: number): PagerItem[] {
  const keep = new Set(
    [1, last, current - 1, current, current + 1].filter(
      (n) => n >= 1 && n <= last,
    ),
  );
  const items: PagerItem[] = [];
  let previous = 0;
  for (let n = 1; n <= last; n++) {
    if (!keep.has(n)) continue;
    if (n - previous === 2) items.push(n - 1);
    else if (n - previous > 2) items.push("…");
    items.push(n);
    previous = n;
  }
  return items;
}
