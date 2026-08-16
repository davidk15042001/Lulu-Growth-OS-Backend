const MOJIBAKE_MARKERS = /[ÃÂâð�]/;

export function normalizeUploadedFileName(value: string) {
  const trimmed = value.trim();
  if (!MOJIBAKE_MARKERS.test(trimmed)) return trimmed;

  const decoded = Buffer.from(trimmed, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? trimmed : decoded;
}

export function sanitizeUploadedFileName(value: string) {
  return normalizeUploadedFileName(value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 255);
}
