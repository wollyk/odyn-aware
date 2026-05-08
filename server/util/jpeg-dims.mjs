// Parse a JPEG buffer's intrinsic width and height by scanning for
// Start-Of-Frame (SOF) markers. We only need the dimensions, not pixels,
// so this avoids pulling in a JPEG decoder.
//
// JPEG markers we care about:
//   SOF0 = 0xC0  — baseline DCT
//   SOF1 = 0xC1
//   SOF2 = 0xC2  — progressive (Frigate's go2rtc usually emits baseline)
//   SOF3, SOF5..7, SOF9..B, SOF13..15  — other variants
//
// Marker payload after the 0xFF<sof> tag:
//   [length:2][precision:1][height:2 BE][width:2 BE][numComponents:1]
//
// All multi-byte fields are big-endian. We skip non-SOF segments by
// reading their length field and jumping forward.
//
// Returns { width, height } or null if not a valid JPEG / no SOF found.

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

/**
 * @param {Buffer} buf
 * @returns {{ width: number, height: number } | null}
 */
export function getJpegDims(buf) {
  if (!buf || buf.length < 4) return null;
  // SOI must be 0xFF 0xD8.
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;

  let i = 2;
  const len = buf.length;
  while (i + 3 < len) {
    if (buf[i] !== 0xff) return null;
    // Skip 0xFF padding (some encoders emit runs of 0xFF before a marker).
    while (i < len && buf[i] === 0xff) i++;
    if (i >= len) return null;
    const marker = buf[i++];
    // Standalone markers without a payload (TEM, RSTn) — no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // EOI ends the stream.
    if (marker === 0xd9) return null;
    if (i + 1 >= len) return null;
    const segLen = (buf[i] << 8) | buf[i + 1];
    if (segLen < 2) return null;
    if (SOF_MARKERS.has(marker)) {
      // payload[0]=precision, payload[1..2]=height, payload[3..4]=width
      if (i + 6 >= len) return null;
      const height = (buf[i + 3] << 8) | buf[i + 4];
      const width = (buf[i + 5] << 8) | buf[i + 6];
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }
    i += segLen;
  }
  return null;
}
