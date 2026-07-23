import test from "node:test";
import assert from "node:assert/strict";

import {
  INHERIT,
  defaultForkFields,
  forkFieldsToPayload,
  canForkInSession,
  forkFieldsAreSubmittable,
  forkInheritableFields,
  forkIsLossy,
  forkPointIsTranscriptTip,
  normalizeForkFields,
  resolveForkSourceThread,
  threadIsBusyForFork,
} from "./fork-fields.js";

const CLAUDE_MODELS = [
  { model: "claude-sonnet-4-6", display_name: "Sonnet", is_default: true },
];

// The relay resolves approval/sandbox/effort from the SOURCE thread's
// remembered settings when the request omits them. Seeding the dialog from the
// currently-active session instead (and then always sending it) silently
// re-permissions the fork: forking a read-only thread from a full-access
// session would hand the branch full access.
test("untouched permission fields inherit from the source thread, not the live session", () => {
  const fields = defaultForkFields({
    thread: { provider: "claude_code", cwd: "/repo" },
    models: CLAUDE_MODELS,
    session: {
      provider: "codex",
      sandbox: "danger-full-access",
      approval_policy: "on-request",
      reasoning_effort: "high",
    },
  });

  assert.equal(fields.sandbox, INHERIT);
  assert.equal(fields.approvalPolicy, INHERIT);
  assert.equal(fields.effort, INHERIT);

  const payload = forkFieldsToPayload(fields);
  assert.equal(payload.sandbox, null);
  assert.equal(payload.approval_policy, null);
  assert.equal(payload.effort, null);
});

test("explicitly chosen permission fields are sent through", () => {
  const fields = {
    ...defaultForkFields({ thread: { provider: "claude_code" }, models: CLAUDE_MODELS }),
    sandbox: "read-only",
    approvalPolicy: "untrusted",
  };

  const payload = forkFieldsToPayload(fields);
  assert.equal(payload.sandbox, "read-only");
  assert.equal(payload.approval_policy, "untrusted");
});

// resolve_provider_model on the relay passes an EXPLICIT model straight to the
// bridge without checking it against the target provider's catalog, so seeding
// the model from a different provider's session sends e.g. a codex model id to
// the Claude worker.
test("model is never seeded from a different provider's session", () => {
  const fields = defaultForkFields({
    thread: { provider: "claude_code" },
    models: [],
    session: { provider: "codex", model: "gpt-5.3-codex" },
  });

  assert.notEqual(fields.model, "gpt-5.3-codex");
  assert.equal(forkFieldsToPayload(fields).model, null, "unknown catalog inherits");
});

test("model is seeded from the target provider's own catalog when available", () => {
  const fields = defaultForkFields({
    thread: { provider: "claude_code" },
    models: CLAUDE_MODELS,
    session: { provider: "codex", model: "gpt-5.3-codex" },
  });

  assert.equal(fields.model, "claude-sonnet-4-6");
  assert.equal(forkFieldsToPayload(fields).model, "claude-sonnet-4-6");
});

test("the fork point rides along with the payload", () => {
  const fields = {
    ...defaultForkFields({ thread: { provider: "codex" }, models: [] }),
    sourceThreadId: "thread-1",
    upToItemId: "assistant:abc",
  };

  const payload = forkFieldsToPayload(fields);
  assert.equal(payload.source_thread_id, "thread-1");
  assert.equal(payload.up_to_item_id, "assistant:abc");
});

test("a Codex live-id tip fork is sent as a whole-thread fork", () => {
  // Codex's live stream tags an agent message with its response id (`msg_...`)
  // while `thread/read` renumbers the same item positionally (`item-13`). The
  // live id can never be resolved server-side, so forking the just-streamed last
  // message with it is rejected as "not part of the source thread transcript".
  // At the tip a fork drops nothing, so drop the unresolvable anchor and take the
  // whole-thread path the working thread-list fork takes.
  const fields = {
    ...defaultForkFields({ thread: { provider: "codex" }, models: [] }),
    sourceThreadId: "thread-1",
    upToItemId: "msg_02a31f0f067cc13f016a6131a81104819188054b86ab3fded2",
    forkPointIsTip: true,
  };

  assert.equal(
    forkFieldsToPayload(fields).up_to_item_id,
    null,
    "a Codex live-id tip fork must go out as a whole-thread fork",
  );
});

