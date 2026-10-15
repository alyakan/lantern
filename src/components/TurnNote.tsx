import type { ChatItem } from "../store";
import { usageLine } from "../lib/cost";

type TurnItem = Extract<ChatItem, { type: "turn" }>;

/**
 * The line after a turn: what it cost and used, when known, and only stops, errors and denied actions otherwise. A
 * stopped or failed turn can be sent again (`onRetry`), when the chat is idle.
 */
export function TurnNote({ item, onRetry }: { item: TurnItem; onRetry?: () => void }) {
  const usage = usageLine(item.cost ?? null, item.tokens ?? null);
  if (!item.stopped && !item.isError && item.denied === 0 && !usage) return null;
  return (
    <div className="turn-note">
      {item.stopped && <div className="muted">Stopped</div>}
      {item.isError && <div className="error">{item.result ?? "The turn ended with an error."}</div>}
      {item.denied > 0 && <div className="muted">{`${item.denied} action${item.denied === 1 ? "" : "s"} denied`}</div>}
      {usage && (
        <div className="turn-usage muted" title="Tokens count input (cached input included) and output. The cost is what this turn added to the chat.">
          {usage}
        </div>
      )}
      {onRetry && (item.stopped || item.isError) && (
        <button className="link-button" title="Sends this prompt again. Files it changes and commands it runs happen again." onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
