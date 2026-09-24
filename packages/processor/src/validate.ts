import { existsSync } from "node:fs";
import {
  COLLECTIONS_DIR,
  checkAlignment,
  isValidCollectionId,
  parseArticle,
  parseCollection,
  parseCoverPath,
  slugForUrl,
  splitBlocks,
  translationPath,
} from "@tiro/shared";

/** The one language a translation can be in — `translationPath()` names the
 * artifact `zh.md` and the config schema accepts no other target. */
const TRANSLATION_TARGET = "zh";

export interface ValidationReport {
  /** Well-formed `articles/<slug>/index.md` files seen. */
  articles: number;
  /** Well-formed `collections/<id>.md` files seen. */
  collections: number;
  errors: string[];
}

/**
 * Whole-vault contract check: layout, slug determinism, frontmatter schema,
 * and translation presence/alignment.
 *
 * This is the strict gate that `run` deliberately is not — `run` warns and
 * keeps going so one bad file cannot wedge a batch, which means nothing else
 * ever fails on a contract violation. Everything checked here is something
 * the pipeline and the site would otherwise skip in silence.
 */
export async function validateVault(
  vaultDir: string,
): Promise<ValidationReport> {
  const articlesDir = `${vaultDir}/articles`;
  const errors: string[] = [];
  const slugs = new Set<string>();
  const unlisted = new Set<string>();
  let articles = 0;

  // `**`, not `*`: the processor and the site both glob one level deep, so a
  // nested article is invisible to them. Finding it here is the whole point.
  const indexPaths = Array.from(
    new Bun.Glob("**/index.md").scanSync({ cwd: articlesDir }),
  ).sort();

  for (const relPath of indexPaths) {
    const parts = relPath.split("/");
    const slug = parts[0];
    if (parts.length !== 2 || slug === undefined) {
      // The layout is flat (ADR 0007). `git mv` onto an existing directory
      // nests the source into it instead of failing, which is exactly how
      // this state gets created — and it is silent everywhere else.
      errors.push(
        `${relPath}: nested article, expected articles/<slug>/index.md`,
      );
      continue;
    }

    let parsed: ReturnType<typeof parseArticle>;
    try {
      parsed = parseArticle(await Bun.file(`${articlesDir}/${relPath}`).text());
    } catch (error) {
      errors.push(`${relPath}: ${String(error)}`);
      continue;
    }
    articles += 1;
    slugs.add(slug);
    const { frontmatter, body } = parsed;
    if (frontmatter.unlisted === true) unlisted.add(slug);

    // Invariant 2: the path is the identity and is derived from the URL. A
    // slug that no longer matches means the next clip of this page creates a
    // second directory instead of overwriting this one.
    const expected = await slugForUrl(frontmatter.url);
    if (expected !== slug) {
      errors.push(`${relPath}: slug does not match url (expected ${expected})`);
    }

    const zhFile = Bun.file(`${vaultDir}/${translationPath(slug)}`);
    if (!(await zhFile.exists())) {
      // A finished run leaves exactly one of the two behind, so a processed
      // article with neither lost its translation somewhere. Pending articles
      // are exempt: nothing has looked at them yet.
      if (
        frontmatter.tiro.processed_at !== undefined &&
        frontmatter.lang !== TRANSLATION_TARGET &&
        frontmatter.tiro.translation_failed !== true
      ) {
        errors.push(
          `${relPath}: processed as ${frontmatter.lang ?? "an unknown language"} but has neither zh.md nor translation_failed`,
        );
      }
      continue;
    }

    if (frontmatter.lang === TRANSLATION_TARGET) {
      errors.push(
        `${slug}/zh.md: article is already ${TRANSLATION_TARGET}, it must have no translation`,
      );
    } else if (frontmatter.tiro.translation_failed === true) {
      errors.push(
        `${slug}/zh.md: article is marked translation_failed but a translation exists`,
      );
    }
    const alignment = checkAlignment(
      splitBlocks(body),
      splitBlocks(await zhFile.text()),
    );
    if (!alignment.ok) {
      errors.push(`${relPath}: ${alignment.errors.join("; ")}`);
    }
  }

  // A zh.md with no sibling index.md renders for nobody: the site keys
  // translations by directory and joins them onto articles it found.
  const zhPaths = Array.from(
    new Bun.Glob("**/zh.md").scanSync({ cwd: articlesDir }),
  ).sort();
  for (const relPath of zhPaths) {
    const parts = relPath.split("/");
    const slug = parts[0];
    if (parts.length !== 2 || slug === undefined || !slugs.has(slug)) {
      errors.push(`${relPath}: translation with no sibling index.md`);
    }
  }

  const collections = await validateCollections(
    vaultDir,
    slugs,
    unlisted,
    errors,
  );
  return { articles, collections, errors };
}