test("a resolvable tip anchor is preserved, not collapsed (stale-snapshot race)", () => {
  // forkPointIsTip is captured when the dialog opens and never recomputed. For a
  // RESOLVABLE id (Claude `assistant:<uuid>`, past-turn Codex `item-N`) the relay
  // re-checks it against the fresh read and keeps it anchored when the source has
  // since advanced. Blindly nulling every tip would instead fork content AFTER
  // the picked message if another device completed a turn mid-dialog. So only the
  // unresolvable Codex live id is dropped; every stable anchor rides through.
  const claudeTip = {
    ...defaultForkFields({ thread: { provider: "claude_code" }, models: [] }),
    sourceThreadId: "thread-1",
    upToItemId: "assistant:11111111-2222-4333-8444-555555555555",
    forkPointIsTip: true,
  };
  assert.equal(
    forkFieldsToPayload(claudeTip).up_to_item_id,
    "assistant:11111111-2222-4333-8444-555555555555",
    "a Claude tip anchor must be preserved so the relay can re-anchor it",
  );

  const codexPastTurnTip = {
    ...defaultForkFields({ thread: { provider: "codex" }, models: [] }),
    sourceThreadId: "thread-1",
    upToItemId: "item-14",
    forkPointIsTip: true,
  };
  assert.equal(
    forkFieldsToPayload(codexPastTurnTip).up_to_item_id,
    "item-14",
    "a persisted Codex `item-N` anchor resolves server-side and must be preserved",
  );
});

test("tip collapse is driven by the real forkPointIsTranscriptTip lifecycle", () => {
  // The unit tests above supply forkPointIsTip directly; this exercises the path
  // the surfaces actually take — derive it from the on-screen entries, then build
  // the payload. A Codex live tip collapses; a Claude live tip is preserved.
  const codexEntries = [
    { kind: "user_text", item_id: "msg_user_live" },
    { kind: "agent_text", item_id: "msg_02a31f0f067cc13f016a6131a81104819188054b86ab3fded2" },
  ];
  const codexTipId = codexEntries.at(-1).item_id;
  const codexFields = {
    ...defaultForkFields({ thread: { provider: "codex" }, models: [] }),
    sourceThreadId: "thread-1",
    upToItemId: codexTipId,
    forkPointIsTip: forkPointIsTranscriptTip(codexEntries, codexTipId),
  };
  assert.equal(forkFieldsToPayload(codexFields).up_to_item_id, null);

  const claudeEntries = [
    { kind: "user_text", item_id: "user:aaaa" },
    { kind: "agent_text", item_id: "assistant:bbbb" },
  ];
  const claudeTipId = claudeEntries.at(-1).item_id;
  const claudeFields = {
    ...defaultForkFields({ thread: { provider: "claude_code" }, models: [] }),
    sourceThreadId: "thread-1",
    upToItemId: claudeTipId,
    forkPointIsTip: forkPointIsTranscriptTip(claudeEntries, claudeTipId),
  };
  assert.equal(forkFieldsToPayload(claudeFields).up_to_item_id, "assistant:bbbb");
});

test("a blank fork prompt is sent as null so a native fork stays idle", () => {
  const fields = {
    ...defaultForkFields({ thread: { provider: "codex" }, models: [] }),
    initialPrompt: "   ",
  };
  assert.equal(forkFieldsToPayload(fields).initial_prompt, null);
});

