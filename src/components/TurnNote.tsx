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
  const retry = onRetry && (item.stopped || item.isError) && (
    <button className="turn-retry" title="Sends this prompt again. Files it changes and commands it runs happen again." onClick={onRetry}>
      Retry
    </button>
  );
  return (
    <div className="turn-note">
      {item.stopped && (
        <div className="turn-stopped muted">
          <span className="stop-mark" aria-hidden />
          Stopped
          {retry}
        </div>
      )}
      {/* An error is a card of its own, as a waiting prompt is: what went wrong, and the way to try again beside it. */}
      {item.isError && (
        <div className="turn-error">
          <span className="turn-error-text">{item.result ?? "The turn ended with an error."}</span>
          {retry}
        </div>
      )}
      {item.denied > 0 && <div className="muted">{`${item.denied} action${item.denied === 1 ? "" : "s"} denied`}</div>}
      {usage && (
        <div className="turn-usage muted" title="Tokens count input (cached input included) and output. The cost is what this turn added to the chat.">
          {usage}
        </div>
      )}
    </div>
  );
}
