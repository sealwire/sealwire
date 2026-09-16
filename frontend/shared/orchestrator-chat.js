/**
 * Orchestrator composer actions (testable, out of `render-session.js`).
 * `send` is chat only; `propose` stages a card — neither starts work.
 */
import { splitOrchestratorProposalDraft } from "./orchestrator-proposal-draft.js";

export function createOrchestratorChatActions({
  state,
  sendMessage,
  stopActiveTurn = null,
  proposeOrchestratorTask,
  confirmOrchestratorProposal,
  reviseOrchestratorProposal,
  teamsCache,
  onOpenTask,
  // What the relay actually said, for the thread that refused. `sendMessage`
  // only reports pass/fail; it files the relay's sentence against the thread
  // (see shared/composer-errors.js) and this is how the pane gets it back.
  // The same read is used after Stop: lifecycle files against the named thread
  // and syncs only the conversation's #composer-error node.
  readSendError = () => "",
  renderTaskTeam = () => {},
  renderSession = () => {},
}) {
  function stageProposal(proposal) {
    if (!proposal || !state.session) {
      return;
    }
    const existing = Array.isArray(state.session.orchestrator_proposals)
      ? state.session.orchestrator_proposals
      : [];
    state.session = {
      ...state.session,
      orchestrator_proposals: [
        ...existing.filter((entry) => entry?.id !== proposal.id),
        proposal,
      ],
    };
  }

  function dropProposal(proposalId) {
    if (!state.session) {
      return;
    }
    state.session = {
      ...state.session,
      orchestrator_proposals: (state.session.orchestrator_proposals || []).filter(
        (entry) => entry?.id !== proposalId
      ),
    };
  }

  /**
   * Chat, and only chat. A message goes to the Orchestrator thread; nothing is
   * proposed and nothing is started. "hello" is a greeting, not a work order —
   * deciding that a message describes a task is the model's job (a `propose_task`
   * tool call), not something the composer can infer from the fact that you typed.
   */
  async function send(text, threadId, images = []) {
    const attached = Array.isArray(images) ? images : [];
    // An image on its own is a message. Only "nothing at all" is not.
    if ((!text && attached.length === 0) || !threadId || typeof sendMessage !== "function") {
      return;
    }
    state.orchestratorSending = true;
    state.orchestratorSendError = null;
    if (state.session) {
      renderTaskTeam(state.session);
    }
    try {
      // The Orchestrator's composer shows no model picker and no settings gear,
      // so it must not silently ship the session composer's values either.
      const ok = await sendMessage(text, threadId, attached, {
        inheritComposerSettings: false,
      });
      if (!ok) {
        // The relay names the thread AND the reason — a busy turn, a pin that
        // no longer resolves, a workspace that is gone. Each of those has a
        // different next move, and "Message was not accepted" tells them apart
        // for nobody. Show what was said; the generic line is the last resort
        // for a refusal that left no sentence behind.
        let reason = "";
        try {
          reason = readSendError(threadId) || "";
        } catch {
          reason = "";
        }
        state.orchestratorSendError = reason || "Message was not accepted";
      }
    } catch (error) {
      state.orchestratorSendError = error?.message || String(error);
    } finally {
      state.orchestratorSending = false;
      if (state.session) {
        renderTaskTeam(state.session);
      }
    }
  }

  /**
   * Interrupt a turn started in this pane. Failures are filed against the
   * Orchestrator thread by `stopActiveTurn`; this copies that sentence onto the
   * pane's own red line, because the conversation's `#composer-error` is a
   * different node and stays blank while Tasks is open.
   */
  async function stop(threadId) {
    if (!threadId || typeof stopActiveTurn !== "function") {
      return;
    }
    state.orchestratorSendError = null;
    if (state.session) {
      renderTaskTeam(state.session);
    }
    try {
      const ok = await stopActiveTurn(threadId);
      if (!ok) {
        let reason = "";
        try {
          reason = readSendError(threadId) || "";
        } catch {
          reason = "";
        }
        state.orchestratorSendError = reason || "Stop failed";
      }
    } catch (error) {
      state.orchestratorSendError = error?.message || String(error);
    } finally {
      if (state.session) {
        renderTaskTeam(state.session);
      }
    }
  }

  /**
   * Stage a task card from the composer draft (first line = title). This is the
   * explicit "Propose as task" path — it creates a proposal and stops there. The
   * run only begins when the user confirms the card.
   */
  async function propose(text) {
    if (typeof proposeOrchestratorTask !== "function") {
      return;
    }
    const parts = splitOrchestratorProposalDraft(text);
    if (!parts?.title) {
      state.orchestratorSendError = "Write a title (first line) before proposing a task";
      if (state.session) {
        renderTaskTeam(state.session);
      }
      return;
    }
    state.orchestratorProposalBusy = true;
    state.orchestratorSendError = null;
    if (state.session) {
      renderTaskTeam(state.session);
    }
    try {
      const receipt = await proposeOrchestratorTask({
        title: parts.title,
        context: parts.context || null,
      });
      stageProposal(receipt?.proposal);
    } catch (error) {
      state.orchestratorSendError = error?.message || String(error);
    } finally {
      state.orchestratorProposalBusy = false;
      if (state.session) {
        renderTaskTeam(state.session);
      }
    }
  }

  /** Apply a staged card: this is the one step that actually starts a run. */
  async function confirm(proposalId) {
    if (!proposalId || typeof confirmOrchestratorProposal !== "function") {
      return null;
    }
    const receipt = await confirmOrchestratorProposal(proposalId);
    dropProposal(proposalId);
    if (teamsCache?.invalidate) {
      teamsCache.invalidate();
    }
    const teamRunId = receipt?.team_run_id;
    if (teamRunId && typeof onOpenTask === "function") {
      onOpenTask(teamRunId);
    }
    if (state.session) {
      renderSession(state.session);
    }
    return receipt;
  }

  /**
   * Edit a staged card in place. Starts nothing — the returned proposal
   * replaces the staged one, so the card redraws from what the relay stored
   * rather than from what this client hoped it would store.
   */
  async function revise(proposalId, updates) {
    if (!proposalId || typeof reviseOrchestratorProposal !== "function") {
      return null;
    }
    const receipt = await reviseOrchestratorProposal(proposalId, updates);
    if (receipt?.proposal) {
      stageProposal(receipt.proposal);
    }
    if (state.session) {
      renderTaskTeam(state.session);
    }
    return receipt;
  }

  return { send, stop, propose, confirm, revise };
}