test("fork eligibility matches the server guard, including background threads", () => {
  const session = { active_thread_id: "active-1", active_turn_id: "turn-9" };

  assert.equal(
    threadIsBusyForFork({ id: "active-1", status: "active" }, session),
    true,
    "active thread mid-turn"
  );
  // The defect this guards: a BACKGROUND thread running a turn used to show an
  // enabled Fork affordance and only fail on submit.
  assert.equal(
    threadIsBusyForFork({ id: "bg-1", status: "active" }, session),
    true,
    "background thread with a working status"
  );
  assert.equal(threadIsBusyForFork({ id: "bg-2", status: "idle" }, session), false);
  assert.equal(threadIsBusyForFork({ id: "bg-3", status: "completed" }, session), false);
  assert.equal(threadIsBusyForFork({ id: "bg-4", status: "" }, session), false);
});

// Forking does not write to the thread you are looking at — it starts a NEW
// session from that thread's history, and the relay accepts any non-busy
// thread regardless of which one is active. Gating the affordance on the
// read-only-ness of the viewed thread (`view_only`) hid fork on every saved
// conversation, leaving it only on the live one.
test("a saved / view-only thread still offers fork", () => {
  assert.equal(canForkInSession({ view_only: true }), true, "saved thread view");
  assert.equal(canForkInSession({ view_only: false }), true, "live session");
  assert.equal(canForkInSession({}), true, "no view_only field");
  assert.equal(canForkInSession(null), false, "nothing to fork from");
});

// Mirrors the Rust guard: Codex reports `notLoaded` for a saved thread the
// app-server has not opened. Treating it as busy made the client refuse to
// open the fork dialog for every saved Codex thread, while Claude threads
// (status `idle`) worked — the asymmetry that looked like "codex can't fork".
test("a notLoaded (saved Codex) thread is forkable", () => {
  assert.equal(threadIsBusyForFork({ id: "t", status: "notLoaded" }, null), false);
  assert.equal(threadIsBusyForFork({ id: "t", status: "notloaded" }, null), false);
  // A genuinely running thread still blocks.
  assert.equal(threadIsBusyForFork({ id: "t", status: "active" }, null), true);
});

// The fork button lives in the TRANSCRIPT, which renders on a deep link
// (`/?thread=<id>`) before — or independently of — the sidebar thread list.
// Requiring the thread to be present in that list made fork fail with
// "Cannot fork unknown thread" on local (a log line the user never sees) and
// fail silently on remote. The viewed session snapshot already describes the
// thread being viewed, so it is a sufficient source.
test("the fork source resolves from the session when the thread list is empty", () => {
  const session = {
    active_thread_id: "t-1",
    provider: "codex",
    current_cwd: "/repo",
    current_status: "notLoaded",
  };

  const resolved = resolveForkSourceThread({ threadId: "t-1", threads: [], session });

  assert.ok(resolved, "must not bail just because the list has not loaded");
  assert.equal(resolved.id, "t-1");
  assert.equal(resolved.provider, "codex");
  assert.equal(resolved.cwd, "/repo");
});

test("a loaded thread-list entry wins over the session projection", () => {
  const threads = [{ id: "t-1", provider: "claude_code", cwd: "/from-list", status: "idle" }];
  const session = { active_thread_id: "t-1", provider: "codex", current_cwd: "/from-session" };

  const resolved = resolveForkSourceThread({ threadId: "t-1", threads, session });

  assert.equal(resolved.cwd, "/from-list");
  assert.equal(resolved.provider, "claude_code");
});

test("an unrelated thread id still resolves to nothing", () => {
  const session = { active_thread_id: "t-1", provider: "codex" };
  assert.equal(
    resolveForkSourceThread({ threadId: "other", threads: [], session }),
    null
  );
  assert.equal(resolveForkSourceThread({ threadId: "", threads: [], session }), null);
});

