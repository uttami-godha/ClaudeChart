// Mask a value so detector output never echoes raw non-public data.
export function mask(value: string): string {
  if (value.length <= 4) return "****";
  return value.slice(0, 2) + "****" + value.slice(-2);
}