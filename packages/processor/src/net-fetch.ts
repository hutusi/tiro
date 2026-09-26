import { lookup } from "node:dns/promises";
import type { FetchLike } from "./llm/client.ts";
import { SettledRefusal } from "./refusal.ts";

/**
 * Fetching bytes the vault will publish, from a URL a clipped page chose.
 *
 * Every guard here exists because the URL is attacker-influenced: it arrives in
 * an article body that came from a page on the open web, and it is fetched by a
 * workflow runner that can see things the public cannot. The rules are the
 * image stage's, generalised rather than rewritten — it is the stage that
 * learned them, over four rounds of review on the IPv6 table alone.
 *
 * They live here because a second stage now fetches remote bytes under the same
 * threat, and two copies of an SSRF guard drift: the copy that is not the one
 * being reviewed is the one that keeps the hole. Invariant 7 asks each per-item
 * failure to degrade rather than fail the run, and a guard that is only half
 * present cannot promise that.
 *
 * What this does *not* defend against is DNS rebinding — see
 * `assertPublicAddresses`. The caller's content-type gate is what keeps a
 * rebound response out of the vault.
 */

/** A browser-ish UA defuses most hotlink protection. Callers add their own
 * `Referer`, which is the other half of that. */
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Injectable so tests never touch a resolver. */
export type ResolveHost = (hostname: string) => Promise<string[]>;

const PRIVATE_NAME_RE = /^(localhost|.+\.localhost|.+\.local|.+\.internal)$/i;

/** Non-public IPv4 space: the private ranges plus RFC 6890's special-purpose
 * ones. 100.64/10 matters most of the additions — carrier-grade NAT is real
 * infrastructure a resolver can genuinely answer with, not a documentation
 * range. */
function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m === null) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  return (
    a === 0 || // 0/8 "this network"
    a === 10 || // 10/8 private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 carrier-grade NAT
    (a === 169 && b === 254) || // link-local incl. cloud metadata endpoints
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 private
    (a === 192 && b === 0 && c === 0) || // 192.0.0/24 protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) || // 192.168/16 private
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast and reserved, 240/4 included
  );
}

/**
 * Reject obviously non-public hosts so a malicious clipped page cannot point
 * the workflow at loopback/link-local/private services (e.g. cloud metadata).
 * Applied to every redirect hop rather than only the URL the article names —
 * a public host answering 302 to 169.254.169.254 is the cheap version of this
 * attack — and to whatever each hop resolves to, since the name alone proves
 * nothing (`assertPublicAddresses`).
 */
function isForbiddenHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (PRIVATE_NAME_RE.test(host)) return true;
  if (isPrivateIpv4(host)) return true;
  if (host.includes(":")) return isPrivateIpv6(host);
  return false;
}

/**
 * Is this address outside publicly routable IPv6?
 *
 * Stated as an allowlist, because the denylist could not be finished. IANA
 * keeps adding special-purpose ranges — 100:0:0:1::/64 is RFC 9780, 2025 —
 * and four consecutive rounds of review each found another one the table had
 * missed. Enumerating a growing set will always lag it.
 *
 * Public IPv6 is allocated solely from 2000::/3, so everything else is
 * unassigned or special-purpose and cannot be an image host. That one test
 * covers ::/96, ::ffff:0:0/96, both NAT64 prefixes, both 100::/64 blocks,
 * fc00::/7, fe80::/10, fec0::/10 and ff00::/8 at once — including ranges not
 * yet written down.
 *
 * Only four carve-outs sit inside 2000::/3, and they are stable. Note that
 * 2001::/23 has to be masked rather than prefix-matched, or it would swallow
 * 2001:4860:4860::8888.
 *
 * A false reject costs one hotlinked image and never fails an article, while a
 * miss is an SSRF vector — so an address this cannot parse is refused too.
 */
function isPrivateIpv6(host: string): boolean {
  const h = expandIpv6(host);
  if (h === null) return true;
  const [h0, h1] = h as [number, number];
  if ((h0 & 0xe000) !== 0x2000) return true; // outside global unicast
  return (
    (h0 === 0x2001 && (h1 & 0xfe00) === 0x0000) || // 2001::/23 IETF protocols
    (h0 === 0x2001 && h1 === 0x0db8) || // 2001:db8::/32 documentation
    h0 === 0x2002 || // 2002::/16 6to4 — embeds IPv4
    (h0 === 0x3fff && (h1 & 0xf000) === 0x0000) // 3fff::/20 documentation
  );
}

