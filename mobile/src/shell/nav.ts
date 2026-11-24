/** Where the user is: a stack of screens with Home at the bottom. Pure, so the back button is tested without a screen. */

export type Route =
  | { name: "home" }
  /** `via`: the start it was opened as (a chat started from this phone), so the page stays the page it was, not a new one. */
  | { name: "chat"; slot: string; via?: string }
  /** A chat this phone asked the Mac to start, open before the Mac has answered (by its start's id). */
  | { name: "starting"; id: string }
  | { name: "decide"; slot: string; requestId: string };

export type Nav = Route[];

export const home: Nav = [{ name: "home" }];

export type NavAction =
  | { type: "open_chat"; slot: string }
  | { type: "review"; slot: string; requestId: string }
  | { type: "back" }
  /** A notification was tapped: that chat, with Home beneath it, whatever was open. */
  | { type: "jump_to_chat"; slot: string }
  /** On a tablet, a prompt's decision opens beside the chats, in its own chat's place: that chat, with the decision over it. */
  | { type: "jump_to_review"; slot: string; requestId: string }
  | { type: "home" }
  /** A chat was asked for: its page opens at once, before the Mac answers (`jump`: a tablet's, in place of the chat shown). */
  | { type: "start_chat"; id: string; jump?: boolean }
  /** The Mac answered: the starting page becomes that chat, where it is. Gone back from already: nothing changes. */
  | { type: "started"; id: string; slot: string };

// A chat is the same chat whichever way it was opened.
const same = (a: Route, b: Route) => (a.name === "chat" && b.name === "chat" ? a.slot === b.slot : JSON.stringify(a) === JSON.stringify(b));

const isStart = (r: Route, id: string) => r.name === "starting" && r.id === id;

export function navigate(stack: Nav, action: NavAction): Nav {
  const top = stack[stack.length - 1];
  switch (action.type) {
    case "open_chat": {
      const next: Route = { name: "chat", slot: action.slot };
      return same(top, next) ? stack : [...stack, next];
    }
    case "review": {
      const next: Route = { name: "decide", slot: action.slot, requestId: action.requestId };
      return same(top, next) ? stack : [...stack, next];
    }
    case "back":
      return stack.length > 1 ? stack.slice(0, -1) : stack;
    case "jump_to_chat":
      return [...home, { name: "chat", slot: action.slot }];
    case "jump_to_review":
      return [...home, { name: "chat", slot: action.slot }, { name: "decide", slot: action.slot, requestId: action.requestId }];
    case "home":
      return home;
    case "start_chat": {
      const next: Route = { name: "starting", id: action.id };
      return action.jump ? [...home, next] : same(top, next) ? stack : [...stack, next];
    }
    case "started":
      return stack.some((r) => isStart(r, action.id)) ? stack.map((r) => (isStart(r, action.id) ? { name: "chat", slot: action.slot, via: action.id } : r)) : stack;
  }
}

/** The chat a tablet shows beside (or under) the chats: the last one the stack has been to, a decision's own chat included. None: the pane says to pick one (or a chat is still starting). */
export function shownSlot(stack: Nav): string | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    const r = stack[i];
    if (r.name === "starting") return null;
    if (r.name !== "home") return r.slot;
  }
  return null;
}

/** The start a tablet shows beside the chats: the last page the stack has been to, when that is a chat still starting. */
export function shownStart(stack: Nav): string | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    const r = stack[i];
    if (r.name === "starting") return r.id;
    if (r.name !== "home") return null;
  }
  return null;
}

/** The decision on top of the stack, if there is one. */
export function decision(stack: Nav): Extract<Route, { name: "decide" }> | null {
  const top = stack[stack.length - 1];
  return top.name === "decide" ? top : null;
}

/** Whether going back leaves the app (the stack is at Home). */
export const atRoot = (stack: Nav) => stack.length <= 1;
