import { describe, expect, test } from "bun:test";
import { renderBlockHtml } from "../src/lib/render.ts";

const STILL = "https://i.ytimg.com/vi/Jg7ooLzzXeg/hqdefault.jpg";

/** ADR 0040: a picture that opens a video carries the badge's class. */
describe("a picture that opens a video", () => {
  test("is marked when it links to a YouTube watch page", () => {
    const html = renderBlockHtml(
      `[![Video](${STILL})](https://www.youtube.com/watch?v=Jg7ooLzzXeg&t=543s)`,
      "s",
    );
    expect(html).toContain(
      '<a href="https://www.youtube.com/watch?v=Jg7ooLzzXeg&#x26;t=543s" class="video-link">',
    );
  });

  test("is marked when it links to Vimeo, The Atlantic's video page or a video file", () => {
    for (const href of [
      "https://vimeo.com/76979871",
      "https://vimeo.com/76979871/8272103f6e",
      "https://www.theatlantic.com/video/index/595672/",
      "https://schlarp.example/posts/led-before-after.mp4",
      "https://youtu.be/Jg7ooLzzXeg",
    ]) {
      expect(renderBlockHtml(`[![Video](${STILL})](${href})`, "s")).toContain(
        'class="video-link"',
      );
    }
  });

  test("is marked inside a captioned figure", () => {
    const html = renderBlockHtml(
      `[![Video](${STILL})](https://www.youtube.com/watch?v=Jg7ooLzzXeg)  \nHinton on machine consciousness.`,
      "s",
    );
    expect(html).toContain("<figure>");
    expect(html).toContain('class="video-link"');
  });

  test("is not marked when the picture links to an ordinary page", () => {
    for (const href of [
      "https://schlarp.example/posts/",
      "https://www.youtube.com/@channel",
      "https://schlarp.example/?next=https://www.youtube.com/watch?v=x",
    ]) {
      expect(
        renderBlockHtml(`[![Photo](${STILL})](${href})`, "s"),
      ).not.toContain("video-link");
    }
  });

  test("a text link to a video says what it is in its own words", () => {
    expect(
      renderBlockHtml(
        "[Video](https://www.theatlantic.com/video/index/595672/)",
        "s",
      ),
    ).not.toContain("video-link");
  });

  test("clipped markup cannot claim the class", () => {
    // Sanitize strips a page's own class; only the pass may add it back, and
    // it adds it only where the link really opens a video.
    const html = renderBlockHtml(
      `<a class="video-link" href="https://schlarp.example/"><img src="${STILL}" alt=""></a>`,
      "s",
    );
    expect(html).toContain("<img");
    expect(html).not.toContain("video-link");
  });
});
