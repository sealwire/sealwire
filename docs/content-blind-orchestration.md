# Content-Blind Orchestration Boundary

Status: accepted for the T1-T3 foundation.

This document is the public trust contract for moving task-team orchestration
out of the embedded private driver without moving workspace authority or user
content out of the local relay. It documents mechanism, persistence, and wire
constraints only. Product scheduling logic, entitlement rules, operator
services, release keys, and proprietary prompts remain outside the public repo.

## Decision

Task-team runs are locally authoritative. A run pins one orchestration backend
when it is created, and that backend cannot change after execution begins. The
current backend is `LegacyEmbedded`; Cloud and local sidecar backends are
persistable but inert until later implementation tasks add transport and local
executor plumbing.

The Cloud orchestration driver is content-blind. It may receive only a sanitized
cursor, closed command/event envelopes, bounded counters and booleans, protocol
versions, driver versions, stable command/event ids, opaque ids, and opaque
artifact references. The local relay resolves artifact references, renders
allowlisted templates, invokes providers, reads/writes the repository, stores
sensitive outputs, and applies run-state mutations.

The broker's remote-control path is separate. Relay/surface traffic is always
end-to-end encrypted and the broker is blind transport. This remote-control
path is separate from the Cloud task-team orchestration channel; future Cloud
orchestration remains constrained to the content-blind schema.

## Cloud Allowlist

Only these field classes may be visible to Cloud orchestration:

- Closed enums: backend kind, run status, phase, driver role, artifact kind,
  artifact binding slot, diff scope, merge-base target, command kind, event
  kind, rejection code, turn outcome.
- Counters and versions: protocol version, state revision, command sequence,
  event sequence, expected revision, artifact revision, optional artifact size,
  sub-task counts and indexes, round counts, TL generation.
- Booleans: pause requested, awaiting user, diff changed, merge base available.
- Opaque ids: command id, event id, driver run id, thread handle, template id,
  artifact id, unsupported backend kind.
- Opaque artifact references and bindings: an artifact id plus closed kind,
  revision, and optional size; a binding maps a closed slot to such a reference.

Every Cloud-visible struct is closed and bounded. Unknown fields, unknown
commands/events, over-limit identifiers or collections, URL/path/command-shaped
tokens, and arbitrary payload escape hatches must fail decode. Command and
event envelopes must keep those limits at decode time, rejecting unknown fields
before consuming their values and stopping bounded collections before decoding
over-limit elements.

## Sensitive Denylist

These fields are local-only and must not appear on the orchestration wire:

- Task/user prose: task title, context, acceptance criteria, agreed scope,
  quality rules, pending user notes, pause reasons, error strings.
- Repository identity and content: cwd, paths, worktree path, main worktree,
  branch, target ref, base/head commit strings, diffs, file contents.
- Provider content: prompts, rendered templates, provider thread ids,
  transcripts, command output, logs, approval details, ask-user question text.
- Review content: verdict summaries, findings text, unresolved findings,
  result summaries, design/report text.
- Generic payloads: closures, arbitrary text/blob fields, URLs, shell commands,
  attachments by value, and `serde_json::Value`.

Local persistence may retain sensitive fields so a run can be restored and shown
to the owner. Cloud receives only references or counters derived from them.

## Ownership Boundary

Public repository:

- Shared closed protocol types in `relay-api`.
- Durable backend identity and driver progress fields on `TeamRun`.
- Local enforcement that current execution only drives `LegacyEmbedded`.
- Local restore behavior that keeps unknown backend records but makes them
  non-executing.
- Local template/artifact/executor seams when T5 lands, including egress tests.

Persisted backend decoding is intentionally asymmetric for compatibility:
omitting `TeamRun.orchestration_backend` is the only legacy signal that defaults
to `LegacyEmbedded`. Explicit `null`, empty objects, malformed records, and
future backend kinds restore as non-executing. The relay retains only bounded
identity fields it already knows how to validate (`original_kind`,
`protocol_version`, `driver_version`, `cloud_run_id`); unsupported future
payload fields are dropped rather than preserved as arbitrary JSON. Identity
values outside the current bounded token grammar are malformed, not opaque
pass-through data, and are deliberately omitted so paths, URLs, or unbounded
prose cannot enter the content-blind vocabulary.

