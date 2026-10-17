import { memo, useContext, useMemo } from "react";
import { CloseAgentContext, useChatState, useNodeActions } from "../lib/canvasContext";
import { SlotContext } from "../lib/slot";
import { WAKE_LIMIT, wakesPaused } from "../sessions";
import type { MergeProposal } from "../store";
import { ChatView } from "./ChatView";
import type { StreamHandlers } from "./ChatStream";
import { MergeCard } from "./MergeCard";
import { NodeComposer } from "./NodeComposer";
import { RunPanel } from "./RunPanel";
import { SetupNotice } from "./SetupNotice";

/**
 * The merges to show for an agent: open ones, and the latest answered one for each worker as a quiet line (a merged one
 * with its clear-the-worktree button, one the user said "not yet" to until the lead proposes again). A proposal that was
 * dropped because the branch changed leaves nothing. A main agent shows every worker's; a worker shows its own.
 */
export function visibleProposals(all: MergeProposal[], worker: string | null): MergeProposal[] {
  const mine = worker ? all.filter((p) => p.worker === worker) : all;
  const seen = new Set<string>();
  return [...mine]
    .reverse()
    .filter((p) => {
      if (p.status === "open") return true;
      if (seen.has(p.worker)) return false;
      seen.add(p.worker);
      if (p.status === "declined" && p.problem) return false;
      return !mine.some((q) => q.worker === p.worker && q.status === "open");
    })
    .reverse();
}

/**
 * An agent's conversation on the canvas, with its box: the same chat view as the full-size app, for this agent's own
 * chat. It subscribes to that chat alone and keeps its handlers fixed (but for its test runs), so it redraws when the
 * agent does something and not when the canvas pans, zooms or moves another agent. `parent`: the main agent a worker reports to, whose merge
 * proposals for it are shown here too.
 */
export const NodeBody = memo(function NodeBody({ slot, parent }: { slot: string; parent: string | null }) {
  const state = useChatState(slot);
  const owner = useChatState(parent ?? slot);
  const actions = useNodeActions();
  const closeAgent = useContext(CloseAgentContext);
  // New only when its test runs change: a row of the chat is drawn again when what it is given changes, and a work line
  // shows the test run its step started.
  const testRuns = state?.testRuns;
  const handlers = useMemo<StreamHandlers>(
    () => ({
      onDecide: (id, allow, note, answered) => actions.decide(slot, id, allow, note, answered),
      onOpenFile: (path) => actions.openFile(slot, path),
      onStopShell: (id) => actions.stopShell(slot, id),
      onShellInput: (id, text) => actions.shellInput(slot, id, text),
      testRunFor: (id) => testRuns?.find((r) => r.id === id),
      onOpenTestRun: (id) => actions.openTestRun(slot, id),
    }),
    [slot, actions, testRuns],
  );
  if (!state) return null;
  const proposals = visibleProposals(owner?.proposals ?? [], parent ? slot : null);
  return (
    <SlotContext.Provider value={slot}>
      <div className="node-chat">
        <ChatView state={state} {...handlers} />
      </div>
      {state.setup && (
        <div className="node-merges">
          <SetupNotice card={state.setup} onAnswer={(answer) => actions.answerSetup(slot, answer)} onClose={() => closeAgent(slot)} />
        </div>
      )}
      {state.run && (
        <div className="node-run-panel">
          <RunPanel run={state.run} onStop={() => actions.stopRun(slot)} onRestart={() => actions.run(slot)} onClose={() => actions.closeRun(slot)} />
        </div>
      )}
      {proposals.length > 0 && (
        <div className="node-merges">
          {proposals.map((p) => (
            <MergeCard key={p.worker} proposal={p} />
          ))}
        </div>
      )}
      {wakesPaused(state) && (
        <div className="node-banner info" role="status">
          <span>
            {state.wakes.length === 1 ? "1 update from the agents is" : `${state.wakes.length} updates from the agents are`} held back: {WAKE_LIMIT} replies in a row went out without you, and this keeps the team from running on unwatched.
          </span>
          <button onClick={() => actions.send(slot, "Carry on with the latest updates from the agents.")}>Pass them on</button>
        </div>
      )}
      {state.banner && (
        <div className={`node-banner ${state.banner.kind}`} role="status">
          <span>{state.banner.text}</span>
          {state.banner.action === "restart" && <button onClick={() => actions.restart(slot)}>Restart</button>}
        </div>
      )}
      <NodeComposer slot={slot} status={state.status} queued={state.queued} />
    </SlotContext.Provider>
  );
});
