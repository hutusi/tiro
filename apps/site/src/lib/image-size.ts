/**
 * Pixel dimensions from an image's header, for the three formats covers are
 * mostly picked from (PNG, JPEG and WebP), and GIF, which article images use
 * and covers do not.
 *
 * The size as a browser shows the image: a JPEG whose EXIF orientation turns
 * it a quarter (5–8) has its width and height swapped. The page sizes the
 * image from these numbers, and the stored ones would draw a portrait photo as
 * a landscape box twice its width.
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
    return png(bytes) ?? jpeg(bytes) ?? webp(bytes) ?? gif(bytes);
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

/**
 * The orientation tag of an APP1 Exif segment whose data starts at `start`,
 * or 1 (upright) when there is none or it cannot be read. A bad EXIF block
 * costs the rotation, never the size.
 */
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  try {
    // "Exif\0\0", then a TIFF header: byte order, 42, offset of IFD0.
    if (ascii(b, start, 6) !== "Exif\0\0") return 1;
    const tiff = start + 6;
    const order = ascii(b, tiff, 2);
    if (order !== "II" && order !== "MM") return 1;
    const little = order === "II";
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const ifd = tiff + view.getUint32(tiff + 4, little);
    const entries = view.getUint16(ifd, little);
    for (let i = 0; i < entries; i += 1) {
      const entry = ifd + 2 + i * 12;
      if (entry + 12 > end) return 1;
      // Tag 0x0112, a SHORT stored in the entry's own value field.
      if (view.getUint16(entry, little) === 0x0112) {
        return view.getUint16(entry + 8, little);
      }
    }
  } catch {
    // Offsets that run past the buffer.
  }
  return 1;
}

/** Walks the marker segments to the first start-of-frame, which carries the
 * size. EXIF and ICC segments come first and can be tens of KB, so the size is
 * not at a fixed offset. The EXIF segment is read on the way, for the
 * orientation. */
function jpeg(b: Uint8Array): ImageSize | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let orientation = 1;
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
      const height = view.getUint16(at + 5);
      const width = view.getUint16(at + 7);
      return orientation >= 5 && orientation <= 8
        ? { width: height, height: width }
        : { width, height };
    }
    const length = view.getUint16(at + 2);
    // The first APP1 that is Exif; XMP also lives in APP1 segments.
    if (marker === 0xe1 && orientation === 1) {
      orientation = exifOrientation(b, at + 4, at + 2 + length);
    }
    at += 2 + length;
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

/** The logical screen size, which every frame is drawn within. */
function gif(b: Uint8Array): ImageSize | null {
  if (b.length < 10 || !/^GIF8[79]a$/.test(ascii(b, 0, 6))) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const size = {
    width: view.getUint16(6, true),
    height: view.getUint16(8, true),
  };
  return size.width > 0 && size.height > 0 ? size : null;
}
