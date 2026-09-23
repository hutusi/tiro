import type { FetchLike } from "../src/github.ts";

/**
 * An in-memory repository that speaks just enough of the GitHub API for the
 * collection flush: the branch ref, commits, trees with inline content, and the
 * Contents API read side.
 *
 * It enforces the one rule the flush's correctness rests on — a ref update
 * that is not forced must be a fast-forward — so a concurrent commit is a real
 * refusal here, not a mocked status code. `onBeforePatch` is the hook that
 * lands one.
 */
export interface FakeGitHub {
  fetch: FetchLike;
  /** Files at the branch head. */
  files(): Map<string, string>;
  /** Commit straight to the branch, as another writer would. */
  commitDirect(files: Record<string, string | null>, message?: string): void;
  /** Messages of every commit on the branch, oldest first. */
  log(): string[];
  /** Requests seen, as "METHOD path". */
  requests: string[];
  onBeforePatch?: () => void;
}

interface Commit {
  parent: string | null;
  tree: string;
  message: string;
}

export function fakeGitHub(
  initial: Record<string, string>,
  branch = "main",
): FakeGitHub {
  let seq = 0;
  const sha = (kind: string) =>
    `${kind}${(++seq).toString(16).padStart(6, "0")}`;
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, Commit>();

  const rootTree = sha("t");
  trees.set(rootTree, new Map(Object.entries(initial)));
  const rootCommit = sha("c");
  commits.set(rootCommit, { parent: null, tree: rootTree, message: "root" });
  let head = rootCommit;

  const filesOf = (commit: string) => {
    const c = commits.get(commit);
    if (c === undefined) throw new Error(`no commit ${commit}`);
    const t = trees.get(c.tree);
    if (t === undefined) throw new Error(`no tree ${c.tree}`);
    return t;
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status });

  const fake: FakeGitHub = {
    requests: [],
    files: () => new Map(filesOf(head)),
    log() {
      const out: string[] = [];
      for (
        let c: string | null = head;
        c !== null;
        c = commits.get(c)?.parent ?? null
      ) {
        out.unshift(commits.get(c)?.message ?? "");
      }
      return out;
    },
    commitDirect(changes, message = "direct") {
      const next = new Map(filesOf(head));
      for (const [path, text] of Object.entries(changes)) {
        if (text === null) next.delete(path);
        else next.set(path, text);
      }
      const t = sha("t");
      trees.set(t, next);
      const c = sha("c");
      commits.set(c, { parent: head, tree: t, message });
      head = c;
    },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const path = decodeURIComponent(
        url.pathname.replace(/^\/repos\/o\/r/, ""),
      );
      fake.requests.push(`${method} ${path}`);
      const body =
        init?.body === undefined ? null : JSON.parse(String(init.body));

      if (method === "GET" && path === `/git/ref/heads/${branch}`) {
        return json(200, { object: { sha: head } });
      }
      const commitRead = /^\/git\/commits\/(\w+)$/.exec(path);
      if (method === "GET" && commitRead !== null) {
        const c = commits.get(commitRead[1] ?? "");
        return c === undefined
          ? json(404, {})
          : json(200, { tree: { sha: c.tree } });
      }
      if (method === "GET" && path.startsWith("/contents/")) {
        const file = path.slice("/contents/".length);
        const ref = url.searchParams.get("ref") ?? branch;
        const at = filesOf(ref === branch ? head : ref);
        const text = at.get(file);
        if (text !== undefined) {
          return json(200, {
            sha: `b-${file}`,
            encoding: "base64",
            content: Buffer.from(text, "utf8").toString("base64"),
          });
        }
        // Direct children only, each with its `name`, as GitHub lists them.
        const listing = [
          ...new Set(
            [...at.keys()]
              .filter((p) => p.startsWith(`${file}/`))
              .map((p) => p.slice(file.length + 1).split("/")[0] ?? ""),
          ),
        ];
        return listing.length > 0
          ? json(
              200,
              listing.map((name) => ({ name, path: `${file}/${name}` })),
            )
          : json(404, {});
      }
      if (method === "POST" && path === "/git/trees") {
        const base = trees.get(body.base_tree);
        if (base === undefined) return json(422, { message: "bad base_tree" });
        const next = new Map(base);
        for (const entry of body.tree as { path: string; content: string }[]) {
          next.set(entry.path, entry.content);
        }
        const t = sha("t");
        trees.set(t, next);
        return json(201, { sha: t });
      }
      if (method === "POST" && path === "/git/commits") {
        const c = sha("c");
        commits.set(c, {
          parent: body.parents[0],
          tree: body.tree,
          message: body.message,
        });
        return json(201, { sha: c });
      }
      if (method === "PATCH" && path === `/git/refs/heads/${branch}`) {
        fake.onBeforePatch?.();
        const c = commits.get(body.sha);
        if (c === undefined) return json(422, { message: "no such commit" });
        if (body.force !== true && c.parent !== head) {
          return json(422, { message: "Update is not a fast forward" });
        }
        head = body.sha;
        return json(200, { object: { sha: head } });
      }
      return json(404, { message: `fake: unhandled ${method} ${path}` });
    },
  };
  return fake;
}
