# Native terminal sessions

To create a terminal session, choose **Codex terminal** or **Claude terminal**
in the New session model menu, then pick a model and start. Claude terminal
launches explicitly select **Full access (YOLO)** in the dialog. An empty prompt
opens an idle terminal; when Claude is already answering the initial prompt, the
terminal connects after that reply finishes.

For an existing session, right-click its sidebar row or tab and choose **Open in
terminal**. On a phone, use the session row’s **⋯** actions. This keeps the same
session and its permissions. Use **Conversation** above the terminal to switch back.

Codex sessions offer **Conversation / Terminal** views on desktop and remote
clients. Both views address the same Sealwire session and provider history.
Codex attaches its native TUI to the existing app-server.

Claude Code Terminal requires the session's **Full access (YOLO)** setting.
Its selector is available on desktop and remote clients; the server refuses to
open it under other permission modes. Opening Terminal never upgrades a session's
permissions. Switching out of YOLO stops the idle native runtime and resumes the
same provider history through the SDK in Conversation mode.

The Claude CLI can execute typed or recalled `!` shell commands directly. These
are deliberately allowed in YOLO mode, without tool approvals or a filesystem
sandbox. They are manual terminal activity, not admitted agent turns: they do not
create Sealwire workflow records or participate in goal accounting. Trusted
paired devices with access to the session can use this shell too.

The Sealwire composer, workflow cards, questions, and session controls remain
available in Terminal view. Handover, delegate/report-back, review, goals, tasks,
and teams still use Sealwire's common admission, state machine, and scheduling.
Native slash commands that would start independent workflows or switch sessions
remain refused; use the Sealwire controls or skill picker. Read-only reviewer
sessions continue to run through their SDK provider; they cannot open a YOLO-only
Claude terminal.

## Input and access

The native TUI connects to a dedicated loopback WebSocket, authenticated with a
process-specific bearer token. Browser-origin WebSockets are refused. The gateway
binds it to one provider handle and admits turn starts through the same Sealwire
send path as the composer, including workspace, review, workflow, task role,
active-turn, and budget checks. Codex native approval answers use the ordinary approval
handler. Codex's current Sealwire permissions remain authoritative.

The Claude adapter loads the bundled `sealwire-native` plugin while retaining
the user's configured UI plugins, settings, key encodings, and editor. It hands
an idle SDK session to the installed CLI on the same provider session id. An
empty session can open before its first inference; promotion during an SDK turn
is refused.

A private, authenticated loopback HTTP bridge carries native prompt admission
and normalized provider events. Ordinary prompts are held until the common send
pipeline accepts them. Each model step requires an admitted turn, and model tool
calls require their emitted ids. Hook error handlers deny unadmitted model input
and tools. Session switching, independent native workflows, and native permission
changes are blocked. These controls govern managed agent turns; they do not
restrict manual YOLO shell commands or promise read-only local file access.

Ctrl+C and Esc during a managed turn enter Sealwire's ordinary stop handler,
including task/review guards and goal interruption. Outside a managed turn,
Ctrl+C clears the draft and interrupts native shell execution with Escape;
other control keys pass to the CLI, which can exit normally. Input sequence
deduplication also covers stop retries.
Structured questions use the same Sealwire cards in both views.

Changing model, effort, persona, MCP tools, or trusted setting sources rebuilds an
idle native CLI on the same history. Attached views follow its new terminal id;
queued keystrokes remain bound to the process they were typed for. Changing away
from Full access returns execution to the SDK; use Conversation to continue.

Remote terminal actions use the existing signed, encrypted broker transport.
The relay binds the actor to the signed device identity. Keystrokes carry a
terminal-scoped stream id and increasing sequence: retrying an acknowledged chunk
does not type it twice, including after the broker result cache evicts its reply.
Input streams avoid the workflow write ledger so normal typing cannot exhaust it.

Codex native image inputs use the composer's image validation and limits. Local
image paths must resolve inside the session workspace; use the Sealwire uploader
for other files. Native Codex skill selections are checked against the session's
skill catalog, with one skill per message as in the composer.

Claude refuses attachments pasted directly into the TUI: its prompt hook has no
bytes or trustworthy absolute paths with which to apply the composer's limits.
The CLI may already have read a pasted local path before that hook, consistent
with its YOLO access. Use the Sealwire uploader. Those images are validated, staged in private files,
and pasted through Claude's own image loader; admission verifies that all images
were attached before entering the turn. A native draft submitted during runtime
reconfiguration is refused and must be submitted again, rather than replayed
without its attachments. The native message UUID is used for live and cold
history, avoiding duplicate user rows.

