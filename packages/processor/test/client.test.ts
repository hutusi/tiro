import { describe, expect, test } from "bun:test";
import { createDeadline, DeadlineExceededError } from "../src/deadline.ts";
import {
  ChatConnectionError,
  ChatHttpError,
  createChatClient,
  isProviderFailure,
} from "../src/llm/client.ts";
import { droppedReply } from "./helpers.ts";

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const noSleep = async (): Promise<void> => {};

describe("createChatClient", () => {
  test("returns the message content", async () => {
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1/",
      apiKey: "k",
      fetchImpl: async (input) => {
        expect(String(input)).toBe("https://llm.example/v1/chat/completions");
        return jsonResponse("hello");
      },
      sleep: noSleep,
    });
    expect(
      await chat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).toBe("hello");
  });

  test("retries 429 and 5xx, then succeeds", async () => {
    let calls = 0;
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response("rate limited", { status: 429 });
        if (calls === 2) return new Response("boom", { status: 500 });
        return jsonResponse("ok");
      },
      sleep: noSleep,
    });
    expect(await chat({ model: "m", messages: [] })).toBe("ok");
    expect(calls).toBe(3);
  });

  test("does not retry 400", async () => {
    let calls = 0;
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      fetchImpl: async () => {
        calls += 1;
        return new Response("bad request", { status: 400 });
      },
      sleep: noSleep,
    });
    await expect(chat({ model: "m", messages: [] })).rejects.toThrow("400");
    expect(calls).toBe(1);
  });

  test("gives up after maxRetries", async () => {
    let calls = 0;
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      maxRetries: 2,
      fetchImpl: async () => {
        calls += 1;
        return new Response("boom", { status: 503 });
      },
      sleep: noSleep,
    });
    await expect(chat({ model: "m", messages: [] })).rejects.toThrow("503");
    expect(calls).toBe(3);
  });

  test("rejects an empty message content", async () => {
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      maxRetries: 0,
      fetchImpl: async () => jsonResponse(""),
      sleep: noSleep,
    });
    await expect(chat({ model: "m", messages: [] })).rejects.toThrow(
      "no message content",
    );
  });
  test("retries a timeout only once instead of burning the full retry budget", async () => {
    // A timeout has already spent timeoutMs of wall clock before it is even
    // observed, so the default 4 attempts cost 4x the timeout on one stuck
    // call — over eight minutes, which is what exhausted real run budgets.
    let calls = 0;
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      fetchImpl: async () => {
        calls += 1;
        const error = new Error("The operation timed out.");
        error.name = "TimeoutError";
        throw error;
      },
      sleep: noSleep,
    });
    await expect(chat({ model: "m", messages: [] })).rejects.toThrow(
      "The operation timed out.",
    );
    expect(calls).toBe(2);
  });

  test("a timeout that clears on the retry still succeeds", async () => {
    let calls = 0;
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          const error = new Error("The operation timed out.");
          error.name = "TimeoutError";
          throw error;
        }
        return jsonResponse("ok");
      },
      sleep: noSleep,
    });
    expect(await chat({ model: "m", messages: [] })).toBe("ok");
    expect(calls).toBe(2);
  });

  test("the timeout cap does not shorten ordinary 5xx retries", async () => {
    let calls = 0;
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      fetchImpl: async () => {
        calls += 1;
        if (calls < 4) return new Response("boom", { status: 500 });
        return jsonResponse("ok");
      },
      sleep: noSleep,
    });
    expect(await chat({ model: "m", messages: [] })).toBe("ok");
    expect(calls).toBe(4);
  });
  test("refuses to start a request once the run budget is gone", async () => {
    // Without this the budget is advisory: the pipeline stops scheduling work,
    // but a call already in flight keeps spending time the run does not have.
    let calls = 0;
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      deadline: createDeadline(0, () => 0),
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse("ok");
      },
      sleep: noSleep,
    });
    await expect(chat({ model: "m", messages: [] })).rejects.toThrow(
      DeadlineExceededError,
    );
    expect(calls).toBe(0);
  });

  test("clamps a request's timeout to the budget that is left", async () => {
    let clock = 0;
    const seen: number[] = [];
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      timeoutMs: 120_000,
      // Far less than timeoutMs remains, so the request must not be allowed
      // the full 120 s — that gap is exactly how a run overran its budget.
      deadline: createDeadline(5_000, () => clock),
      fetchImpl: async (_input, init) => {
        // AbortSignal.timeout(n) is not introspectable, so assert on the
        // clamp's inputs via the deadline instead: advance past the budget and
        // confirm the next attempt is refused rather than granted 120 s.
        seen.push(init?.signal === undefined ? -1 : 1);
        clock += 6_000;
        return new Response("boom", { status: 500 });
      },
      sleep: noSleep,
    });
    await expect(chat({ model: "m", messages: [] })).rejects.toThrow(
      DeadlineExceededError,
    );
    // One attempt made, the retry refused because the budget went negative.
    expect(seen).toEqual([1]);
  });

  test("a deadline error is not retried as a transport fault", async () => {
    let calls = 0;
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      maxRetries: 3,
      deadline: createDeadline(-1, () => 0),
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse("ok");
      },
      sleep: noSleep,
    });
    await expect(chat({ model: "m", messages: [] })).rejects.toThrow(
      DeadlineExceededError,
    );
    expect(calls).toBe(0);
  });

  test("no deadline means the previous unbounded behaviour is unchanged", async () => {
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      fetchImpl: async () => jsonResponse("ok"),
      sleep: noSleep,
    });
    expect(await chat({ model: "m", messages: [] })).toBe("ok");
  });
  const timeoutError = () => {
    const e = new Error("The operation timed out.");
    e.name = "TimeoutError";
    return e;
  };

  test("a request that exhausts the budget defers, it does not look like a fault", async () => {
    // The clamp means the last request of a run dies as a TimeoutError. If that
    // escapes, the pipeline reads an orderly stop as a failure — and for a
    // forced article that means its marker survives and the next ordinary run
    // skips it, reopening the bug the --force fix closed.
    let clock = 0;
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      maxRetries: 0, // the reviewer's first repro: no retries left to take
      deadline: createDeadline(100, () => clock),
      fetchImpl: async () => {
        clock += 100; // the clamped request spends the rest of the budget
        throw timeoutError();
      },
      sleep: noSleep,
    });
    await expect(chat({ model: "m", messages: [] })).rejects.toThrow(
      DeadlineExceededError,
    );
  });

  test("the same on the second-timeout path, with default retries", async () => {
    let clock = 0;
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      maxRetries: 3,
      deadline: createDeadline(200, () => clock),
      fetchImpl: async () => {
        clock += 100;
        throw timeoutError();
      },
      sleep: noSleep,
    });
    await expect(chat({ model: "m", messages: [] })).rejects.toThrow(
      DeadlineExceededError,
    );
  });

  test("names the underlying fault so a deferral is still diagnosable", async () => {
    let clock = 0;
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      maxRetries: 0,
      deadline: createDeadline(100, () => clock),
      fetchImpl: async () => {
        clock += 100;
        return new Response("forbidden", { status: 403 });
      },
      sleep: noSleep,
    });
    // Converting unconditionally keeps budget classification honest, but the
    // real cause must not vanish behind the word "budget": it has to be both.
    const error = await chat({ model: "m", messages: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(DeadlineExceededError);
    expect(String(error)).toContain("403");
    expect(String((error as Error).cause)).toContain("403");
  });

  test("a timeout with budget left still surfaces as a timeout", async () => {
    // No over-conversion: only an exhausted budget reclassifies an error.
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      deadline: createDeadline(60_000, () => 0),
      fetchImpl: async () => {
        throw timeoutError();
      },
      sleep: noSleep,
    });
    await expect(chat({ model: "m", messages: [] })).rejects.toThrow(
      "The operation timed out.",
    );
  });

  test("retry backoff cannot outlast the budget it is waiting on", async () => {
    let clock = 0;
    const slept: number[] = [];
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      deadline: createDeadline(100, () => clock),
      fetchImpl: async () => new Response("boom", { status: 500 }),
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    await expect(chat({ model: "m", messages: [] })).rejects.toThrow(
      DeadlineExceededError,
    );
    // The first backoff is 500ms, but only 100ms of budget remained.
    expect(slept).toEqual([100]);
  });
});

