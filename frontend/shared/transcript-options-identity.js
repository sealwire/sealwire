// transcriptOptions carries a few collection fields (Sets/Maps/arrays rebuilt
// fresh on most renders) that a reference check would never see as
// "unchanged", so equality here is by value for the shapes transcriptOptions
// actually carries; everything else compares by reference via Object.is.
export function transcriptOptionValueEqual(a, b) {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) {
      return false;
    }
    for (const value of a) {
      if (!b.has(value)) {
        return false;
      }
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length
      && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && Object.is(a[key], b[key]))
    );
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) {
      return false;
    }
    for (const [key, value] of a) {
      if (!b.has(key) || !Object.is(b.get(key), value)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

// Reuses the PREVIOUS transcriptOptions object when every field is
// value-equal to this render's, so React.memo on transcript entries actually
// short-circuits instead of re-rendering on a fresh-literal options object.
export function stableTranscriptOptions(previous, next) {
  if (previous) {
    const nextKeys = Object.keys(next);
    if (
      nextKeys.length === Object.keys(previous).length
      && nextKeys.every((key) => transcriptOptionValueEqual(previous[key], next[key]))
    ) {
      return previous;
    }
  }
  return next;
}
