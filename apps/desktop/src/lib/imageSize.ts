/** A picture's pixel size, read from its header (PNG, JPEG, GIF). Pure —
 *  works in workers and in Node, where there is no `Image`. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = bytes;
  if (b.length < 24) return null;
  const be16 = (i: number) => (b[i] << 8) | b[i + 1];
  const be32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  // PNG: signature, then IHDR with width and height.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: be32(16), height: be32(20) };
  }
  // GIF: logical screen size, little-endian.
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  }
  // JPEG: walk the segments to a start-of-frame marker.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      // SOF0–SOF15, except the non-frame markers DHT (c4), JPG (c8), DAC (cc).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = be16(i + 5);
        const width = be16(i + 7);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      // Markers without a length.
      if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
        i += 2;
        continue;
      }
      i += 2 + be16(i + 2);
    }
  }
  return null;
}

/** The media type the bytes actually are, whatever their name says. */
export function sniffImageType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | null {
  if (bytes.length < 4) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  return null;
}
