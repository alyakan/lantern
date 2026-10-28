/** Where the user is: a stack of screens with Home at the bottom. Pure, so the back button is tested without a screen. */

export type Route = { name: "home" } | { name: "chat"; slot: string } | { name: "decide"; slot: string; requestId: string };

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
  | { type: "home" };

const same = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b);

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
  }
}

/** The chat a tablet shows beside (or under) the chats: the last one the stack has been to, a decision's own chat included. None: the pane says to pick one. */
export function shownSlot(stack: Nav): string | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    const r = stack[i];
    if (r.name !== "home") return r.slot;
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
