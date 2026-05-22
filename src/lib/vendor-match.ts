export function normalizeVendor(desc: string): string {
  return desc.toUpperCase().trim()
    .replace(/\*[A-Z0-9]+$/, '')
    .replace(/\s+#?\d{4,}$/, '')
    .replace(/\s+[A-Z]{2}$/, '')
    .replace(/\s+[A-Z0-9]{8,}$/, '')
    .trim();
}
