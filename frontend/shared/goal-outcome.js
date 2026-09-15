// What a goal capability is allowed to answer, in one place, because both doors onto a
// goal read it and neither can see the other.
//
// Anything that is not `{isError, text}` is treated as a FAILURE with a sentence rather
// than as success: a helper that regresses to the old bare boolean would otherwise make
// every refusal silent again, which is the entire defect this channel exists to close.

const CONTRACT_ERROR = "The relay did not say whether the goal changed.";
const NO_REASON = "The relay refused, without saying why.";

/** @returns {{ isError: boolean, text: string }} */
export function goalOutcomeOrContractError(answer) {
  if (!answer || typeof answer !== "object" || typeof answer.isError !== "boolean") {
    return { isError: true, text: CONTRACT_ERROR };
  }
  if (!answer.isError) return { isError: false, text: "" };
  return { isError: true, text: String(answer.text || "").trim() || NO_REASON };
}
