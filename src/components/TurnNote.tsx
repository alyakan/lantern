import type { ChatItem } from "../store";

type TurnItem = Extract<ChatItem, { type: "turn" }>;

/**
 * Says nothing after a normal turn; only stops, errors and denied actions are worth a line. A stopped or failed turn
 * can be sent again (`onRetry`), when the chat is idle.
 */
export function TurnNote({ item, onRetry }: { item: TurnItem; onRetry?: () => void }) {
  if (!item.stopped && !item.isError && item.denied === 0) return null;
  return (
    <div className="turn-note">
      {item.stopped && <div className="muted">Stopped</div>}
      {item.isError && <div className="error">{item.result ?? "The turn ended with an error."}</div>}
      {item.denied > 0 && <div className="muted">{`${item.denied} action${item.denied === 1 ? "" : "s"} denied`}</div>}
      {onRetry && (item.stopped || item.isError) && (
        <button className="link-button" title="Sends this prompt again. Files it changes and commands it runs happen again." onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
