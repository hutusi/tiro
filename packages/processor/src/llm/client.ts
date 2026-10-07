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

/**
 * Per-call controls that are not part of the request body.
 *
 * Separate from `ChatRequest` because that object is serialized straight to the
 * provider — anything added to it is sent as a field of the API payload.
 */
export interface ChatCallOptions {
  /**
   * Stops this call: the in-flight request is aborted and no retry follows.
   *
   * For a stage with a cap of its own. The run's budget is already this
   * client's own clock, but a stage deadline is invisible from in here, and
   * without a way to say so a caller that stopped waiting still left the
   * client retrying — spending the provider's quota on an answer nobody would
   * read.
   */
  signal?: AbortSignal;
}

/** The one capability the pipeline needs from any LLM provider. Tests
 * substitute a fake; production wires createChatClient. */
export type ChatFn = (
  req: ChatRequest,
  options?: ChatCallOptions,
) => Promise<string>;

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
  /** Where a reply the provider did not end on its own is reported — see
   * `unfinishedReply`. */
  log?: (message: string) => void;
}

/** The parts of a chat completions reply this client reads. */
interface CompletionPayload {
  choices?: {
    message?: { content?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/**
 * One line saying why a reply ended, when it was not the model finishing.
 *
 * `finish_reason` is the only place a provider says it cut a reply short — at
 * its output cap, or by a content filter — and without it a cut reply reads,
 * to every caller, like a model that stopped mid-sentence by choice. The
 * summary call's `summary_failed` articles were undiagnosable for exactly that
 * reason (2026-10). Reported rather than acted on: what a cut reply is worth
 * differs by caller, and each one already validates what it gets back.
 *
 * Sizes only, never text: a reply is a reading of a vault article, and this
 * line goes to the workflow log. A reasoning model's thinking is measured
 * separately because it is spent from the same output budget as the answer.
 */
function unfinishedReply(
  reason: string,
  payload: CompletionPayload,
  content: string | undefined,
): string {
  const { usage } = payload;
  const parts: string[] = [];
  if (usage?.completion_tokens !== undefined) {
    const reasoning = usage.completion_tokens_details?.reasoning_tokens;
    parts.push(
      `${usage.completion_tokens} completion tokens${reasoning !== undefined ? ` (${reasoning} reasoning)` : ""}`,
    );
  }
  if (usage?.prompt_tokens !== undefined) {
    parts.push(`${usage.prompt_tokens} prompt tokens`);
  }
  parts.push(`${content?.length ?? 0} chars of content`);
  const thinking = payload.choices?.[0]?.message?.reasoning_content;
  if (typeof thinking === "string" && thinking !== "") {
    parts.push(`${thinking.length} chars of reasoning`);
  }
  return `chat reply ended by finish_reason "${reason}", not "stop": ${parts.join(", ")}`;
}

const RETRY_DELAYS_MS = [500, 1500, 3000];

/** Attempts a single logical call may spend on timeouts. Unlike a 429 or a
 * connection reset, a timeout has already burned `timeoutMs` of wall clock
 * before it is even observed, so the default `maxRetries` of 3 turns one stuck
 * request into 4x the timeout — over eight minutes of a run's budget spent on
 * a call that was never going to land. Two attempts, then give up and let the
 * article retry on a later run. */
const TIMEOUT_ATTEMPT_LIMIT = 2;

export class ChatHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(
      `chat completions request failed with ${status}: ${body.slice(0, 300)}`,
    );
    this.name = "ChatHttpError";
  }
}

/** The request never reached the provider — refused connection, DNS, TLS, a
 * malformed base URL — or its reply stopped arriving: a socket reset while the
 * body was being read. `fetch` and the body readers report all of these as a
 * bare `TypeError`, which is also what a programming slip throws, so the
 * client names it at the places it can tell the two apart. */
export class ChatConnectionError extends Error {
  constructor(cause: TypeError) {
    super(`chat completions request could not connect: ${cause.message}`, {
      cause,
    });
    this.name = "ChatConnectionError";
  }
}

/** Throws `error` as a `ChatConnectionError` when it is the `TypeError` a lost
 * connection surfaces as, and unchanged otherwise — a timeout or an abort keeps
 * its own name, which is what the rest of the client and its callers read. */
function asConnectionError(error: unknown): never {
  throw error instanceof TypeError ? new ChatConnectionError(error) : error;
}

/**
 * Whether an error says the provider is not serving *any* request right now,
 * as opposed to refusing this one (ADR 0032).
 *
 * A rejected key (401), an account or model the key cannot use (403, 404), a
 * quota or rate limit that outlasted the retries (429), a server fault (5xx)
 * and a connection that could not be made all fail every request alike, so
 * repeating them on the next article only spends time learning it again.
 *
 * Deliberately left out:
 * - **400 and the other 4xx.** A verdict on this request — DashScope's content
 *   moderation (`data_inspection_failed`) answers 400 — which the next article
 *   will not share.
 * - **Timeouts** (a `TimeoutError`, or a 408). A slow reply is as often the
 *   size of this request as the state of the provider, and the stages that
 *   fall back on one — per-block translation, a PDF batch kept as extracted
 *   text — exist because a batch too big to answer in time would otherwise
 *   time out on every run forever.
 * - **An empty or unparseable reply.** The provider answered; what it said is
 *   the caller's problem to judge.
 */
export function isProviderFailure(error: unknown): boolean {
  if (error instanceof ChatConnectionError) return true;
  if (!(error instanceof ChatHttpError)) return false;
  const { status } = error;
  return (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 429 ||
    status >= 500
  );
}

function retryable(error: unknown): boolean {
  if (error instanceof ChatHttpError)
    return error.status === 429 || error.status >= 500;
  // Connection failures (ChatConnectionError) and timeouts are transport
  // faults worth another attempt; a reply that would not parse is not.
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
/** One signal from two, when there are two. `AbortSignal.any` allocates, so the
 * common case of no caller signal keeps the client's own. */
function abortWith(own: AbortSignal, caller?: AbortSignal): AbortSignal {
  return caller === undefined ? own : AbortSignal.any([own, caller]);
}

export function createChatClient(options: ChatClientOptions): ChatFn {
  const {
    baseUrl,
    apiKey,
    timeoutMs = 120_000,
    maxRetries = 3,
    deadline,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = () => {},
  } = options;
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return async function chat(
    request: ChatRequest,
    options?: ChatCallOptions,
  ): Promise<string> {
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
        // A lost connection is named here and at the body read below, where a
        // bare TypeError can only mean that — see ChatConnectionError. Still
        // retried like any transport fault; only what it is called changes.
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
          // Clamped so a request cannot outlive the run's budget — the same
          // idiom the image stage uses against its own stage deadline — and
          // combined with the caller's, which carries a stage cap this client
          // cannot see.
          signal: abortWith(
            AbortSignal.timeout(Math.min(timeoutMs, remainingMs)),
            options?.signal,
          ),
        }).catch(asConnectionError);
        if (!res.ok) {
          // The status is the verdict. A body that could not be read loses the
          // provider's explanation, not the classification: a 400 stays a 400.
          throw new ChatHttpError(res.status, await res.text().catch(() => ""));
        }
        // Read, then parsed, rather than `res.json()`, which rejects with the
        // same kind of error for both. Separately, a connection dropped mid-reply
        // is an outage (retried, and counted by the pipeline's breaker), while
        // a reply that arrived whole but is not JSON stays a SyntaxError — not
        // retried, not an outage. Left unnamed, the first read as neither, and
        // the PDF pass checkpointed its fallback as the batch's settled answer.
        const text = await res.text().catch(asConnectionError);
        const payload = JSON.parse(text) as CompletionPayload;
        const choice = payload.choices?.[0];
        const content = choice?.message?.content;
        // Before the empty check: a reply whose whole budget went on reasoning
        // arrives with no content, and is the case that most needs explaining.
        if (
          typeof choice?.finish_reason === "string" &&
          choice.finish_reason !== "stop"
        ) {
          log(unfinishedReply(choice.finish_reason, payload, content));
        }
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
        // The caller has stopped waiting, so retrying would spend the
        // provider's quota on an answer nobody is going to read. Checked
        // before the budget, because this is the more specific instruction.
        if (options?.signal?.aborted === true) throw error;
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
