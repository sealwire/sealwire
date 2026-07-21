import { isWorkingThreadStatus } from "./thread-status.js";

/**
 * Decompose a session snapshot into the THREE distinct status subjects the UI
 * conflates today (UX critique #4): provider readiness, the current task, and
 * any cross-cutting attention (a pending approval). The relay ships these as
 * separate fields, but every surface currently collapses them into a single
 * ambiguous word — "Standby"/"Live" — whose subject the user has to guess ("the
 * first page said Running, why is this one Standby?").
 *
 * This is the shared seam between `SessionSnapshot` and the chrome: it turns the
 * relay's internal fields into task-language subjects in ONE place, so a surface
 * can render "Providers: Ready · Task: none" without re-deriving the mapping (it
 * is copy-pasted across app.js, render-session.js, and remote/chrome-view-model
 * today — that duplication is exactly how the wording drifts).
 *
 * `primaryLabel` collapses the subjects back into one salience-ordered label
 * (approval > offline > task) for surfaces that still render a single pill, so a
 * caller can adopt the seam before doing any layout work.
 *
 * @param {object|null} session - the session snapshot
 * @param {{ approval?: object|null }} [opts]
 * @returns {{
 *   providers: { ready: boolean, label: string },
 *   task: { state: "none"|"idle"|"working", label: string },
 *   attention: { kind: string, label: string } | null,
 *   primaryLabel: string,
 * }}
 */
export function describeSessionStatus(session, { approval = null } = {}) {
  const providersReady = Boolean(session?.provider_connected);
  const providers = providersReady
    ? { ready: true, label: "Ready" }
    : { ready: false, label: "Offline" };

  const task = deriveTaskSubject(session);
  const attention = approval ? { kind: "approval", label: "Approval required" } : null;

  return {
    providers,
    task,
    attention,
    primaryLabel: derivePrimaryLabel({ providers, task, attention }),
  };
}

/**
 * The provider + task subjects as label:value chips for a status line / overview
 * row — e.g. `Providers: Ready · Task: No active task`. This is the visible
 * realization of the decomposition (UX critique #4): the surface names each
 * subject instead of collapsing them into one ambiguous word. Attention (a
 * pending approval) is intentionally NOT a chip — it rides the salient header
 * pill via `primaryLabel`.
 *
 * @param {object|null} session
 * @param {{ approval?: object|null }} [opts]
 * @returns {Array<{ label: string, value: string }>}
 */
export function describeStatusChips(session, { approval = null } = {}) {
  const { providers, task } = describeSessionStatus(session, { approval });
  return [
    { label: "Providers", value: providers.label },
    { label: "Task", value: task.label },
  ];
}

// The "task" subject answers "what is the agent doing for me?" — distinct from
// "is the service up?" (providers). An open-but-quiet thread is `idle`, NOT the
// same as having no session at all (`none`); the old single label called both
// "Standby".
function deriveTaskSubject(session) {
  if (!session?.active_thread_id) {
    return { state: "none", label: "No active task" };
  }
  const working =
    Boolean(session.active_turn_id) || isWorkingThreadStatus(session.current_status);
  return working ? { state: "working", label: "Working" } : { state: "idle", label: "Idle" };
}

// Salience order for a single-pill surface: an approval blocks the user and wins
// over everything; a provider outage wins over task state; otherwise the task
// subject speaks for itself. Each branch names its subject so the word is no
// longer ambiguous ("Providers offline" / "No active task", not bare "Offline"
// / "Standby").
function derivePrimaryLabel({ providers, task, attention }) {
  if (attention) return attention.label;
  if (!providers.ready) return "Providers offline";
  if (task.state === "none") return "No active task";
  return task.label;
}
