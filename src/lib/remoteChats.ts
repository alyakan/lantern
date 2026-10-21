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

/** What the backend asks of the window when a phone starts a chat (see remote::NewChatRequest). */
export interface RemoteNewChat {
  id: string;
  folder: string;
  text: string;
  permissions: string;
}

/**
 * Whether the window starts the chat a phone asked for, and why not. The backend has checked the same things, but any window
 * can emit the event this one listens for, so this window checks for itself: the chat is to start on Ask (never Auto, whatever
 * the project was left on: nobody is at the Mac to approve), in a project the user already works in, with a message written
 * and not enormous.
 */
export function checkRemoteNewChat(r: RemoteNewChat, isKnownProject: boolean, validText: boolean): string | null {
  if (r.permissions !== "ask") return "A chat started from a phone starts on Ask.";
  if (!validText) return "Write what the chat should start with.";
  if (!isKnownProject) return "That isn't one of your projects.";
  return null;
}
