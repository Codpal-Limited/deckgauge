export type ImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/**
 * An image's type, read from its first bytes — never from a declared
 * Content-Type or file extension, which the sender controls. Anything that is
 * not one of the four raster formats (SVG and HTML included) is `null`.
 */
export function sniffImageType(buf: Buffer): ImageMimeType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}
