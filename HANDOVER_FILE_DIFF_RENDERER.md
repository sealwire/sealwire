# Handover — file-diff renderer, patch appliability, duplicate cards

Trigger: a one-character edit to `package-lock.json` rendered in the transcript as
`−1395` with no additions — visually identical to the file having been deleted.

Three commits landed on `main`. A fourth defect — one edited file drawing two cards — was
reproduced later and is now fixed too; see [Duplicate file-change
cards](#duplicate-file-change-cards-fixed).

---

## Landed

### `f00162c` — stop a one-line edit rendering as a whole-file deletion

Two cost guards in the old hand-rolled renderer compounded. `MAX_LCS_CELLS` (4M) is
exceeded by any file over ~2000 lines (5993² ≈ 36M), which swapped the minimal diff for a
whole-file replacement — every old line `-`, then every new line `+`. The
`MAX_DIFF_LINES` (1400) truncation then cut that body off before the first `+`. The
arithmetic is exact: 3 header lines + 1 `@@` + 1395 removals = the 1399 kept, hence
`-1395/+0`.

The cap was measuring the wrong thing: it exists to bound the O(n·m) DP allocation, but
the DP only ever needs to run over lines that actually **differ**. Fixed by peeling the
shared prefix/suffix first. **A file being long is not the same as an edit being large.**

### `beb75e3` — hand the unified-diff format to jsdiff

Replaced ~170 lines of hand-rolled LCS / hunk builder / cost cap with `diff@9`
(`structuredPatch` + `formatPatch`). Net 91 lines removed.

Only the git **file header** (`diff --git a/x b/x`, mode lines, `/dev/null` sides) is
still ours — that shape is pinned by the relay's appliability check and the
repo-relative header rule, so it is deliberately not delegated.

Two live bugs fixed as a side effect:

- No `\ No newline at end of file` marker. Any file whose last line lacks a newline
  produced a patch `git apply` **refuses** ("patch does not apply") — Undo and Reapply
  were silently dead for every such file.
- A trailing-newline-only change rendered as no change at all.

**Non-obvious constraints, each learned by breaking it:**

| Constraint | Why |
|---|---|
| The cost guard could not be deleted | Myers is O(N·D) → O(N²) on fully-different files. 20k lines took **58 seconds** unbounded; the worker is one NDJSON loop, so that is a minute-long freeze of the session. jsdiff's `maxEditLength` (= `MAX_DIFF_LINES`) bounds it → 122ms. |
| Truncation keeps head **and** tail | A whole-file replacement is one hunk of every removal then every addition. A head-only cut drops every `+` and reads as `-N/+0` — the exact bug `f00162c` fixed. |
| jsdiff loads via `createRequire`, lazily | `scripts/sealwire-package.test.mjs` boots the packed worker with **no node_modules**; a static third-party import breaks startup there. Mirrors how the Anthropic SDK is already deferred to session start. |
| The dep is declared in **both** manifests | Root `package.json` for `npm i sealwire` (the worker resolves upward); `claude-worker/package.json` for the Tauri bundle, which runs `npm ci --omit=dev` inside the copied worker dir. Both lockfiles updated or the desktop build fails. |

`diff@9` is BSD-3-Clause with zero transitive dependencies.

### `bd60a9b` — stop offering Undo for a patch git will refuse

The worker truncates at `MAX_DIFF_LINES`, leaving the header well-formed while the body
stops early. Both appliability checks looked only at headers, so both said yes, the UI lit
up Undo, and `git apply` answered `corrupt patch at line N`.

`patch_is_appliable` (`crates/relay-server/src/protocol.rs`) now also verifies every hunk
delivers the number of lines its `@@` promises — context and `\` counted the way git
counts them, and the hunk closes the moment both sides are satisfied so the blank line
between two joined file patches is not miscounted as context.

**It stays a pure synchronous parse, deliberately.** This started out as "just call
`git apply --check`"; reading the call site changed the answer. It runs from
`strip_file_change_diffs_for_transport`, once per file-change entry **every time a
snapshot is serialized**, and has no workspace to run git in. A subprocess per entry is
not affordable. The apply path already shells out to real git and remains the authority on
whether a patch lands; this flag only decides whether to **offer** the control.

The frontend's `canApplyPatch` has its own fallback for the authoritative read/detail
paths (no relay verdict travels there, because the diff is still present) and had the same
blind spot. There it matches the truncation marker rather than re-implementing git's hunk
arithmetic — duplicating the counting is how you end up with two implementations
disagreeing, which is the thing the jsdiff swap just removed.

---

## Duplicate file-change cards (fixed)

**Symptom.** One edited file draws **two** stacked cards, both labelled with the same
basename; one shows no +/− counts and reads "Diff unavailable for this file", the other
shows the real diff. The group chip above them says "1 file change".

**Why one file has two spellings at all.** The worker deliberately puts both in one object
(`claude-worker/file-diff.mjs`, `buildFileChange`): `path` stays ABSOLUTE (it is how the
relay tells which worktree a thread has been writing in) while `patchHeaderPath` writes the
patch header REPO-RELATIVE (what `git apply` requires). Anything that derives a path from
the diff body and compares it to `path` as a raw string sees two files.

**The producer — not where the first hunt looked.** No Rust `Vec<FileChangeDiffView>` ever
holds both spellings; that is why instrumenting the runtime and the snapshot round trip
found nothing. The mix is assembled at the very end, on a clone, at detail-serialization
time:

1. The snapshot strips diff bodies (`strip_file_change_diffs_for_transport`) and sets
   `file_changes_omitted`, so expanding a file section auto-fetches the entry detail.
2. `ThreadEntryDetailResponse::from_entry` runs `externalize_nested_file_change_diffs`
   (`protocol.rs`), which **moves** the bodies onto `tool.diff` and **clears** the
   per-change ones. The response therefore carries an absolute path with no diff beside a
   patch whose header is relative.
3. `getFileChanges` (`frontend/shared/file-change-diff.js`) merged `tool.file_changes` with
   `parseFileChangesFromDiff(tool.diff)` keyed on `entry.path === normalized.path` → two
   rows: the empty absolute one, then the real relative one.

There used to be a second, independent instance of the same mix in `read_thread_entries`,
which returned entries with neither stripping nor externalizing. That endpoint has since
been deleted (it had no caller and named rows in the wrong namespace), so the detail path
above is now the only one.

**Intermittency.** `claude.rs read_thread` only passes `cwd` into the worker command when
it has one; without it `patchHeaderPath` leaves the header ABSOLUTE and the two spellings
match. Same thread, different reload, different card count.

**Fix — at the layer that mixes them, keyed on the root.** `fileChangePathKey(path, root)`
canonicalizes a path against the session root; `mergeFileChangeLists` and `getFileChanges`
take `options.currentCwd` (already threaded to the renderer as `transcriptOptions.currentCwd`
and re-exposed on the tool as `display_options`), and the diff-group counters key their
distinct-file set the same way, so one file spelled two ways is no longer counted — or
summed — twice. The first-seen spelling keeps the display slot, which is the absolute one
the entry actually carries.

**Do NOT loosen this to a suffix match.** With only the two strings, `x.js` and
`/repo/deep/x.js` are indistinguishable from a genuine pair of same-named files in
different directories. The root is what removes the guess; with no root the merge falls
back to exact equality (today's behaviour), never a guess. A test pins that case.

**The key has to be equivalent to the producer, not merely "relative-ish".** The header is
written by `path.relative` (`patchHeaderPath`), so the key resolves `.`/`..`, collapses
duplicate separators, treats a root of `/` as a root, and compares Windows paths
case-insensitively (`path.win32.relative` does; `path.posix.relative` does not). The first
cut prefix-sliced the root off the string and left five ways for one file to key twice —
each of which brought the empty card straight back. `frontend/shared/file-change-diff.test.mjs`
checks the key against node's `path` rather than against hand-written strings, so the next
edit to it has to stay equivalent to the thing that writes the header.

**Deliberately NOT done: canonicalizing in Rust.** `merge_file_change_view`
(`file_changes.rs`) still compares raw strings. It cannot produce this bug: Claude sets
`tool.path` and `file_changes[].path` from the same string, both Claude turnDiff call sites
pass a `diff` that reads back as `None` (the snapshot strips it), and Codex reports
`changes[].path` repo-relative — the same namespace as its headers. Adding a root-keyed
merge there would be a fix without a trigger, which is exactly what the previous round
wrote and then reverted. Leave it until something proves it mixes.

**Regression coverage.**

- `frontend/shared/file-change-diff.test.mjs` — the key's equivalence to `path.relative`,
  case by case, plus the merge outcome for each and the two must-not-merge guards
  (same basename in different directories, POSIX case sensitivity).
- `frontend/transcript-react.test.mjs` — one section for absolute-path + relative-header
  (live shape), one for the externalized detail shape, one chip test (the doubled +/−
  counts), and the same-basename guard that must stay two sections.
- `scripts/browser-local-file-diff-cards-e2e.mjs` (`npm run test:browser:local-file-diff-cards`)
  — the promoted diagnostic, now asserting. It drives the real relay + UI through
  snapshot-strip → expand → detail fetch → render, which is the only place the two
  spellings meet. Verified red before the fix (`2 !== 1`, page text identical to the
  original screenshot) and green after.

---

## Also worth knowing

- **`patch_is_appliable` is still a hand-rolled model of git's format.** It is now much
  closer (it counts hunk bodies), but it is still our second implementation of "would git
  accept this". If it drifts again, the honest fix is to move the verdict to where a
  workspace exists and call real git once, not to add a fourth heuristic.
- **The recurring-bug taxonomy** (see the project memory note): family A is the
  algorithm/format layer, now closed by delegating to jsdiff. Family B is the
  capture/lifecycle layer — the re-read-disk root cause, provisional cards, patches lost
  on reload. The duplicate-card bug above is family B, and its lesson is the family's:
  the defect was not in either representation but in the **seam** where two of them are
  re-joined (here, an entry serializer that splits a change from its own body). When a
  file-diff symptom appears at render time, look at the last hop before render, not at
  the store.
- **Untouched, not mine:** `scripts/browser-remote-mobile-session-actions-e2e.mjs` is
  modified in the working tree. It is a deliberately-red test awaiting its production CSS
  (project actions are hover-gated at `opacity: 0` and 24×24, with no
  `@media (hover: none)` rule covering `.thread-group-actions`), belonging to the mobile
  sidebar parity work. It was never staged or merged here.
