// Parse the raw value of the pairing path-scope input into an array of paths.
// Splits on newline OR comma so the input can hold one path (common case) or
// several. Trailing/leading whitespace is stripped, empty entries are dropped.
export function parsePairingPathScope(rawValue) {
  if (typeof rawValue !== "string") {
    return [];
  }
  return rawValue
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}