Use the Sealwire skill picker for managed skill invocation. Its catalog-validated
selection is carried separately from ordinary text; only that exact invocation
can authorize the native command. The CLI expands the skill itself. Raw native
skill commands remain refused, and combining a selected skill with image
attachments is explicitly refused rather than silently dropping either.

## Terminal lifecycle

Output is pushed over one HTTP response locally and signed, encrypted broker
frames remotely. PTY notifications wake the stream; idle terminals do not issue
browser read requests. Both transports restore a fresh screen when attached,
then deliver ordered byte chunks. Rendering batches writes and waits for xterm's
parser, with bounded queues; an interrupted or overloaded stream asks for a
reconnect. Typing sends immediately when the input channel is idle. While awaiting
an acknowledgement, later keystrokes merge into the next ordered packet; retries
retain the same sequence. Standalone control keys stay separate for workflow stop
checks.

Remote terminal output has a separate bounded writer queue, below ordinary
messages and heartbeat pings. Across all terminal views on one relay connection,
it sends at most 40 frames/second; a slow socket applies backpressure to terminal
producers rather than filling the ordinary queue. The PTY buffer can replace old
output with a current-screen reset when a view falls behind.

The broker's default surface publish allowance is 3600 messages/minute per device,
shared across tabs. Its 8 MiB/minute byte allowance, 2 MiB burst allowance and
64 KiB frame cap are unchanged. The relay allowance stays at 36000 messages/minute
and 512 MiB/minute. Updating the relay alone does not update a deployed broker:
deploy the broker and remote frontend updates too, and check any explicit
`RELAY_BROKER_PUBLISH_RATE_LIMIT_PER_MINUTE` override. Lower operator-configured
limits still apply and can refuse traffic.

When setting the surface allowance explicitly, also set
`RELAY_BROKER_RELAY_PUBLISH_RATE_LIMIT_PER_MINUTE=36000`; an unset relay override
inherits the explicit generic setting.

Devices attach to one PTY per session. Resizing or focusing a view updates that
shared terminal's dimensions. Reconnection restores its current screen; older
client scrollback is local to that browser. The conversation view retains the
provider transcript and workflow history.

Each PTY has a bounded 1 MiB output buffer. Up to eight Codex terminals and eight
Claude native runtimes can be open. **Close terminal** leaves the agent session
and its workflows running. Codex releases its display client; Claude detaches the
presentation while retaining the CLI that owns execution. Reopening attaches to
that runtime. Releasing or deleting the session closes its process. A native CLI exit also ends
its terminal host and settles outstanding sends and turns; the next composer
send can resume the same history in a fresh CLI. Reopening an idle terminal with
128 input streams renews its input generation while keeping the CLI alive. Input
retries from the retired generation are refused.
The browser uses a WebGL2 canvas renderer under the existing content security
policy. The unused initial DOM renderer can report blocked inline styles before
the canvas replaces it.

The native runtime requires a Codex CLI with `--remote` and
`--remote-auth-token-env`; this implementation was exercised with 0.159.2.

Claude requires an installed CLI with the hooks-module API, version 2.1.292 or
newer (exercised with 2.1.292 and 2.1.301). Missing/older CLIs are refused before
releasing the existing SDK session.
`CLAUDE_BINARY` can select its executable. The worker uses the relay's internal
`terminal-host` helper for PTY ownership; that subcommand opens no relay database
or public server.

## Verification

Build the relay and broker, install the worker dependencies, and build the UI:

```sh
npm ci --prefix claude-worker
cargo build -p relay-server -p relay-broker
npm run build
npm run test:native-terminal
npm run test:browser:native-terminal
NATIVE_TERMINAL_PROVIDER=claude_code NATIVE_TERMINAL_NON_YOLO=1 npm run test:native-terminal
NATIVE_TERMINAL_PROVIDER=claude_code npm run test:native-terminal
NATIVE_TERMINAL_PROVIDER=claude_code NATIVE_TERMINAL_IMAGES=1 npm run test:native-terminal
NATIVE_TERMINAL_PROVIDER=claude_code NATIVE_TERMINAL_QUESTIONS=1 npm run test:native-terminal
NATIVE_TERMINAL_PROVIDER=claude_code NATIVE_TERMINAL_POLICY=1 npm run test:native-terminal
NATIVE_TERMINAL_PROVIDER=claude_code NATIVE_TERMINAL_EXIT=1 npm run test:native-terminal
NATIVE_TERMINAL_PROVIDER=claude_code NATIVE_TERMINAL_RECONNECT=1 npm run test:native-terminal
NATIVE_TERMINAL_PROVIDER=claude_code NATIVE_TERMINAL_IMAGE_SCOPE=1 npm run test:native-terminal
NATIVE_TERMINAL_PROVIDER=claude_code NATIVE_TERMINAL_SKILLS=1 npm run test:native-terminal
NATIVE_TERMINAL_PROVIDER=claude_code npm run test:browser:native-terminal
```

