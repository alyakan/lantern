import type { Chats } from "../sessions";
import { nodeStatus } from "./orchestraView";

/**
 * Whether anything is at work, in any project or team, for keeping the Mac awake: a chat or agent that is running (or
 * has messages queued to go next), or one paused mid-turn on a question or permission for the user. One that is idle,
 * stopped or done doesn't count, nor does one only starting up (a chat opening), nor a restored chat whose old
 * question nobody can answer.
 */
export function anythingWorking(chats: Chats): boolean {
  return Object.values(chats.slots).some((s) => {
    if (s.queued.length > 0) return true;
    const status = nodeStatus(s);
    return status === "working" || (status === "waiting" && s.status === "running");
  });
}