describe("a caller that has stopped waiting", () => {
  const request = {
    model: "m",
    messages: [{ role: "user" as const, content: "hi" }],
  };

  test("stops retrying once the caller's signal aborts", async () => {
    // A stage with a cap of its own is invisible from inside the client, so
    // without this the caller stopped waiting and the client went on retrying
    // underneath — spending the provider's quota on an answer nobody reads.
    let calls = 0;
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      maxRetries: 3,
      fetchImpl: async () => {
        calls += 1;
        return new Response("upstream", { status: 503 });
      },
      sleep: noSleep,
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      chat(request, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("still retries for a caller that is waiting", async () => {
    // The control: the same failure without a signal must keep its retries,
    // or this would be a way of disabling them.
    let calls = 0;
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      maxRetries: 2,
      fetchImpl: async () => {
        calls += 1;
        return new Response("upstream", { status: 503 });
      },
      sleep: noSleep,
    });
    await expect(chat(request)).rejects.toThrow();
    expect(calls).toBe(3);
  });

  test("does not put the signal in the request body", async () => {
    // ChatRequest is serialized straight to the provider, which is why this is
    // a second argument rather than a field on it.
    let body = "";
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      fetchImpl: async (_input, init) => {
        body = String(init?.body ?? "");
        return jsonResponse("hello");
      },
      sleep: noSleep,
    });
    await chat(request, { signal: new AbortController().signal });
    expect(body).not.toContain("signal");
    expect(JSON.parse(body)).toEqual(request);
  });
});

