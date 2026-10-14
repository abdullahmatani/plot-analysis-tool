/** Random identifiers (crypto-strength, no network). */
export function newId(prefix = ''): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(36).padStart(2, '0');
  return prefix ? `${prefix}_${s}` : s;
}

export function nowIso(): string {
  return new Date().toISOString();
}
