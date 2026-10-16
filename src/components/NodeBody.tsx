import { memo, useContext, useMemo, useRef, useState } from "react";
import { CloseAgentContext, useChatState, useNodeActions } from "../lib/canvasContext";
import { nodeStatus } from "../lib/orchestraView";
import { longSpan, useQuiet } from "../lib/quiet";
import { useQuietAfter } from "../lib/quietSetting";
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

/** What Nudge sends: a short ask a stuck agent can answer in a line. */
export const NUDGE_MESSAGE = "Quick check: please reply with a one-line status of what you are doing right now.";

/**
 * An agent at work that has said nothing for the user's quiet time (Settings > General): how long, and what to do about it.
 * Nudge asks it for a one-line status, Interrupt stops its current turn (the agent stays, and can be messaged), Restart
 * starts its claude again, which asks first because it loses the step in progress.
 */
function QuietLine({ slot, activityAt, working, stopping }: { slot: string; activityAt: number | null; working: boolean; stopping: boolean }) {
  const actions = useNodeActions();
  const quiet = useQuiet(activityAt, working, useQuietAfter());
  // One nudge for each stretch of quiet: any word from the agent (a new activityAt) gives it a fresh one.
  const [nudged, setNudged] = useState<number | null>(null);
  // Dismissed the same way: the banner stays hidden for this stretch of quiet only.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  if (!quiet?.stuck) return null;
  if (confirming) {
    return (
      <div className="node-banner node-quiet-line" role="alertdialog" aria-label="Restart this agent?">
        <span>Restarting starts it again on the same conversation. The step it is in the middle of is lost and anything it runs in the background stops. Its chat and files stay.</span>
        <button className="danger" onClick={() => (setConfirming(false), actions.restart(slot))}>
          Restart anyway
        </button>
        <button autoFocus onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </div>
    );
  }
  if (dismissed !== null && dismissed === activityAt) return null;
  const sent = nudged !== null && nudged === activityAt;
  return (
    <div className="node-banner node-quiet-line" role="status">
      <span>Quiet for {longSpan(quiet.ms)}. It may be stuck.</span>
      <button disabled={sent} title="Ask it for a one-line status" onClick={() => (setNudged(activityAt), actions.send(slot, NUDGE_MESSAGE))}>
        {sent ? "Nudged" : "Nudge"}
      </button>
      <button disabled={stopping} title="Stop what it is doing now. It stays on the team and you can message it" onClick={() => actions.stop(slot)}>
        {stopping ? "Interrupting…" : "Interrupt"}
      </button>
      <button title="Start it again, losing the step it is on" onClick={() => setConfirming(true)}>
        Restart
      </button>
      <button className="node-banner-close" aria-label="Dismiss" title="Hide this until it says something new" onClick={() => setDismissed(activityAt)}>
        ×
      </button>
    </div>
  );
}

/**
 * An agent's conversation on the canvas, with its box: the same chat view as the full-size app, for this agent's own
 * chat. It subscribes to that chat alone and keeps its handlers fixed, so it redraws when the agent does something and
 * not when the canvas pans, zooms or moves another agent. `parent`: the main agent a worker reports to, whose merge
 * proposals for it are shown here too.
 */
export const NodeBody = memo(function NodeBody({ slot, parent }: { slot: string; parent: string | null }) {
  const state = useChatState(slot);
  const owner = useChatState(parent ?? slot);
  const actions = useNodeActions();
  const closeAgent = useContext(CloseAgentContext);
  const latest = useRef(state);
  latest.current = state;
  const handlers = useMemo<StreamHandlers>(
    () => ({
      onDecide: (id, allow, note, answered) => actions.decide(slot, id, allow, note, answered),
      onOpenFile: (path) => actions.openFile(slot, path),
      onStopShell: (id) => actions.stopShell(slot, id),
      onShellInput: (id, text) => actions.shellInput(slot, id, text),
      testRunFor: (id) => latest.current?.testRuns.find((r) => r.id === id),
      onOpenTestRun: (id) => actions.openTestRun(slot, id),
    }),
    [slot, actions],
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
      <QuietLine slot={slot} activityAt={state.activityAt} working={nodeStatus(state) === "working"} stopping={state.stopRequested} />
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
