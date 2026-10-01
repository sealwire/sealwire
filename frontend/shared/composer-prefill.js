import { setNativeValue } from "./set-native-value.js";

/** Focus the composer with the caret after what is already typed. */
export function focusComposer(input) {
  if (!input || input.disabled) return false;
  input.focus();
  const end = String(input.value || "").length;
  input.setSelectionRange?.(end, end);
  return true;
}

/**
 * Replace the composer's text as if it had been typed. The input event is what lets a
 * controlled field keep it and the "/" controller turn a leading command into its pill.
 */
export function prefillComposer(input, text) {
  if (!input || input.disabled) return false;
  setNativeValue(input, text);
  const EventCtor = input.ownerDocument?.defaultView?.Event || Event;
  input.dispatchEvent(new EventCtor("input", { bubbles: true }));
  return focusComposer(input);
}
