/**
 * A structurally valid PDF with one text run per page, built rather than
 * committed.
 *
 * This repo holds no content (AGENTS.md) and a PDF is a binary besides. A
 * hand-built file is also the only way to test the page cap and the density
 * gates at their edges, rather than wherever a real document happened to sit.
 *
 * Lives here, beside the code it exercises, because both packages need it: the
 * extraction it feeds is now shared, and the processor still needs a PDF to
 * serve over a fake fetch.
 */

function wrap(text: string, width: number): string[] {
  if (text === "") return [""];
  // The caller's own newlines are real line breaks — a heading sits on its own
  // line in a PDF exactly as it does here — so they are honoured first and each
  // resulting line is then broken to the page width.
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "") {
      lines.push("");
      continue;
    }
    for (let i = 0; i < line.length; i += width) {
      lines.push(line.slice(i, i + width));
    }
  }
  return lines;
}

/** One line of a styled page: text, the size it is set in, and which of the
 * three base-14 faces below. Enough to build a heading hierarchy and a
 * monospace run without committing a binary (ADR 0028). */
export interface StyledLine {
  text: string;
  /** Points. Omitted means body. */
  size?: number;
  /** `helvetica` (default), `bold`, or `courier` — the fixed-width one. */
  face?: "helvetica" | "bold" | "courier";
}

const FACES = {
  helvetica: { id: "F1", base: "Helvetica" },
  bold: { id: "F2", base: "Helvetica-Bold" },
  courier: { id: "F3", base: "Courier" },
} as const;

/**
 * A PDF whose lines carry real sizes and faces.
 *
 * `makePdf` sets everything in 12pt Helvetica, which is exactly the document
 * the layout reader cannot tell anything about — useful for asserting it says
 * so, useless for asserting what it finds.
 */
export function makeStyledPdf(pages: StyledLine[][]): Uint8Array {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${7 + i * 2} 0 R`).join(" ");
  objs[1] = "<</Type/Catalog/Pages 2 0 R>>";
  objs[2] = `<</Type/Pages/Kids[${kids}]/Count ${pages.length}>>`;
  objs[3] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>";
  objs[4] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold>>";
  objs[5] = "<</Type/Font/Subtype/Type1/BaseFont/Courier>>";
  objs[6] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"; // spacer
  const resources = "<</Font<</F1 3 0 R/F2 4 0 R/F3 5 0 R>>>>";

  pages.forEach((lines, i) => {
    const pageNo = 7 + i * 2;
    const contentNo = pageNo + 1;
    objs[pageNo] =
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]${`/Resources${resources}`}/Contents ${contentNo} 0 R>>`;
    let y = 740;
    const runs = lines
      .map((line) => {
        const face = FACES[line.face ?? "helvetica"];
        const size = line.size ?? 11;
        // Absolute placement per line: leading varies with size, and a relative
        // Td would drift a tall heading into the line above it.
        y -= Math.max(14, size + 4);
        const text = line.text.replace(/([()\\])/g, "\\$1");
        return `/${face.id} ${size} Tf 1 0 0 1 72 ${y} Tm (${text}) Tj `;
      })
      .join("");
    const stream = `BT ${runs}ET`;
    objs[contentNo] =
      `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  });

  return assemble(objs);
}

export function makePdf(pageTexts: string[]): Uint8Array {
  const objs: string[] = [];
  const kids = pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs[1] = "<</Type/Catalog/Pages 2 0 R>>";
  objs[2] = `<</Type/Pages/Kids[${kids}]/Count ${pageTexts.length}>>`;
  objs[3] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>";
  pageTexts.forEach((text, i) => {
    const pageNo = 4 + i * 2;
    const contentNo = pageNo + 1;
    objs[pageNo] =
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R>>>>/Contents ${contentNo} 0 R>>`;
    // Wrapped into lines rather than emitted as one run: pdf.js positions
    // glyphs and drops those past the MediaBox edge, so a long single run is
    // silently clipped at the page width — which made a 292-character page
    // extract as 101 and a density test fail for the wrong reason.
    const lines = wrap(text, 70);
    const runs = lines
      .map(
        (line, n) =>
          `${n === 0 ? "" : "0 -14 Td "}(${line.replace(/([()\\])/g, "\\$1")}) Tj `,
      )
      .join("");
    const stream = `BT /F1 12 Tf 72 720 Td ${runs}ET`;
    objs[contentNo] =
      `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  });

  return assemble(objs);
}

/** xref table, trailer and the bytes — the half neither builder cares about. */
function assemble(objs: string[]): Uint8Array {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i += 1) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i += 1) {
    out += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<</Size ${objs.length}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
