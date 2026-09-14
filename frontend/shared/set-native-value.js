// Write to an input/textarea so that React notices.
//
// React puts its own `value` setter on the node, which updates the tracker it later
// compares an input event against. A plain assignment goes THROUGH that setter, so the
// tracker already agrees and the event reads as no change: a controlled field keeps its
// old value and the next render writes it back. The prototype setter bypasses it.
export function setNativeValue(node, text) {
  if (!node) return;
  const prototype = Object.getPrototypeOf(node);
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(node, text);
  else node.value = text;
}
