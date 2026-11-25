/**
 * A chat this phone asked the Mac to start. Its page opens as the New chat sheet goes, with the first message in it, and becomes
 * the chat once the Mac answers with its slot (which may take a few seconds, longer with photos).
 */
export interface Start {
  id: string;
  /** The project's folder, and its name as the sheet showed it. */
  project: string;
  projectName: string;
  /** The first message, as it was sent. */
  text: string;
  /** Where this phone has the photos that went with it. */
  thumbs: string[];
  /** The ask already on its way (sent as Start was tapped, not once the sheet had gone). */
  asked: Promise<string>;
  /** Asks the Mac again, with the same message and choices: the new chat's slot. */
  ask: () => Promise<string>;
}

/** A start as its page shows it: still waiting, or why the Mac didn't start it. */
export interface StartShown {
  start: Start;
  problem: string | null;
  /** Sent from its message box before the chat was there, in order: they go once it is. */
  queued: string[];
}

let next = 0;
/** An id for a start, unique while the app runs (starts are not kept across launches). */
export const newStartId = () => `start-${Date.now().toString(36)}-${(next++).toString(36)}`;
