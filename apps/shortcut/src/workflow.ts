/**
 * The "Save to Tiro" iPhone shortcut, as data (ADR 0034; docs/operations.md,
 * "Saving from iPhone").
 *
 * A share-sheet shortcut that writes the shared link into the vault's
 * `inbox/` through GitHub's Contents API, where the next processing run makes
 * it an article. Built here rather than by hand so it can be rebuilt, and so
 * the three things a hand-written shortcut file got wrong stay fixed — each
 * cost a failed install on a real phone:
 *
 * - **Accept what apps actually share.** A shortcut accepting only URLs and
 *   Safari pages received a shared article as no input at all, fell back to an
 *   empty clipboard, and saved nothing.
 * - **A text field takes text with the variable in it**, not a bare variable
 *   reference: Expand URL's and Get URLs from Input's inputs came through empty
 *   that way and saved 0-byte inbox files.
 * - **Never save nothing.** A guard before the upload shows what arrived and
 *   stops, instead of committing an empty file the processor can only reject.
 *
 * The file format is Apple's and undocumented; the shapes here follow real
 * shortcuts and Federico Viticci's notes on generating them. The token is
 * never in the file: an import question asks for it when the shortcut is added.
 */

/** Where a variable sits inside a text field. */
const OBJ = "￼";

export type PlistValue =
  | string
  | number
  | boolean
  | PlistValue[]
  | { [key: string]: PlistValue };

type Dict = { [key: string]: PlistValue };

