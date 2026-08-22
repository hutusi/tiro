import { describe, expect, test } from "bun:test";
import { createChatClient } from "../src/llm/client.ts";

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
});
