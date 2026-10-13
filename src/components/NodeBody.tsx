import { memo, useMemo, useRef } from "react";
import { useChatState, useNodeActions } from "../lib/canvasContext";
import { SlotContext } from "../lib/slot";
import { ChatView } from "./ChatView";
import type { StreamHandlers } from "./ChatStream";
import { NodeComposer } from "./NodeComposer";

/**
 * An agent's conversation on the canvas, with its box: the same chat view as the full-size app, for this agent's own
 * chat. It subscribes to that chat alone and keeps its handlers fixed, so it redraws when the agent does something and
 * not when the canvas pans, zooms or moves another agent.
 */
export const NodeBody = memo(function NodeBody({ slot }: { slot: string }) {
  const state = useChatState(slot);
  const actions = useNodeActions();
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
  return (
    <SlotContext.Provider value={slot}>
      <div className="node-chat">
        <ChatView state={state} {...handlers} />
      </div>
      {state.banner && (
        <div className={`node-banner ${state.banner.kind}`} role="status">
          <span>{state.banner.text}</span>
          {state.banner.action === "restart" && (
            <button onClick={() => actions.restart(slot)}>Restart</button>
          )}
        </div>
      )}
      <NodeComposer slot={slot} status={state.status} queued={state.queued} />
    </SlotContext.Provider>
  );
});
