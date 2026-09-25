import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { imageSize } from "../src/lib/image-size.ts";

function bytes(...parts: (number[] | string)[]): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      for (const ch of part) out.push(ch.charCodeAt(0));
    } else out.push(...part);
  }
  return new Uint8Array(out);
}
const u16be = (n: number) => [n >> 8, n & 0xff];
const u16le = (n: number) => [n & 0xff, n >> 8];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, n >> 16];
const u32be = (n: number) => [
  n >>> 24,
  (n >> 16) & 0xff,
  (n >> 8) & 0xff,
  n & 0xff,
];

function pngHeader(width: number, height: number): Uint8Array {
  return bytes(
    [0x89],
    "PNG\r\n\x1a\n",
    u32be(13),
    "IHDR",
    u32be(width),
    u32be(height),
    [8, 6, 0, 0, 0],
  );
}

describe("imageSize", () => {
  test("PNG, from IHDR", () => {
    expect(imageSize(pngHeader(1200, 630))).toEqual({
      width: 1200,
      height: 630,
    });
  });

  // The size is not at a fixed offset: EXIF and ICC segments come first.
  test("JPEG, walking past earlier segments to the frame header", () => {
    const exif = new Array(300).fill(0);
    const jpeg = bytes(
      [0xff, 0xd8],
      [0xff, 0xe1],
      u16be(exif.length + 2),
      exif,
      [0xff, 0xc4], // DHT shares the SOF range and must be skipped
      u16be(4),
      [0, 0],
      [0xff, 0xff], // fill byte
      [0xff, 0xc2], // progressive
      u16be(17),
      [8],
      u16be(480), // height first
      u16be(640),
      [3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1],
    );
    expect(imageSize(jpeg)).toEqual({ width: 640, height: 480 });
  });

  test("WebP in all three chunk forms", () => {
    const riff = (chunk: string, payload: number[]) =>
      bytes("RIFF", u32be(0), "WEBP", chunk, u32be(0), payload);
    // Lossy: a 3-byte frame tag and a start code, then 14-bit sizes.
    expect(
      imageSize(
        riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(800), ...u16le(450)]),
      ),
    ).toEqual({ width: 800, height: 450 });
    // Lossless: a signature byte, then width-1 and height-1 in 14 bits each.
    const w = 300 - 1;
    const h = 200 - 1;
    const packed = w | (h << 14);
    expect(
      imageSize(
        riff("VP8L", [
          0x2f,
          packed & 0xff,
          (packed >> 8) & 0xff,
          (packed >> 16) & 0xff,
          packed >>> 24,
          0,
          0,
          0,
          0,
          0,
          0,
        ]),
      ),
    ).toEqual({ width: 300, height: 200 });
    // Extended: flags, then 24-bit width-1 and height-1.
    expect(
      imageSize(
        riff("VP8X", [0, 0, 0, 0, ...u24le(1919), ...u24le(1079), 0, 0]),
      ),
    ).toEqual({ width: 1920, height: 1080 });
  });

  test("anything else is unknown rather than an error", () => {
    expect(imageSize(new Uint8Array())).toBeNull();
    expect(
      imageSize(bytes("<svg xmlns='http://www.w3.org/2000/svg'/>")),
    ).toBeNull();
    expect(imageSize(bytes("GIF89a", [1, 0, 1, 0]))).toBeNull();
    // Truncated mid-segment.
    expect(
      imageSize(bytes([0xff, 0xd8, 0xff, 0xe1], u16be(9000), [0, 0])),
    ).toBeNull();
    // A PNG signature with no IHDR behind it.
    expect(imageSize(pngHeader(10, 10).subarray(0, 20))).toBeNull();
  });

  test("reads the fixture vault's JPEGs, written by a real encoder", () => {
    const file = join(
      import.meta.dir,
      "../../../fixtures/vault/articles/example-net-papers-attention-notes-278b43cb/assets/5b0e1f7c2a91.jpg",
    );
    expect(imageSize(readFileSync(file))).toEqual({ width: 640, height: 400 });
  });
});
