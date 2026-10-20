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
    case "home":
      return home;
  }
}

/** Whether going back leaves the app (the stack is at Home). */
export const atRoot = (stack: Nav) => stack.length <= 1;