/**
 * Collections (ADR 0029): every file parses, is named something that can be a
 * filename and a route, lists each member once, names only articles that
 * exist, and has a cover that exists if it names one (ADR 0030).
 *
 * The last is the one that matters most. The site skips a member with no
 * article rather than failing — a missing row, not an error — so a dangling
 * slug left behind by a deleted article or a canonicalization rename is silent
 * everywhere else. Membership is checked against the articles that *parsed*:
 * one that failed to is already reported above, and counting it as present
 * would hide the collection half of the same problem.
 *
 * Anything else in the directory is an error too, not ignored: the site reads
 * only `*.md`, so a stray `favorites.yml` is a collection the owner thinks they
 * have and nothing publishes.
 */
async function validateCollections(
  vaultDir: string,
  slugs: ReadonlySet<string>,
  unlisted: ReadonlySet<string>,
  errors: string[],
): Promise<number> {
  const dir = `${vaultDir}/${COLLECTIONS_DIR}`;
  // No directory is no collections — the state every vault starts in — and
  // Bun's glob throws on a missing root rather than yielding nothing.
  if (!existsSync(dir)) return 0;
  // `dot: true` because the site reads the directory without Bun's glob, and
  // so sees hidden files: a `.reading.md` fails the build as an unusable id,
  // and a validator that skipped it would pass the very vault that build
  // rejects. Other hidden files are ignored rather than refused — nothing
  // reads them, and Finder drops a `.DS_Store` into any folder browsed in a
  // local clone, which is where this runs during a migration.
  const entries = Array.from(
    new Bun.Glob("**/*").scanSync({ cwd: dir, onlyFiles: true, dot: true }),
  )
    .filter((relPath) => {
      const name = relPath.split("/").at(-1) ?? relPath;
      return !(name.startsWith(".") && !name.endsWith(".md"));
    })
    .sort();
  let collections = 0;

  for (const relPath of entries) {
    const where = `${COLLECTIONS_DIR}/${relPath}`;
    if (relPath.includes("/") || !relPath.endsWith(".md")) {
      errors.push(
        `${where}: not a collection, expected ${COLLECTIONS_DIR}/<id>.md`,
      );
      continue;
    }
    const id = relPath.slice(0, -".md".length);
    if (!isValidCollectionId(id)) {
      errors.push(
        `${where}: "${id}" is not a usable collection id — lowercase ascii words joined by single dashes`,
      );
      continue;
    }

    let parsed: ReturnType<typeof parseCollection>;
    try {
      parsed = parseCollection(id, await Bun.file(`${dir}/${relPath}`).text());
    } catch (error) {
      errors.push(`${where}: ${String(error)}`);
      continue;
    }
    collections += 1;

    const seen = new Set<string>();
    for (const { slug } of parsed.frontmatter.items) {
      if (seen.has(slug)) {
        errors.push(`${where}: ${slug} is listed more than once`);
        continue;
      }
      seen.add(slug);
      if (!slugs.has(slug)) {
        errors.push(`${where}: ${slug} is not an article in this vault`);
      }
    }

    // Same split as a dangling member: the site shows a missing cover as the
    // one it would have built anyway, so this is the only place it surfaces.
    // A re-clip can drop the asset (the processor prunes what the body no
    // longer references), which is how a cover that was right goes stale.
    const { cover } = parsed.frontmatter;
    const target = cover === undefined ? null : parseCoverPath(cover);
    if (cover !== undefined && target !== null) {
      if (!slugs.has(target.slug)) {
        errors.push(
          `${where}: cover ${cover} names ${target.slug}, which is not an article in this vault`,
        );
      } else if (!existsSync(`${vaultDir}/${cover}`)) {
        errors.push(`${where}: cover ${cover} does not exist`);
      } else if (unlisted.has(target.slug)) {
        // The site will not show it: the image's path carries the slug, and a
        // public list page naming an unlisted article is the enumeration
        // ADR 0017 exists to remove.
        errors.push(
          `${where}: cover ${cover} belongs to an unlisted article, which the site will not show`,
        );
      }
    }
  }
  return collections;
}
