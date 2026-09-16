// What a relay-command capability is allowed to answer, in one place, because several
// doors read it and none of them can see the others.
//
// Anything that is not `{isError, text}` is treated as a FAILURE with a sentence rather
// than as success: a helper that regresses to the old bare boolean would otherwise make
// every refusal silent again, which is the entire defect this channel exists to close.

const contractError = (subject) => `The relay did not say whether ${subject} went through.`;
const NO_REASON = "The relay refused, without saying why.";

/** @returns {{ isError: boolean, text: string }} */
export function commandOutcomeOrContractError(answer, subject = "the command") {
  if (!answer || typeof answer !== "object" || typeof answer.isError !== "boolean") {
    return { isError: true, text: contractError(subject) };
  }
  if (!answer.isError) return { isError: false, text: "" };
  return { isError: true, text: String(answer.text || "").trim() || NO_REASON };
}