Claude fixtures select YOLO explicitly. The `NATIVE_TERMINAL_NON_YOLO=1` case
verifies that the server refuses Terminal while SDK Conversation remains usable.
`NATIVE_TERMINAL_POLICY=1` checks automatic YOLO execution and returning to SDK
approvals after leaving YOLO. Native shell execution and recovery of managed
messages after manual commands are covered by:

```sh
NATIVE_TERMINAL_PROVIDER=claude_code NATIVE_TERMINAL_BANG=1 npm run test:native-terminal
NATIVE_TERMINAL_PROVIDER=claude_code NATIVE_TERMINAL_HISTORY=1 npm run test:native-terminal
```

These tests use the real installed native CLI and a local model fixture, with no
paid inference. The browser test pairs a real remote client through an isolated
broker, sends native keyboard input from a phone viewport, checks the signed
actor and exactly one inference, and captures screenshots. Every relay uses its
own port, database, config directory, and broker identity.

Real workflow acceptance is opt-in. Parents use `gpt-6-luna` low, or Haiku for
Claude; delegated/reviewer/team workers use Luna low:

```sh
RELAY_PRIVATE_PATH=/path/to/sealwire-private scripts/with-private.sh \
  cargo build -p relay-server --features private
NATIVE_TERMINAL_BROWSER=1 npm run test:native-terminal:live
LIVE_TERMINAL_PROVIDER=claude_code NATIVE_TERMINAL_BROWSER=1 npm run test:native-terminal:live
```

It checks native keyboard input, handover, delegate and report-back, read-only
review, native Codex approvals or Claude YOLO execution, goal planning/completion, confirmed task teams, and native rejection of
input while review owns a session. It copies the existing Codex sign-in into a
private temporary directory and removes that copy on exit. `LIVE_CASES` can name
comma-separated cases for a focused rerun. Results and screenshots are written to
the temporary artifact directory printed at startup.

### Current Claude acceptance evidence

The YOLO-only version passed eight real Haiku/Luna cases: native keyboard input,
automatic YOLO tool execution, native-to-native handover, delegate/report-back,
read-only review, goal planning/completion, a confirmed native-Claude-led team,
and rejection of new agent input while review owns the parent session. Isolated
real-CLI mock runs also passed typed/history shell commands, shell interruption
followed by managed messages, skills, images, questions, permission downgrade to
SDK approvals, and encrypted phone input across model changes.

A real Haiku native team leader, Haiku SDK developer, and Luna reviewer completed
a confirmed team run through sub-task review, the MR gate, wrapping, and `done`,
with the expected committed seven-byte `TEAM_OK` artifact. An earlier failed run
had written the artifact in the source checkout instead of the task worktree;
the fixture now explicitly requires relative paths from the active task cwd.
This run covers a native Claude team leader, not every Claude seat as native.
The reviewer remains an SDK session because its read-only policy is not a YOLO
terminal policy. This does not claim that every Claude team seat has a native TUI.

### Review and accepted permission model

Claude Opus 5.5 xhigh independently reproduced native shell-history execution and
then verified fixes for the other reported issues: CLI/host exit, permission
handling, selected skills, parent cancellation after subagent starts, input
generation renewal, and unchecked attachments. The follow-up found no new P0/P1
on that version.

The product decision subsequently changed to a YOLO-only Claude terminal. Native
shell execution and local file reads are accepted capabilities of this mode,
rather than claims of permission parity with restricted Conversation sessions.
The earlier default-off environment gate and incomplete keystroke filter have
been removed. Cross-mode workflow behavior remains a separate requirement and is
covered by the mock and real workflow fixtures above.

The same Claude Opus 5.5 xhigh reviewer completed a read-only follow-up of the
YOLO-only change with an isolated relay, mock inference, and real CLI 2.1.301.
No new P0/P1 findings were reported. Live probes verified the explicit YOLO gate,
reviewer exclusion, exactly-once composer input, permission downgrade to SDK
approvals, shell history followed by managed input, and selected skills.
Managed workflow admission, lifecycle, session identity, and signed actor binding
were verified against the accepted YOLO contract.

Remaining observations concern UX or intentional behavior: the Terminal selector
is visible on non-YOLO sessions and reports the requirement when opened; a first
native YOLO launch can show Claude's own acceptance dialog. Manual shell commands
have no workflow accounting. An unexpected prompt transformation fails closed,
and text batched with a control key can be discarded as part of that control
action. The reviewer did not independently rerun the full test suites, encrypted
phone case, or timed shell-interruption case; those passed implementation
validation as described above.