// On local, `state.session` stays the LIVE session while you view a saved
// thread — the view-only projection is built at render time. So the viewed
// thread's own pin is the authoritative source, and without it forking any
// thread other than the live one failed with "Cannot fork unknown thread".
test("the fork source resolves from the viewed-thread pin", () => {
  const resolved = resolveForkSourceThread({
    threadId: "viewed-1",
    threads: [],
    session: { active_thread_id: "live-9", provider: "claude_code" },
    viewedThread: {
      threadId: "viewed-1",
      provider: "codex",
      cwd: "/other/repo",
      status: "notLoaded",
    },
  });

  assert.ok(resolved, "viewing a saved thread must be forkable");
  assert.equal(resolved.id, "viewed-1");
  assert.equal(resolved.provider, "codex", "uses the VIEWED thread's provider");
  assert.equal(resolved.cwd, "/other/repo", "not the live session's cwd");
});

// The client used to infer the fork mechanism from provider NAMES, which is a
// guess: it mislabels any bridge without a native fork, and cannot know that a
// branch point at the transcript tip drops nothing (so a tip-only native fork
// still applies). The relay now reports capability on the snapshot.
const CAPS = [
  { provider: "codex", native_fork: true, native_fork_at_message: false },
  { provider: "claude_code", native_fork: true, native_fork_at_message: true },
  { provider: "fake", native_fork: false, native_fork_at_message: false },
];

test("lossy labelling follows reported capability", () => {
  const lossy = (o) => forkIsLossy({ capabilities: CAPS, ...o });

  assert.equal(lossy({ sourceProvider: "codex", targetProvider: "codex" }), false);
  assert.equal(lossy({ sourceProvider: "claude_code", targetProvider: "claude_code" }), false);
  // No native fork reported -> replay, whatever the provider is called.
  assert.equal(lossy({ sourceProvider: "fake", targetProvider: "fake" }), true);
  // Cross-provider is always replay.
  assert.equal(lossy({ sourceProvider: "codex", targetProvider: "claude_code" }), true);
});

test("a branch point only forces replay when the provider cannot honour it", () => {
  const lossy = (o) => forkIsLossy({ capabilities: CAPS, ...o });

  // Codex is tip-only: a MID-thread branch degrades...
  assert.equal(
    lossy({ sourceProvider: "codex", targetProvider: "codex", upToItemId: "x" }),
    true
  );
  // ...but branching at the tip drops nothing, so it stays native.
  assert.equal(
    lossy({
      sourceProvider: "codex",
      targetProvider: "codex",
      upToItemId: "x",
      forkPointIsTip: true,
    }),
    false
  );
  // Claude takes upToMessageId, so a mid-thread branch stays native.
  assert.equal(
    lossy({ sourceProvider: "claude_code", targetProvider: "claude_code", upToItemId: "x" }),
    false
  );
});

test("an unknown provider is assumed lossy", () => {
  assert.equal(
    forkIsLossy({ capabilities: CAPS, sourceProvider: "mystery", targetProvider: "mystery" }),
    true
  );
  // No capabilities reported at all (older relay): assume the safe answer.
  assert.equal(forkIsLossy({ sourceProvider: "codex", targetProvider: "codex" }), true);
});

// Same trap as resolveForkSourceThread: on local, `session.transcript` is the
// LIVE session's, while the saved thread on screen has its own entries. Reading
// the wrong one labels a tip fork of a viewed Codex thread as replay even
// though the relay performs a native fork.
test("tip detection uses the entries actually on screen", () => {
  const liveEntries = [{ item_id: "live-tail", kind: "agent_text" }];
  const viewedEntries = [
    { item_id: "viewed-a", kind: "agent_text" },
    { item_id: "viewed-tail", kind: "agent_text" },
  ];

  assert.equal(forkPointIsTranscriptTip(viewedEntries, "viewed-tail"), true);
  assert.equal(forkPointIsTranscriptTip(viewedEntries, "viewed-a"), false);
  // The live transcript must not answer for the viewed one.
  assert.equal(forkPointIsTranscriptTip(liveEntries, "viewed-tail"), false);
  assert.equal(forkPointIsTranscriptTip([], "viewed-tail"), false);
  assert.equal(forkPointIsTranscriptTip(viewedEntries, ""), false);
});

