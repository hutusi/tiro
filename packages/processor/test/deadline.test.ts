import { describe, expect, test } from "bun:test";
import {
  createDeadline,
  DeadlineExceededError,
  unboundedDeadline,
} from "../src/deadline.ts";

describe("createDeadline", () => {
  test("counts down from the injected clock", () => {
    let clock = 1000;
    const deadline = createDeadline(500, () => clock);
    expect(deadline.remainingMs()).toBe(500);
    clock += 200;
    expect(deadline.remainingMs()).toBe(300);
    clock += 400;
    expect(deadline.remainingMs()).toBe(-100);
  });

  test("expired() reserves headroom for a call that still has to run", () => {
    let clock = 0;
    const deadline = createDeadline(1000, () => clock);
    clock = 500;
    // 500ms left: fine for a 300ms call, not worth starting a 600ms one.
    expect(deadline.expired(300)).toBe(false);
    expect(deadline.expired(600)).toBe(true);
  });

  test("check() throws once the headroom is gone", () => {
    let clock = 0;
    const deadline = createDeadline(100, () => clock);
    expect(() => deadline.check(50, "batch 1")).not.toThrow();
    clock = 80;
    expect(() => deadline.check(50, "batch 2")).toThrow(DeadlineExceededError);
    try {
      deadline.check(50, "batch 2");
    } catch (error) {
      // The message has to name the stage: it is what tells an operator the
      // run stopped on budget rather than on a provider fault.
      expect(String(error)).toContain("batch 2");
      expect((error as DeadlineExceededError).remainingMs).toBe(20);
    }
  });
});

describe("unboundedDeadline", () => {
  test("never expires, so opting out costs nothing", () => {
    const deadline = unboundedDeadline();
    expect(deadline.expired(Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(() =>
      deadline.check(Number.MAX_SAFE_INTEGER, "anything"),
    ).not.toThrow();
  });
});
