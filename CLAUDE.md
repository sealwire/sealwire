@AGENTS.md

## Workflow rules

- **Never prompt, offer, or remind about pushing.** Do not push, and do not
  suggest pushing or ask "want me to push?". Only push when the user explicitly
  says to. (Committing locally as the user directs is fine; pushing is opt-in and
  unprompted-only.)

- **Always capture a bug before fixing it (red → green).** When fixing a bug,
  FIRST write a failing test that reproduces it, and run it to confirm it fails
  (RED) for the right reason. Only then make the fix, and re-run to confirm the
  test passes (GREEN). Never fix first and add a test after. For bugs that span
  layers (e.g. frontend + backend), capture each layer's defect with its own
  failing test before touching either fix. The test must encode the invariant
  that was violated, so it stays as a regression guard.
