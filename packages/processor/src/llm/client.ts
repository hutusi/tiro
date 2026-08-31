import { type Deadline, DeadlineExceededError } from "../deadline.ts";

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
  /** The run's absolute budget. Without it `timeoutMs` bounds one request but
   * nothing bounds a logical call: retries multiply it, and the caller's own
   * retry loops multiply it again. Given one, no request starts without budget
   * left and none may outlive it. */
  deadline?: Deadline;
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
    deadline,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return async function chat(request: ChatRequest): Promise<string> {
    let lastError: unknown;
    let timeouts = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      // Checked before the backoff, not after: sleeping 3s to then discover
      // there were 100ms left would overshoot the budget by the sleep itself.
      const beforeSleep = deadline?.remainingMs() ?? Number.POSITIVE_INFINITY;
      if (beforeSleep <= 0) {
        throw new DeadlineExceededError(
          "a chat completions request",
          beforeSleep,
          { cause: lastError },
        );
      }
      if (attempt > 0) {
        const backoff =
          RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)] ??
          3000;
        await sleep(Math.min(backoff, beforeSleep));
      }
      // Outside the try, so an exhausted budget cannot be mistaken for a
      // retryable transport fault and burn the very time it is out of.
      const remainingMs = deadline?.remainingMs() ?? Number.POSITIVE_INFINITY;
      if (remainingMs <= 0) {
        throw new DeadlineExceededError(
          "a chat completions request",
          remainingMs,
          { cause: lastError },
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
          // Clamped so a request cannot outlive the run's budget — the same
          // idiom the image stage uses against its own stage deadline.
          signal: AbortSignal.timeout(Math.min(timeoutMs, remainingMs)),
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
        // Before any retry limit: what the caller does next is decided by the
        // budget, not by the shape of the error. A request clamped to the last
        // of the budget dies as a TimeoutError, and letting that escape had the
        // pipeline read an orderly stop as a fault — which for a forced article
        // meant its marker survived and the next ordinary run skipped it.
        const left = deadline?.remainingMs() ?? Number.POSITIVE_INFINITY;
        if (left <= 0) {
          throw new DeadlineExceededError("a chat completions retry", left, {
            cause: error,
          });
        }
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