A known backend carrying an unsupported protocol version is persisted as
`UnknownNonExecuting`, with its validated identity slots retained. A later
build may promote those bounded slots deliberately; this build does not retain
or replay an unvalidated future object shape. Driver progress follows the same
fail-closed rule: explicit `null`, malformed known fields, duplicate known
fields, and unknown fields set a durable `malformed` marker even though the
unsupported value itself is dropped. `LegacyEmbedded` does not consume driver
progress and may continue locally, but a malformed progress record cannot
change backend or produce a driver cursor. An unknown backend cannot produce a
driver cursor at all. This build has no override that clears a malformed marker:
the operator may continue the legacy run or use the explicit `mark_cancelled`
archival escape, which records `Cancelled` and releases local provider seats.
Any future migration must validate the retained counters before adding an
explicit recovery path.

The current archival lifecycle for inert unsupported-backend runs is explicit:
if a paused inert run loses its worktree, restore/validation changes it to a
diagnostic `Blocked` state; executable blocked-run resolution refuses to resume
that inert record in this build; explicit `Cancelled` archival is the supported
current-build exit and releases local provider seats. All diagnostic prose and
seat-release work stay local. Retention prunes only terminal task history;
non-terminal inert records remain durable because an older build cannot decide
that a newer backend's active run is disposable.

`sealwire-private` and private deployments:

- Driver state machine, scheduling, retry/review/fix policy, and template
  selection strategy.
- Hosted Cloud orchestration service implementation.
- Entitlement, license/operator plane, tier mapping, key delivery, billing,
  telemetry, and administrative tooling.
- Sidecar build, signing, encryption, packaging, IPC policy, and private prompt
  source where not required as a public audited local template.

The public side may define narrow request/response seams for these capabilities,
but not their decision rules, secrets, or proprietary driver logic.

## `TeamPort` Inventory

The existing `TeamPort` is a legacy embedded capability trait. It remains
local-only until T4/T5 replace closure mutation and raw prompt/diff/log flows
with explicit events, artifacts, and allowlisted templates.

For methods that return `TeamPortError`, `Blocked(String)` and `Failed(String)`
carry free-form local diagnostic prose. Those strings are not protocol rejection
codes and must not cross the Cloud content-blind boundary.
`TeamPortError::Settled` remains the prose-free race result: it means another
state transition already settled the run while the mechanism was waiting, and
it carries no diagnostic string.

