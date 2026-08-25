import { tagSlug } from "@tiro/shared";

/** One route's worth of items: the slug that addresses it, the spelling to
 * show, and its members. */
export interface TermGroup<T> {
  slug: string;
  label: string;
  items: T[];
}

/**
 * Group items by the route-safe slug of a free-form term.
 *
 * Grouping is not optional. Tags are unconstrained LLM output, so distinct
 * spellings collapse onto one slug (`AI/ML`, `ai-ml`, `ai/ml`); returning a
 * static path per raw tag would emit several routes for one URL and lose all
 * but one of them without saying so.
 *
 * Generic, and in its own module, because `articles.ts` pulls in
 * `astro:content` — nothing there is reachable from a test.
 */
export function groupByTerm<T>(
  items: readonly T[],
  termsOf: (item: T) => readonly string[],
): TermGroup<T>[] {
  const groups = new Map<string, { labels: Map<string, number>; items: T[] }>();
  for (const item of items) {
    // Two of one item's terms can share a slug; list the item once.
    const placed = new Set<string>();
    for (const term of termsOf(item)) {
      const slug = tagSlug(term);
      let group = groups.get(slug);
      if (group === undefined) {
        group = { labels: new Map(), items: [] };
        groups.set(slug, group);
      }
      group.labels.set(term, (group.labels.get(term) ?? 0) + 1);
      if (!placed.has(slug)) {
        placed.add(slug);
        group.items.push(item);
      }
    }
  }
  return [...groups].map(([slug, group]) => ({
    slug,
    label: mostCommon(group.labels),
    items: group.items,
  }));
}

/** Map iteration is insertion-ordered, so ties go to the first spelling seen
 * — stable across builds given a stable item order. */
function mostCommon(labels: Map<string, number>): string {
  let best = "";
  let bestCount = -1;
  for (const [label, count] of labels) {
    if (count > bestCount) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}