/** Eight hextets, or null if this is not an address we can read. Handles `::`
 * compression and a trailing dotted-quad; the hostname arrives normalised from
 * `new URL()`, but the parse stays defensive because the alternative to
 * understanding an address is fetching it. */
function expandIpv6(host: string): number[] | null {
  let text = host;
  const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted?.[1] !== undefined) {
    const octets = dotted[1].split(".").map(Number);
    if (octets.some((o) => Number.isNaN(o) || o > 255)) return null;
    const [a, b, c, d] = octets as [number, number, number, number];
    text = `${text.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const gap = 8 - head.length - tail.length;
  if (gap < 1) return null;
  return [...head, ...new Array<number>(gap).fill(0), ...tail];
}

/** Literal addresses were already judged by `isForbiddenHost`; resolving one
 * would just hand the same string back. */
function isIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** Reject if `promise` has not settled within `ms`.
 *
 * `AbortSignal.timeout` reaches `fetch` and nothing else, and resolution
 * happens before the request exists — so without this an unbounded lookup lets
 * a single image outrun the whole stage budget. The losing promise keeps
 * running: `dns.lookup` has no abort, and the OS resolver will settle it in
 * its own time. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      Math.max(0, ms),
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export async function resolveViaDns(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true });
  return results.map((entry) => entry.address);
}

/**
 * A hostname's *text* can look public while its record points at loopback or
 * the metadata endpoint — `127.0.0.1.nip.io` is the ready-made version, and
 * `169-254-169-254.nip.io` aims at exactly what the name guard exists to
 * protect. Resolve it and apply the same address rules.
 *
 * This closes static mappings, which is the attack that needs no
 * infrastructure. It is not proof against DNS rebinding: `fetch` cannot be
 * pinned to the address checked here, so a name that answers differently on
 * the connection's own lookup still gets through, and nothing downstream
 * prevents that — by the time the content-type and extension gates run, the
 * request has already been sent. What those gates still do is keep the
 * response out of the vault, so a rebind leaks nothing to the public site.
 * The request itself is the residual risk.
 */
async function assertPublicAddresses(
  hostname: string,
  resolveHost: ResolveHost,
  budgetMs: number,
): Promise<void> {
  if (isIpLiteral(hostname)) return;
  let addresses: string[];
  try {
    addresses = await withTimeout(
      resolveHost(hostname),
      budgetMs,
      `resolving ${hostname}`,
    );
  } catch (error) {
    throw new Error(`cannot resolve ${hostname}: ${String(error)}`);
  }
  for (const address of addresses) {
    if (isForbiddenHost(address)) {
      // Settled: where a name points does not change by asking again.
      throw new SettledRefusal(`${hostname} resolves to a non-public address`);
    }
  }
}

const MAX_REDIRECTS = 5;

/** fetch() follows redirects itself, which would apply the host guard only to
 * the URL the article names. Follow them by hand so every hop is checked. */
export async function fetchChecked(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  allowPrivateHosts: boolean,
  resolveHost: ResolveHost,
  /** Re-read per hop: every lookup draws from the same shrinking budget the
   * request already respects, so six redirects cannot multiply it. */
  budgetMs: () => number,
): Promise<Response> {
  return (
    await fetchCheckedWithUrl(
      url,
      init,
      fetchImpl,
      allowPrivateHosts,
      resolveHost,
      budgetMs,
    )
  ).response;
}

/**
 * `fetchChecked`, also saying where the redirects ended. A page read at an
 * address other than the one saved needs that address as its base, or its
 * relative links resolve against the wrong page — and `Response.url` cannot be
 * trusted for it, being empty for a response this code did not get from
 * `fetch` itself.
 */
export async function fetchCheckedWithUrl(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  allowPrivateHosts: boolean,
  resolveHost: ResolveHost,
  budgetMs: () => number,
): Promise<{ response: Response; url: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const hostname = new URL(current).hostname;
    if (!allowPrivateHosts) {
      if (isForbiddenHost(hostname)) {
        throw new SettledRefusal("non-public host");
      }
      await assertPublicAddresses(hostname, resolveHost, budgetMs());
    }
    const res = await fetchImpl(current, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) {
      return { response: res, url: current };
    }
    const location = res.headers.get("location");
    if (location === null) {
      throw new Error(`redirect ${res.status} without a location header`);
    }
    current = new URL(location, current).toString();
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`);
}

/** Read the body incrementally so a server that omits or lies about
 * Content-Length cannot buffer past the cap. */
export async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = res.body?.getReader();
  if (reader === undefined) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes)
      throw new SettledRefusal(`too large: ${bytes.byteLength} bytes`);
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SettledRefusal(`too large: exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