let counter = 0;
/** Stable across builds, so a rebuild with nothing changed is the same file. */
function uuid(name: string): string {
  counter += 1;
  const hex = [...new TextEncoder().encode(`tiro-shortcut:${name}`)]
    .reduce(
      (h, b) => (Math.imul(h ^ b, 0x01000193) >>> 0) as number,
      0x811c9dc5,
    )
    .toString(16)
    .padStart(8, "0");
  return `${hex.toUpperCase()}-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

const output = (name: string, id: string): Dict => ({
  OutputName: name,
  OutputUUID: id,
  Type: "ActionOutput",
});

const shortcutInput: Dict = { Type: "ExtensionInput" };

/** A variable as data flowing between actions. */
const attach = (value: Dict): Dict => ({
  Value: value,
  WFSerializationType: "WFTextTokenAttachment",
});

/** A text field: `template` with `OBJ` where each of `vars` goes, in order.
 * Ranges count UTF-16 units, which is what JavaScript string indices are. */
function text(template: string, ...vars: Dict[]): Dict {
  const ranges: Dict = {};
  let next = 0;
  for (let i = 0; i < template.length; i++) {
    if (template[i] !== OBJ) continue;
    const variable = vars[next];
    if (variable === undefined)
      throw new Error(`no variable for ${OBJ} ${next}`);
    ranges[`{${i}, 1}`] = variable;
    next += 1;
  }
  if (next !== vars.length) throw new Error("more variables than placeholders");
  return {
    Value: { string: template, attachmentsByRange: ranges },
    WFSerializationType: "WFTextTokenString",
  };
}

const field = (key: string, value: Dict): Dict => ({
  WFItemType: 0,
  WFKey: text(key),
  WFValue: value,
});

const dictionary = (...items: Dict[]): Dict => ({
  Value: { WFDictionaryFieldValueItems: items },
  WFSerializationType: "WFDictionaryFieldValue",
});

const action = (identifier: string, parameters: Dict = {}): Dict => ({
  WFWorkflowActionIdentifier: `is.workflow.actions.${identifier}`,
  WFWorkflowActionParameters: parameters,
});

/** The share-sheet types the shortcut accepts. A type left off this list
 * reaches the shortcut as no input at all. */
export const INPUT_CLASSES = [
  "WFURLContentItem",
  "WFSafariWebPageContentItem",
  "WFStringContentItem",
  "WFRichTextContentItem",
  "WFArticleContentItem",
];

export interface ShortcutOptions {
  /** The import question's default: the vault as `owner/name`. */
  repo?: string;
}

export function saveToTiroWorkflow({
  repo = "owner/tiro-vault",
}: ShortcutOptions = {}): Dict {
  counter = 0;
  const id = {
    token: uuid("token"),
    repo: uuid("repo"),
    urls: uuid("urls"),
    item: uuid("item"),
    expanded: uuid("expanded"),
    body: uuid("body"),
    base64: uuid("base64"),
    date: uuid("date"),
    random: uuid("random"),
    name: uuid("name"),
    put: uuid("put"),
    value: uuid("value"),
  };
  const guard = uuid("guard");
  const saved = uuid("saved");
  const expanded = output("Expanded URL", id.expanded);

  const actions: Dict[] = [
    // 0, 1 — answered by the import questions below.
    action("gettext", {
      UUID: id.token,
      WFTextActionText: text("PASTE-YOUR-PHONE-TOKEN"),
    }),
    action("gettext", { UUID: id.repo, WFTextActionText: text(repo) }),
    action("detect.link", {
      UUID: id.urls,
      WFInput: text(OBJ, shortcutInput),
    }),
    action("getitemfromlist", {
      UUID: id.item,
      WFItemSpecifier: "First Item",
      WFInput: attach(output("URLs", id.urls)),
    }),
    // A t.co or bit.ly link would otherwise be filed under the shortener, and
    // the same page clipped in a browser would be a second article.
    action("url.expand", {
      UUID: id.expanded,
      URL: text(OBJ, output("Item from List", id.item)),
    }),
    // Never save nothing: say what arrived instead, and stop.
    action("conditional", {
      GroupingIdentifier: guard,
      WFControlFlowMode: 0,
      WFCondition: 101, // does not have any value
      WFInput: { Type: "Variable", Variable: attach(expanded) },
    }),
    action("alert", {
      WFAlertActionTitle: "No link to save",
      WFAlertActionMessage: text(
        `Share a web page or a link, or copy one first. Received: ${OBJ}`,
        shortcutInput,
      ),
      WFAlertActionCancelButtonShown: false,
    }),
    action("exit"),
    action("conditional", {
      GroupingIdentifier: guard,
      WFControlFlowMode: 2,
      UUID: uuid("guard-end"),
    }),
    // The file: the link, and nothing else.
    action("gettext", { UUID: id.body, WFTextActionText: text(OBJ, expanded) }),
    // The Contents API rejects wrapped base64.
    action("base64encode", {
      UUID: id.base64,
      WFEncodeMode: "Encode",
      WFBase64LineBreakMode: "None",
      WFInput: attach(output("Text", id.body)),
    }),
    action("format.date", {
      UUID: id.date,
      WFDateFormatStyle: "Custom",
      WFDateFormat: "yyyyMMdd-HHmmss",
      WFDate: text(OBJ, { Type: "CurrentDate" }),
    }),
    // Two saves in one second must not collide.
    action("number.random", {
      UUID: id.random,
      WFRandomNumberMinimum: 1000,
      WFRandomNumberMaximum: 9999,
    }),
    action("gettext", {
      UUID: id.name,
      WFTextActionText: text(
        `${OBJ}-${OBJ}.url`,
        output("Formatted Date", id.date),
        output("Random Number", id.random),
      ),
    }),
    action("downloadurl", {
      UUID: id.put,
      WFURL: text(
        `https://api.github.com/repos/${OBJ}/contents/inbox/${OBJ}`,
        output("Text", id.repo),
        output("Text", id.name),
      ),
      WFHTTPMethod: "PUT",
      ShowHeaders: true,
      WFHTTPHeaders: dictionary(
        field("Authorization", text(`Bearer ${OBJ}`, output("Text", id.token))),
        field("Accept", text("application/vnd.github+json")),
        field("X-GitHub-Api-Version", text("2022-11-28")),
      ),
      WFHTTPBodyType: "JSON",
      WFJSONValues: dictionary(
        field("message", text(`save: ${OBJ}`, expanded)),
        field("content", text(OBJ, output("Base64 Encoded", id.base64))),
      ),
    }),
    action("getvalueforkey", {
      UUID: id.value,
      WFGetDictionaryValueType: "Value",
      WFDictionaryKey: "content",
      WFInput: attach(output("Contents of URL", id.put)),
    }),
    // GitHub answers a created file with its `content`; anything else is an
    // error whose own message says what went wrong — a 401 is the token, a 404
    // the repository or a token that cannot see it.
    action("conditional", {
      GroupingIdentifier: saved,
      WFControlFlowMode: 0,
      WFCondition: 100, // has any value
      WFInput: {
        Type: "Variable",
        Variable: attach(output("Dictionary Value", id.value)),
      },
    }),
    action("notification", {
      WFNotificationActionTitle: "Tiro",
      WFNotificationActionBody: text("Saved to Tiro"),
    }),
    action("conditional", { GroupingIdentifier: saved, WFControlFlowMode: 1 }),
    action("alert", {
      WFAlertActionTitle: "Could not save to Tiro",
      WFAlertActionMessage: text(OBJ, output("Contents of URL", id.put)),
      WFAlertActionCancelButtonShown: false,
    }),
    action("conditional", {
      GroupingIdentifier: saved,
      WFControlFlowMode: 2,
      UUID: uuid("saved-end"),
    }),
  ];

  return {
    WFWorkflowClientVersion: "2607.0.2",
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: "900",
    // Apple's palette red, the nearest to Tiro's oxblood; the glyph is picked
    // on the phone, since glyph numbers are undocumented.
    WFWorkflowIcon: {
      WFWorkflowIconStartColor: 4282601983,
      WFWorkflowIconGlyphNumber: 59511,
    },
    WFWorkflowTypes: ["ActionExtension"], // Show in Share Sheet
    WFWorkflowInputContentItemClasses: INPUT_CLASSES,
    WFWorkflowHasShortcutInputVariables: true,
    // Run from the home screen or a widget: take a link from the clipboard.
    WFWorkflowNoInputBehavior: {
      Name: "WFWorkflowNoInputBehaviorGetClipboard",
      Parameters: {},
    },
    WFWorkflowOutputContentItemClasses: [],
    WFQuickActionSurfaces: [],
    WFWorkflowImportQuestions: [
      {
        ActionIndex: 0,
        Category: "Parameter",
        ParameterKey: "WFTextActionText",
        DefaultValue: "",
        Text: "Your phone token: a fine-grained GitHub PAT for the vault only, Contents: Read and write",
      },
      {
        ActionIndex: 1,
        Category: "Parameter",
        ParameterKey: "WFTextActionText",
        DefaultValue: repo,
        Text: "The vault repository, as owner/name",
      },
    ],
    WFWorkflowActions: actions,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** An XML property list, the unsigned form `shortcuts sign` takes. */
export function toPlistXml(value: PlistValue): string {
  const render = (v: PlistValue, indent: string): string => {
    if (typeof v === "string")
      return `${indent}<string>${escapeXml(v)}</string>`;
    if (typeof v === "boolean") return `${indent}<${v}/>`;
    if (typeof v === "number") {
      if (!Number.isInteger(v)) throw new Error(`not an integer: ${v}`);
      return `${indent}<integer>${v}</integer>`;
    }
    const inner = `${indent}\t`;
    if (Array.isArray(v)) {
      if (v.length === 0) return `${indent}<array/>`;
      return `${indent}<array>\n${v.map((x) => render(x, inner)).join("\n")}\n${indent}</array>`;
    }
    const entries = Object.entries(v);
    if (entries.length === 0) return `${indent}<dict/>`;
    return `${indent}<dict>\n${entries
      .map(
        ([k, x]) => `${inner}<key>${escapeXml(k)}</key>\n${render(x, inner)}`,
      )
      .join("\n")}\n${indent}</dict>`;
  };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    render(value, ""),
    "</plist>",
    "",
  ].join("\n");
}