describe("a request that never reaches the provider", () => {
  test("is named a connection error, and still retried", async () => {
    let calls = 0;
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      maxRetries: 2,
      fetchImpl: async () => {
        calls += 1;
        throw new TypeError(
          "Unable to connect. Is the computer able to access the url?",
        );
      },
      sleep: noSleep,
    });
    const error = await chat({ model: "m", messages: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(ChatConnectionError);
    expect(String(error)).toContain("Unable to connect");
    expect(calls).toBe(3);
  });

  test("a timeout keeps its own name", async () => {
    // The timeout-attempt limit and the stages that fall back on a timeout
    // both recognise it by name; wrapping it would hide it from both.
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      fetchImpl: async () => {
        const error = new Error("The operation timed out.");
        error.name = "TimeoutError";
        throw error;
      },
      sleep: noSleep,
    });
    const error = await chat({ model: "m", messages: [] }).catch((e) => e);
    expect(error).not.toBeInstanceOf(ChatConnectionError);
    expect((error as Error).name).toBe("TimeoutError");
  });
});

describe("a reply that stops arriving", () => {
  test("is a connection error — retried, and an outage", async () => {
    // The fetch resolved, so wrapping only the fetch missed it: it escaped as a
    // bare TypeError, and the PDF pass checkpointed its fallback as settled.
    let calls = 0;
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      maxRetries: 2,
      fetchImpl: async () => {
        calls += 1;
        return droppedReply();
      },
      sleep: noSleep,
    });
    const error = await chat({ model: "m", messages: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(ChatConnectionError);
    expect(isProviderFailure(error)).toBe(true);
    expect(calls).toBe(3);
  });

  test("a reply that arrived whole but is not JSON is still not retried", async () => {
    let calls = 0;
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      fetchImpl: async () => {
        calls += 1;
        return new Response("not json", { status: 200 });
      },
      sleep: noSleep,
    });
    const error = await chat({ model: "m", messages: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(SyntaxError);
    expect(isProviderFailure(error)).toBe(false);
    expect(calls).toBe(1);
  });

  test("an error status keeps its status when its body cannot be read", async () => {
    // The status is the verdict: a 400 whose explanation was lost is still a
    // refusal of this request, not an outage.
    const chat = createChatClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      fetchImpl: async () => droppedReply(400),
      sleep: noSleep,
    });
    const error = await chat({ model: "m", messages: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(ChatHttpError);
    expect((error as ChatHttpError).status).toBe(400);
    expect(isProviderFailure(error)).toBe(false);
  });
});

describe("isProviderFailure", () => {
  const timeout = (): Error => {
    const error = new Error("The operation timed out.");
    error.name = "TimeoutError";
    return error;
  };
  const cases: [string, unknown, boolean][] = [
    ["a rejected key", new ChatHttpError(401, "invalid api key"), true],
    [
      "a key without access",
      new ChatHttpError(403, "Model.AccessDenied"),
      true,
    ],
    ["an unknown model or endpoint", new ChatHttpError(404, "not found"), true],
    [
      "a rate limit that outlasted the retries",
      new ChatHttpError(429, "slow down"),
      true,
    ],
    ["a server fault", new ChatHttpError(500, "boom"), true],
    ["a gateway fault", new ChatHttpError(503, "busy"), true],
    ["no connection", new ChatConnectionError(new TypeError("refused")), true],
    [
      "content moderation",
      new ChatHttpError(400, "data_inspection_failed"),
      false,
    ],
    ["a request too large", new ChatHttpError(413, "too large"), false],
    ["a server-side request timeout", new ChatHttpError(408, "timeout"), false],
    ["a client-side timeout", timeout(), false],
    [
      "a bare TypeError from a code slip",
      new TypeError("x is undefined"),
      false,
    ],
    [
      "an empty reply",
      new Error("chat completions response has no message content"),
      false,
    ],
    [
      "a reply that would not parse",
      new SyntaxError("Unexpected token"),
      false,
    ],
    ["a blown budget", new DeadlineExceededError("a request", -1), false],
  ];
  for (const [what, error, expected] of cases) {
    test(`${what}: ${expected ? "outage" : "not an outage"}`, () => {
      expect(isProviderFailure(error)).toBe(expected);
    });
  }
});
