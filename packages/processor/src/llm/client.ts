export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  response_format?: { type: "json_object" };
  temperature?: number;
}

/** The one capability the pipeline needs from any LLM provider. Tests
 * substitute a fake; production wires createChatClient. */
export type ChatFn = (req: ChatRequest) => Promise<string>;

/** Structural fetch type so tests can pass plain fakes (Bun's `typeof fetch`
 * also demands its non-standard `preconnect` property). */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ChatClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_DELAYS_MS = [500, 1500, 3000];

/** Attempts a single logical call may spend on timeouts. Unlike a 429 or a
 * connection reset, a timeout has already burned `timeoutMs` of wall clock
 * before it is even observed, so the default `maxRetries` of 3 turns one stuck
 * request into 4x the timeout — over eight minutes of a run's budget spent on
 * a call that was never going to land. Two attempts, then give up and let the
 * article retry on a later run. */
const TIMEOUT_ATTEMPT_LIMIT = 2;

class ChatHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(
      `chat completions request failed with ${status}: ${body.slice(0, 300)}`,
    );
  }
}

function retryable(error: unknown): boolean {
  if (error instanceof ChatHttpError)
    return error.status === 429 || error.status >= 500;
  // Network errors / timeouts surface as TypeError or AbortError-ish objects.
  return !(error instanceof SyntaxError);
}

/** `AbortSignal.timeout` rejects with a DOMException named "TimeoutError";
 * matching on the name keeps this working across runtimes. */
function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "TimeoutError"
  );
}

/**
 * Minimal OpenAI-compatible chat-completions client. One POST shape is all
 * the pipeline needs, so no SDK dependency (ADR 0004).
 */
export function createChatClient(options: ChatClientOptions): ChatFn {
  const {
    baseUrl,
    apiKey,
    timeoutMs = 120_000,
    maxRetries = 3,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return async function chat(request: ChatRequest): Promise<string> {
    let lastError: unknown;
    let timeouts = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        await sleep(
          RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)] ??
            3000,
        );
      }
      try {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new ChatHttpError(res.status, await res.text());
        const payload = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content === "") {
          throw new Error("chat completions response has no message content");
        }
        return content;
      } catch (error) {
        lastError = error;
        if (isTimeout(error)) timeouts += 1;
        if (
          !retryable(error) ||
          timeouts >= TIMEOUT_ATTEMPT_LIMIT ||
          attempt === maxRetries
        )
          throw error;
      }
    }
    throw lastError;
  };
}
