/**
 * Pixel dimensions from an image's header, for the three formats covers are
 * mostly picked from: PNG, JPEG and WebP.
 *
 * Never throws. Anything it cannot read — another format, a truncated file, a
 * header it does not recognise — is null, and the caller decides what an
 * unknown size means. That is the whole difference from the image pipeline ADR
 * 0020 removed: there, one unmeasurable asset failed the build; here it only
 * stops being a cover candidate.
 */
export interface ImageSize {
  width: number;
  height: number;
}

export function imageSize(bytes: Uint8Array): ImageSize | null {
  try {
    return png(bytes) ?? jpeg(bytes) ?? webp(bytes);
  } catch {
    return null;
  }
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

function png(b: Uint8Array): ImageSize | null {
  if (b.length < 24 || ascii(b, 1, 3) !== "PNG" || ascii(b, 12, 4) !== "IHDR") {
    return null;
  }
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Walks the marker segments to the first start-of-frame, which carries the
 * size. EXIF and ICC segments come first and can be tens of KB, so the size is
 * not at a fixed offset. */
function jpeg(b: Uint8Array): ImageSize | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1] ?? 0;
    // Fill bytes, and the markers that stand alone without a length.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // SOF0–SOF15, minus DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
    }
    at += 2 + view.getUint16(at + 2);
  }
  return null;
}

function webp(b: Uint8Array): ImageSize | null {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") {
    return null;
  }
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    const bits = view.getUint32(21, true);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === "VP8X") {
    const u24 = (at: number) =>
      (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
    return { width: 1 + u24(24), height: 1 + u24(27) };
  }
  return null;
}
