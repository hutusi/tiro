import { describe, expect, test } from "bun:test";
import { groupByTerm } from "../src/lib/terms.ts";

interface Item {
  id: string;
  tags: string[];
}

const group = (items: Item[]) => groupByTerm(items, (i) => i.tags);

describe("groupByTerm", () => {
  test("routes a term by its slug while showing the raw spelling", () => {
    const [only] = group([{ id: "a", tags: ["ci/cd"] }]);
    expect(only?.slug).toBe("ci-cd");
    expect(only?.label).toBe("ci/cd");
  });

  test("merges spellings that share a slug into one route", () => {
    const groups = group([
      { id: "a", tags: ["AI/ML"] },
      { id: "b", tags: ["ai-ml"] },
      { id: "c", tags: ["ai/ml"] },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.slug).toBe("ai-ml");
    expect(groups[0]?.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  test("labels a merged group with its most common spelling", () => {
    const groups = group([
      { id: "a", tags: ["AI/ML"] },
      { id: "b", tags: ["ai-ml"] },
      { id: "c", tags: ["ai-ml"] },
    ]);
    expect(groups[0]?.label).toBe("ai-ml");
  });

  test("lists an item once even when two of its tags collide", () => {
    const groups = group([{ id: "a", tags: ["ci/cd", "CI-CD"] }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.items).toHaveLength(1);
  });

  test("keeps non-ASCII terms apart", () => {
    const groups = group([
      { id: "a", tags: ["阅读"] },
      { id: "b", tags: ["知识管理"] },
    ]);
    expect(groups.map((g) => g.slug)).toEqual(["阅读", "知识管理"]);
  });

  test("ignores items with no terms", () => {
    expect(group([{ id: "a", tags: [] }])).toEqual([]);
  });
});
