// Public-checkout placeholder. The composer's "/" surface is proprietary, so a
// public relay has no commands to offer; returning an inert controller lets the
// composer wiring stay unconditional and keeps the module out of this tree.
//
// `submit()` returning null is the contract for "not a command" — every draft
// then takes the ordinary send path.
export function createComposerCommandController() {
  return { submit: () => null };
}
