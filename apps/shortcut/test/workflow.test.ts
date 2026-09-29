import { describe, expect, test } from "bun:test";
import {
  INPUT_CLASSES,
  type PlistValue,
  saveToTiroWorkflow,
  toPlistXml,
} from "../src/workflow.ts";

type Dict = { [key: string]: PlistValue };

const workflow = saveToTiroWorkflow({ repo: "someone/tiro-vault" });
const actions = workflow.WFWorkflowActions as Dict[];
const ids = actions.map((a) =>
  String(a.WFWorkflowActionIdentifier).replace("is.workflow.actions.", ""),
);
const params = (identifier: string, nth = 0): Dict =>
  actions.filter(
    (a) => a.WFWorkflowActionIdentifier === `is.workflow.actions.${identifier}`,
  )[nth]?.WFWorkflowActionParameters as Dict;

describe("the Save to Tiro shortcut", () => {
  test("accepts what apps actually share, not only URLs and Safari pages", () => {
    // With only those two, a shared article reached it as no input at all.
    expect(workflow.WFWorkflowTypes).toEqual(["ActionExtension"]);
    expect(workflow.WFWorkflowInputContentItemClasses).toEqual(INPUT_CLASSES);
    for (const type of [
      "WFStringContentItem",
      "WFRichTextContentItem",
      "WFArticleContentItem",
    ]) {
      expect(INPUT_CLASSES).toContain(type);
    }
  });

  test("hands text fields text with the variable in it, never a bare reference", () => {
    // A bare reference here came through empty and saved 0-byte files.
    const links = params("detect.link").WFInput as Dict;
    expect(links.WFSerializationType).toBe("WFTextTokenString");
    expect(JSON.stringify(links)).toContain("ExtensionInput");
    const expand = params("url.expand").URL as Dict;
    expect(expand.WFSerializationType).toBe("WFTextTokenString");
  });

  test("stops, and says what arrived, before it could upload nothing", () => {
    const guard = ids.indexOf("conditional");
    expect(guard).toBeGreaterThan(ids.indexOf("url.expand"));
    expect(guard).toBeLessThan(ids.indexOf("downloadurl"));
    expect(params("conditional").WFCondition).toBe(101); // no value
    expect(ids.slice(guard, guard + 4)).toEqual([
      "conditional",
      "alert",
      "exit",
      "conditional",
    ]);
  });

  test("puts the link in the vault's inbox, as the processor expects", () => {
    const put = params("downloadurl");
    expect(put.WFHTTPMethod).toBe("PUT");
    const url = JSON.stringify(put.WFURL);
    expect(url).toContain("https://api.github.com/repos/");
    expect(url).toContain("/contents/inbox/");
    expect(params("base64encode").WFBase64LineBreakMode).toBe("None");
  });

  test("asks for the token at import, and carries none", () => {
    const questions = workflow.WFWorkflowImportQuestions as Dict[];
    expect(questions.map((q) => [q.ActionIndex, q.ParameterKey])).toEqual([
      [0, "WFTextActionText"],
      [1, "WFTextActionText"],
    ]);
    expect(questions[1]?.DefaultValue).toBe("someone/tiro-vault");
    expect(ids.slice(0, 2)).toEqual(["gettext", "gettext"]);
    const file = toPlistXml(workflow);
    expect(file).toContain("PASTE-YOUR-PHONE-TOKEN");
    expect(file).not.toMatch(/github_pat_|ghp_/);
  });

  test("builds the same file twice", () => {
    expect(toPlistXml(saveToTiroWorkflow())).toBe(
      toPlistXml(saveToTiroWorkflow()),
    );
  });
});

describe("toPlistXml", () => {
  test("escapes what XML would misread", () => {
    expect(toPlistXml({ a: "x < y & z" })).toContain(
      "<string>x &lt; y &amp; z</string>",
    );
  });

  test.skipIf(process.platform !== "darwin")(
    "is a property list macOS reads back as the same data",
    async () => {
      const path = `${process.env.TMPDIR ?? "/tmp"}/tiro-shortcut-test.plist`;
      await Bun.write(path, toPlistXml(workflow));
      const json = Bun.spawnSync([
        "plutil",
        "-convert",
        "json",
        "-o",
        "-",
        path,
      ]);
      expect(json.exitCode).toBe(0);
      expect(JSON.parse(json.stdout.toString())).toEqual(workflow);
    },
  );
});