// "Inherit from source session" must only be offered for fields the relay will
// ACTUALLY inherit. Its chain in fork_session gates model and effort on
// `target_provider == source_provider` (a codex model id is meaningless to
// Claude, and effort options are model-specific), while approval policy and
// sandbox are provider-neutral and inherit either way. Offering inherit for a
// field the server ignores is a lie the user cannot see through.
test("model and effort are only inheritable within the same provider", () => {
  const same = forkInheritableFields({
    sourceProvider: "codex",
    targetProvider: "codex",
  });
  assert.equal(same.has("model"), true);
  assert.equal(same.has("effort"), true);
  assert.equal(same.has("approvalPolicy"), true);
  assert.equal(same.has("sandbox"), true);

  const crossed = forkInheritableFields({
    sourceProvider: "codex",
    targetProvider: "claude_code",
  });
  assert.equal(crossed.has("model"), false, "a codex model id means nothing to Claude");
  assert.equal(crossed.has("effort"), false, "effort options are model-specific");
  // These are provider-neutral, and the relay inherits them regardless.
  assert.equal(crossed.has("approvalPolicy"), true);
  assert.equal(crossed.has("sandbox"), true);
});

test("an unknown target provider is treated as a change", () => {
  const crossed = forkInheritableFields({ sourceProvider: "codex", targetProvider: "" });
  assert.equal(crossed.has("model"), true, "no target yet means no change yet");
});

// After a provider change the dialog stops offering the empty "inherit" option
// for model/effort, but the field could still HOLD it — a controlled select
// with a value absent from its options. The browser shows the first option
// while the state stays "", so submitting sends null and the relay silently
// picks its own default: the user sees one thing and gets another.
test("fields are normalized to a concrete value when inherit is not offered", () => {
  const models = [
    { model: "claude-sonnet-4-6", display_name: "Sonnet", is_default: true,
      supported_reasoning_efforts: ["low", "high"], default_reasoning_effort: "high" },
  ];

  const normalized = normalizeForkFields(
    { provider: "claude_code", model: INHERIT, effort: INHERIT },
    { sourceProvider: "codex", models }
  );

  assert.equal(normalized.model, "claude-sonnet-4-6");
  assert.equal(normalized.effort, "high", "the model's own default, not the first option");
});

test("same-provider fields keep inherit, which is still offered", () => {
  const normalized = normalizeForkFields(
    { provider: "codex", model: INHERIT, effort: INHERIT },
    { sourceProvider: "codex", models: [{ model: "gpt-5.4", is_default: true }] }
  );

  assert.equal(normalized.model, INHERIT);
  assert.equal(normalized.effort, INHERIT);
});

// A cold target catalog cannot be normalized yet. The fields must stay empty
// (there is nothing honest to show) and the dialog must refuse to submit,
// rather than send null and let the relay choose unseen.
test("a cold catalog leaves the field empty and blocks submission", () => {
  const fields = { provider: "claude_code", model: INHERIT, effort: INHERIT };
  const normalized = normalizeForkFields(fields, { sourceProvider: "codex", models: [] });

  assert.equal(normalized.model, INHERIT);
  assert.equal(forkFieldsAreSubmittable(normalized, { sourceProvider: "codex" }), false);
});

test("submission is allowed once a concrete model exists", () => {
  const fields = { provider: "claude_code", model: "claude-sonnet-4-6", effort: "high" };
  assert.equal(forkFieldsAreSubmittable(fields, { sourceProvider: "codex" }), true);
  // Same-provider inherit is submittable — the relay resolves it.
  assert.equal(
    forkFieldsAreSubmittable(
      { provider: "codex", model: INHERIT, effort: INHERIT },
      { sourceProvider: "codex" }
    ),
    true
  );
});
