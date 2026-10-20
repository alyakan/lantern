import type { Chats } from "../sessions";
import type { ProjectOpen } from "./sidebar";

/**
 * What the window tells the backend's session hub about its open chats: the title it shows, and a chat that is asleep
 * (its claude stopped to save memory, or restored and not opened yet), with its session. Where a chat stands otherwise
 * (working, waiting on you) the hub knows from the chat's events, so it isn't sent.
 */
export interface WindowChat {
  slot: string;
  folder: string;
  title: string;
  asleep: boolean;
  session_id: string | null;
}

export function windowChats(chats: Chats, open: Record<string, ProjectOpen>): WindowChat[] {
  return Object.entries(open).flatMap(([folder, project]) =>
    project.items.map((item) => {
      const s = chats.slots[item.slot];
      return { slot: item.slot, folder: s?.folder ?? folder, title: item.title, asleep: s?.status === "asleep", session_id: s?.sessionId ?? null };
    }),
  );
}
