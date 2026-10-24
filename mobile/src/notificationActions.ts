/**
 * The buttons on a notification (Allow and Deny on a prompt, Reply on a chat that finished), which the phone's lock screen and
 * its Apple Watch show without opening the app. The Mac picks the buttons by the category it names in the push (CATEGORY_* in
 * src-tauri/src/remote/notifier.rs, which must agree with these), and puts the chat and, for a prompt, its request id in the
 * data. A button answers that very prompt: the Mac refuses an id nothing is waiting on.
 *
 * Allow and Reply need the phone (or the watch) unlocked first, because each lets Claude do something: run a command, change a
 * file, or take your words. Deny doesn't. And when the user has turned on Lantern's own Face ID lock, Allow and Reply aren't done
 * from a notification at all (it would get round the lock): they say to open Lantern. Deny is always safe.
 */
import { slotOfNotification } from "./notifications";

export const CATEGORY_DECIDE = "lantern_decide";
export const CATEGORY_REPLY = "lantern_reply";
export const ACTION_ALLOW = "allow";
export const ACTION_DENY = "deny";
export const ACTION_REPLY = "reply";
/** What expo-notifications calls a plain tap on a notification (not one of the buttons). */
export const TAP = "expo.modules.notifications.actions.DEFAULT";

export interface ButtonSpec {
  identifier: string;
  buttonTitle: string;
  textInput?: { submitButtonTitle: string; placeholder: string };
  options: { isDestructive?: boolean; isAuthenticationRequired: boolean; opensAppToForeground: boolean };
}

/**
 * The categories to register with iOS, every launch. None of the buttons opens the app: on the watch that is the point, and the
 * phone then answers in the background.
 */
export const CATEGORIES: { identifier: string; actions: ButtonSpec[] }[] = [
  {
    identifier: CATEGORY_DECIDE,
    actions: [
      { identifier: ACTION_ALLOW, buttonTitle: "Allow", options: { isAuthenticationRequired: true, opensAppToForeground: false } },
      { identifier: ACTION_DENY, buttonTitle: "Deny", options: { isDestructive: true, isAuthenticationRequired: false, opensAppToForeground: false } },
    ],
  },
  {
    identifier: CATEGORY_REPLY,
    actions: [{ identifier: ACTION_REPLY, buttonTitle: "Reply", textInput: { submitButtonTitle: "Send", placeholder: "Message" }, options: { isAuthenticationRequired: true, opensAppToForeground: false } }],
  },
];

/** The parts of a notification response this reads (expo-notifications' NotificationResponse). */
export interface ResponseLike {
  actionIdentifier: string;
  userText?: string;
  notification: { request: { identifier: string; content: { data?: unknown } } };
}

/** What a button's work needs: the chat's connection to the Mac, and a way to say it didn't work. */
export interface ActionHost {
  /** Whether Lantern's own lock is on (the user's choice in Settings). */
  lockOn(): Promise<boolean>;
  /** Resolves true once there is a working connection to the Mac, or false after waiting `ms` for one. */
  connected(ms: number): Promise<boolean>;
  answer(slot: string, requestId: string, allow: boolean): Promise<unknown>;
  send(slot: string, text: string): Promise<unknown>;
  /** A notification of the phone's own, for what didn't work (the success is the notification going away). */
  tell(title: string, body: string): Promise<unknown>;
}

export type ActionResult = { kind: "ignored" } | { kind: "answered"; allow: boolean } | { kind: "sent" } | { kind: "failed"; why: string };

/** How long a button waits for the Mac: the app may have just been woken and must find it first. */
export const CONNECT_WAIT_MS = 20_000;
/** The longest message a Reply sends. */
const REPLY_MAX = 10_000;

/** What waiting for a connection needs: the clock, whether the app thinks it is connected, a round trip to the Mac, a nudge to dial again, and a wait that ends early when the connection changes. */
export interface Link {
  now(): number;
  up(): boolean;
  alive(): Promise<boolean>;
  redial(): void;
  changed(ms: number): Promise<void>;
}

/**
 * Waits up to `ms` for a connection that works. An app woken for a button may still say it is connected from before it was
 * suspended, over a link the phone has dropped since: so a connection is trusted only once the Mac has answered something over it,
 * and a link that doesn't answer is dialled again.
 */
export async function connectedWithin(link: Link, ms: number): Promise<boolean> {
  const until = link.now() + ms;
  link.redial();
  while (link.now() < until) {
    if (link.up() && (await link.alive().catch(() => false))) return true;
    link.redial();
    await link.changed(Math.min(1000, Math.max(until - link.now(), 0)));
  }
  return false;
}

/** The prompt a notification is about: the Mac puts its id in the data, and nothing else is let through. */
export function requestIdOfNotification(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const id = (data as { request_id?: unknown }).request_id;
  return typeof id === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(id) ? id : null;
}

/** Whether a response is one of the buttons (and not a tap, which opens the chat). */
export const isButton = (r: ResponseLike) => r.actionIdentifier === ACTION_ALLOW || r.actionIdentifier === ACTION_DENY || r.actionIdentifier === ACTION_REPLY;

/**
 * What a button does. Each press is done once (`handled` keeps what this run has done: the same response can arrive again, as
 * the last one does when the app starts), and one that can't be done says so in a notification instead of failing silently.
 */
export async function runButton(r: ResponseLike, host: ActionHost, handled: Set<string>): Promise<ActionResult> {
  if (!isButton(r)) return { kind: "ignored" };
  const once = `${r.notification.request.identifier}:${r.actionIdentifier}`;
  if (handled.has(once)) return { kind: "ignored" };
  handled.add(once);
  const data = r.notification.request.content.data;
  const slot = slotOfNotification(data);
  const requestId = requestIdOfNotification(data);
  const reply = r.actionIdentifier === ACTION_REPLY;
  const allow = r.actionIdentifier === ACTION_ALLOW;
  const text = (r.userText ?? "").trim().slice(0, REPLY_MAX);
  const what = reply ? "send your reply" : allow ? "allow that" : "deny that";
  const fail = async (why: string): Promise<ActionResult> => {
    await host.tell(`Couldn't ${what}`, why).catch(() => {});
    return { kind: "failed", why };
  };
  if (!slot || (!reply && !requestId)) return fail("That notification doesn't say which chat or prompt it was for. Open Lantern.");
  if (reply && !text) return { kind: "ignored" };
  if ((reply || allow) && (await host.lockOn().catch(() => true))) return fail("Lantern is locked. Open Lantern to do it.");
  if (!(await host.connected(CONNECT_WAIT_MS))) return fail("Lantern couldn't reach your Mac. Open Lantern to do it.");
  try {
    if (reply) {
      await host.send(slot, text);
      return { kind: "sent" };
    }
    await host.answer(slot, requestId as string, allow);
    return { kind: "answered", allow };
  } catch (e) {
    return fail((e as Error).message || "Your Mac said no.");
  }
}
