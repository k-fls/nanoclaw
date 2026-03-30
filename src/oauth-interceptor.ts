/**
 * JSON body helper for OAuth token swapping.
 *
 * Preserves field order via string manipulation — no parse/serialize round-trip.
 */

/**
 * Replace a string value for a given key in a JSON string, preserving
 * all other content byte-for-byte (field order, whitespace, other fields).
 *
 * Only handles simple string values — not nested objects, arrays, or numbers.
 * Sufficient for OAuth token fields (access_token, refresh_token, etc).
 */
export function replaceJsonStringValue(
  json: string,
  key: string,
  newValue: string,
): string {
  // Match "key" : "value" with flexible whitespace
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`("${escaped}"\\s*:\\s*)"((?:[^"\\\\]|\\\\.)*)"`);
  const match = re.exec(json);
  if (!match) return json;
  // Escape the new value for JSON string context
  const jsonEscaped = newValue
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return (
    json.slice(0, match.index) +
    match[1] +
    '"' +
    jsonEscaped +
    '"' +
    json.slice(match.index + match[0].length)
  );
}
