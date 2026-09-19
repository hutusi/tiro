#!/usr/bin/env bun
/**
 * Append the short-link map to dist/_redirects, after the Astro build.
 *
 * The prerendered /s/<id>/ pages already bounce on their own, but only via a
 * meta refresh — a visible flash, and an extra history entry to get wrong.
 * These lines make Cloudflare answer the alias with a real 301 at the edge, the
 * same way public/_redirects already handles /tags/ and /categories/.
 *
 * Written into dist/ and never committed. A file pairing every id with every
 * slug is an enumeration of the vault, which is the thing ADR 0017 keeps out of
 * robots.txt and ADR 0019 refuses to keep in the vault.
 *
 * Reads through `readVault`, the site's one reader of the vault (ADR 0020), so
 * the aliases are built from exactly the set of articles the build turned into
 * pages. It used to walk the directory itself and take every folder holding an
 * index.md, which was the same shortcut `unlisted-slugs.ts` had to give up for
 * the same reason: a PDF stub has an index.md and no body, gets no page, and
 * was handed a /s/ alias pointing at a 404. The collision policy is not
 * restated here; buildShortLinks owns it.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildShortLinks,
  redirectRules,
  reportShortLinks,
} from "../src/lib/short-links.ts";
import { readVault } from "../src/lib/vault-read.ts";
import { hasReadableBody } from "../src/lib/visibility.ts";

// Cloudflare Pages allows 2,000 *static* redirects and 100 dynamic ones, for a
// combined 2,100. Every rule here is static — a short id cannot be expressed as
// a placeholder, since only the map knows which slug it belongs to — so 2,000 is
// the budget, and the extra 100 is not ours to spend. Past it the tail is
// silently ignored rather than rejected, which is why this warns. Well clear at
// 97 articles.
const STATIC_RULE_LIMIT = 2000;

const distRedirects = resolve(import.meta.dirname, "../dist/_redirects");
if (!existsSync(distRedirects)) {
  // public/_redirects is copied here by the build; its absence means this ran
  // against no build at all, and appending would create a file holding only
  // the short links — losing the /tags/ and /categories/ rules.
  throw new Error(
    `no ${distRedirects} — run this after \`astro build\`, not instead of it`,
  );
}

// Only articles the build actually published: an alias is a promise that a
// page is there, and an unconverted PDF stub has none.
const slugs = readVault()
  .filter(hasReadableBody)
  .map((entry) => entry.slug);

const links = buildShortLinks(slugs);
reportShortLinks(links);

const rules = redirectRules(links);

// Rewrite rather than append, dropping any /s/ rules already there, so running
// this twice over one build cannot double the map. The hand-written rules from
// public/_redirects are kept exactly as they are.
const kept = (await Bun.file(distRedirects).text())
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("/s/"));
while (kept.length > 0 && kept[kept.length - 1]?.trim() === "") kept.pop();

const ruleCount =
  kept.filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))
    .length + rules.length;
if (ruleCount > STATIC_RULE_LIMIT) {
  console.warn(
    `short links: ${ruleCount} static redirect rules exceeds Cloudflare's ${STATIC_RULE_LIMIT}; the tail will be ignored at the edge (the /s/ pages still redirect, one hop slower)`,
  );
}

writeFileSync(distRedirects, `${[...kept, "", ...rules].join("\n")}\n`);
console.log(
  `short links: ${rules.length} redirects written to dist/_redirects`,
);
