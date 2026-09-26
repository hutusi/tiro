/** The structural `fetch` the clip functions take, so a caller can inject its
 * own — the extension's, or a guarded one that refuses private hosts. Not
 * `typeof fetch`, whose Bun type demands `preconnect`. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
