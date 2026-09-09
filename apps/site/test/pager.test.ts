import { describe, expect, test } from "bun:test";
import {
  PAGE_SIZE,
  pageCount,
  pageUrl,
  pageWindow,
  slicePage,
} from "../src/lib/pager.ts";

describe("pageWindow", () => {
  test("a single page", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
  });

  test("short runs are shown in full", () => {
    expect(pageWindow(1, 4)).toEqual([1, 2, 3, 4]);
    expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  test("elides the far end from the first page", () => {
    expect(pageWindow(1, 10)).toEqual([1, 2, "…", 10]);
    expect(pageWindow(2, 10)).toEqual([1, 2, 3, "…", 10]);
  });

  test("elides both sides around a middle page", () => {
    expect(pageWindow(5, 10)).toEqual([1, "…", 4, 5, 6, "…", 10]);
  });

  test("elides the near end from the last pages", () => {
    expect(pageWindow(9, 10)).toEqual([1, "…", 8, 9, 10]);
    expect(pageWindow(10, 10)).toEqual([1, "…", 9, 10]);
  });

  test("a gap of exactly one page shows the number, not an ellipsis", () => {
    expect(pageWindow(4, 10)).toEqual([1, 2, 3, 4, 5, "…", 10]);
  });
});

describe("pageUrl", () => {
  test("page one is the root", () => {
    expect(pageUrl(1)).toBe("/");
    expect(pageUrl(0)).toBe("/");
  });

  test("later pages live under /page/", () => {
    expect(pageUrl(3)).toBe("/page/3/");
  });
});

describe("pageCount and slicePage", () => {
  test("an empty library still has one page", () => {
    expect(pageCount(0)).toBe(1);
  });

  test("rounds up", () => {
    expect(pageCount(PAGE_SIZE)).toBe(1);
    expect(pageCount(PAGE_SIZE + 1)).toBe(2);
    expect(pageCount(PAGE_SIZE * 3 + 1)).toBe(4);
  });

  test("slices newest-first input into stable pages", () => {
    const items = Array.from({ length: PAGE_SIZE * 2 + 3 }, (_, i) => i);
    expect(slicePage(items, 1)).toEqual(items.slice(0, PAGE_SIZE));
    expect(slicePage(items, 3)).toEqual(items.slice(PAGE_SIZE * 2));
    expect(slicePage(items, 3)).toHaveLength(3);
    expect(slicePage(items, 4)).toEqual([]);
  });

  /*
   * The page size is chosen to fill the card grid's rows, so it has to divide
   * by every column count that grid produces (see the comment on PAGE_SIZE).
   * This fails the moment someone rounds it to a friendlier-looking number.
   */
  test("divides by every column count the card grid can produce", () => {
    for (const columns of [1, 2, 3, 4]) {
      expect(PAGE_SIZE % columns).toBe(0);
    }
  });
});
