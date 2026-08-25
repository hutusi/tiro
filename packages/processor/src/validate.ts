import {
  checkAlignment,
  parseArticle,
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

  return { articles, errors };
}