| Method | Current inputs/outputs | Sensitive surface | Classification |
|---|---|---|---|
| `run_snapshot(run_id)` | Opaque-ish run id in, full `TeamRun` out | Full task spec, cwd/path, branch/ref/commits, provider thread ids, sub-task briefs, verdicts, findings, notes, errors, pause reasons | Local-only legacy read. Future Cloud gets `DriverCursor` plus artifact refs only. |
| `update_run(run_id, mutation)` | Run id plus `TeamRunMutation` closure, bool out | Closure can write any run field, including all sensitive local fields | Local-only legacy mutation. T4 replaces with typed events under expected revision. |
| `update_status(run_id, status)` | Run id, closed status, no output | Run id only; status is closed | Future wire-safe event candidate, guarded by expected revision and local reducer. |
| `fail_run(run_id, error)` | Run id, error prose, no output | Error text/log detail | Local-only. Future wire carries closed rejection/outcome code; local stores prose. |
| `block_run(run_id, error)` | Run id, error prose, no output | Error text/log detail | Local-only. Future wire carries closed blocked code; local stores prose. |
| `boundary_status(run_id)` | Run id in, closed status out | Run id only; status is closed | Future wire-safe cursor/status read candidate. |
| `settle_run(run_id, status, reason)` | Run id, closed status, reason prose | Reason text | Local-only as-is. Future wire-safe status event with local reason template. |
| `tl_reseed_reason(run_id)` | Run id in, reason prose out | Context-window/provider failure reason | Local-only. Future cursor may expose a boolean/counter, not prose. |
| `reseed_tl(run_id, reason, handover_prompt)` | Run id, reason prose, rendered handover prompt, or `TeamPortError::Blocked(String)`/`Failed(String)` local prose | Prompt, plan/spec content, reason text, provider thread ids, error diagnostics | Local-only. Future command is `RunTemplate` with closed template id and artifact bindings; failure wire uses closed rejection/outcome codes. |
| `tl_turn(run_id, prompt)` | Run id, rendered prompt in, `TeamTurnOutcome` out | Prompt and reply text | Local-only. Future command is `RunTemplate`; output is a local artifact ref plus closed outcome. |
| `require_workspace(run_id)` | Run id in, local result, or `TeamPortError::Blocked(String)`/`Failed(String)` local prose | Resolves cwd/worktree locally; errors may include path and workspace diagnostics | Local-only executor preflight. Future event can report closed ready/unavailable code. |
| `start_thread(run_id, role)` | Run id, closed role in, provider thread id out, or `TeamPortError::Blocked(String)`/`Failed(String)` local prose | Provider thread id, cwd binding, provider/workspace diagnostics | Local-only. Future event returns an opaque `ThreadHandle`, not provider id/path; failures use closed codes. |
| `resume_or_start_thread(run_id, role, candidates)` | Run id, closed role, thread-id candidates in, thread id out, or `TeamPortError::Blocked(String)`/`Failed(String)` local prose | Provider thread ids/session liveness and provider diagnostics | Local-only as-is. Future wire uses opaque `ThreadHandle` candidates minted by local executor and closed failure codes. |
| `record_run_thread(run_id, thread_id)` | Run id, provider thread id in, slot out | Provider thread id | Local-only state update. Future reducer stores opaque local handle bindings. |
| `turn(run_id, slot, role, prompt)` | Run id, slot, closed role, rendered prompt in, `TeamTurnOutcome` out | Prompt, reply text, provider thread id through slot | Local-only. Future command is `RunTemplate`; output text stays in local artifact storage. |
| `checkpoint_commit(run_id)` | Run id in, commit string out, or `TeamPortError::Blocked(String)`/`Failed(String)` local prose | Repository commit identity and VCS diagnostics | Local-only. Future wire may expose changed/available booleans plus artifact ref and closed failure codes. |
| `collect_diff(run_id, base)` | Run id, base commit/ref in, rendered diff out, or `TeamPortError::Blocked(String)`/`Failed(String)` local prose | Diff text, file paths, repository content, base ref, VCS diagnostics | Local-only. Future wire uses closed diff scope and returns an opaque diff artifact ref plus closed failure codes. |
| `merge_base(run_id, target_ref)` | Run id, target ref in, commit string out, or `TeamPortError::Blocked(String)`/`Failed(String)` local prose | Branch/ref, commit identity, and VCS diagnostics | Local-only. Future wire uses closed `PinnedTarget` and returns availability plus artifact ref and closed failure codes. |
| `commit(run_id, message)` | Run id, commit message prose in, bool out, or `TeamPortError::Blocked(String)`/`Failed(String)` local prose | Commit message, repository mutation authority, and VCS diagnostics | Local-only. Future wire uses an allowlisted message template id and returns changed plus artifact ref and closed failure codes. |
| `push_log(level, message)` | Closed-ish level and message prose | Logs, command/provider details | Local-only. Cloud-visible errors use closed rejection codes only. |

## Follow-Up Scope

T4 must replace `TeamRunMutation` with explicit reducer events and a command
journal. T5 must add local artifact storage, template allowlisting, prompt
rendering, provider invocation, egress canary tests, and the same decode-time
wire bounds for any newly added command/event fields. T6-T10 add Cloud
transport, entitlement, sidecar IPC, encrypted packaging, and rollout hardening.
None of those are implemented by this foundation.
