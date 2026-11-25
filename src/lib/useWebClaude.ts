import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { WebInboxProps } from "../components/WebClaudeCards";
import { notify } from "./notify";
import { firstLine, type WebCard } from "./webClaude";

/** What a new card says in a macOS notification. */
export function cardNotice(card: WebCard): { title: string; body: string } {
  return card.kind === "connect"
    ? { title: "Web Claude wants to connect", body: "Type the code from the claude.ai page on the card in Lantern, or Deny it." }
    : { title: card.answer ? `Web Claude answered: ${card.title}` : `Web Claude sent work: ${card.title}`, body: firstLine(card.message) };
}

/**
 * Web Claude's cards for the title bar's inbox: kept up to date from the backend, with a notification for each new one (not
 * for those already there when the window opened). The projects are fetched when a card needs one picked.
 */
export function useWebClaudeInbox(): WebInboxProps {
  const [cards, setCards] = useState<WebCard[]>([]);
  const [projects, setProjects] = useState<[string, string][]>([]);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    let live = true;
    const refresh = () =>
      api.webclaudeCards().then(
        (next) => {
          if (!live) return;
          if (seen.current) {
            for (const c of next) {
              if (seen.current.has(c.id)) continue;
              const { title, body } = cardNotice(c);
              void notify(title, body, "waiting");
            }
          }
          seen.current = new Set([...(seen.current ?? []), ...next.map((c) => c.id)]);
          setCards(next);
        },
        () => {},
      );
    refresh();
    const unlisten = api.onWebclaudeChanged(refresh).catch(() => null);
    return () => {
      live = false;
      unlisten.then((f) => f?.());
    };
  }, []);
  const needsProject = cards.some((c) => c.kind === "run" && !c.answer && !c.folder);
  useEffect(() => {
    if (needsProject) api.webclaudeProjects().then(setProjects, () => {});
  }, [needsProject]);
  return {
    cards,
    projects,
    onAllow: (id, allow, code) => api.webclaudeAllow(id, allow, code),
    onRun: (id, run, folder) => api.webclaudeRun(id, run, folder),
  };
}
