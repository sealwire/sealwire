// Write to an input/textarea so that React notices.
//
// React stores the last value it rendered on the node and compares against it when
// an input event arrives. A plain `node.value = text` updates the DOM without
// touching that copy, so a CONTROLLED field treats the event as a no-op and the next
// render puts the old text straight back. Going through the prototype's own setter
// is what keeps React's copy in step.
export function setNativeValue(node, text) {
  if (!node) return;
  const prototype = Object.getPrototypeOf(node);
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(node, text);
  else node.value = text;
}
