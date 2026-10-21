import type { ReactElement } from "react";
import { render } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Controller } from "../shell/controller";
import { ControllerContext } from "../shell/hooks";
import { TipsContext } from "../shell/tipsContext";
import type { TipJar } from "../tips";
import type { ConnectionState } from "../net/connection";
import type { Transport } from "../net/transport";
import type { RemoteChat } from "../protocol/generated/RemoteChat";
import type { RemoteEvent } from "../protocol/generated/RemoteEvent";
import type { Waiting } from "../protocol/generated/Waiting";
import { MemoryStore } from "./memoryStore";

export const NOW = 1_000_000_000;

export const chat = (over: Partial<RemoteChat> = {}): RemoteChat => ({ slot: "a", title: "Release 0.1.53", project: "lantern", status: "idle", last_seq: 1, active_at: NOW - 60_000, permissions: null, preset: null, ...over });

export const waiting = (over: Partial<Waiting> = {}): Waiting => ({ slot: "a", chat_title: null, request_id: "p1", tool_name: "Bash", input: { command: "git push origin release/0.1.53", description: "Push the release branch" }, at: 1, ...over });

/** A controller that goes nowhere (its transport never opens) with frames applied the moment they are queued. */
export function makeController() {
  const transport: Transport = { open: () => Promise.reject(new Error("no network in tests")) };
  const store = new MemoryStore();
  const controller = new Controller({ transport, store, deviceName: "Test phone", appVersion: "1.0", now: () => NOW, sync: { schedule: (fn) => fn(), now: () => NOW, newId: () => "m-test" } });
  return { controller, store };
}

export interface Seed {
  connection?: ConnectionState;
  chats?: RemoteChat[];
  waiting?: Waiting[];
  /** Events of followed chats, as the Mac would send them live. */
  events?: Record<string, RemoteEvent[]>;
  /** The tip jar the screens find (none: one with no store behind it). */
  tips?: TipJar;
}

/** Connected to a Mac that has Controls (Welcome's features), as an up-to-date Lantern is. */
export const connectedWithControls: ConnectionState = { kind: "connected", host: "192.168.1.20", welcome: { type: "welcome", protocol: 1, app_version: "0.1.54", mac_name: "Aly's MacBook Pro", epoch: 1, features: ["controls"] } };

export const connected: ConnectionState = { kind: "connected", host: "192.168.1.20", welcome: { type: "welcome", protocol: 1, app_version: "0.1.53", mac_name: "Aly's MacBook Pro", epoch: 1, features: [] } };

export function seed(controller: Controller, s: Seed) {
  controller.setConnection(s.connection ?? connected);
  const sync = controller.sync;
  // Seeding either says what the Mac sent: the other is then "none", not "not yet" (which Home shows as a skeleton).
  if (s.chats || s.waiting) {
    sync.apply({ type: "pushed", msg: { type: "chats", chats: s.chats ?? [] } });
    sync.apply({ type: "waiting", list: s.waiting ?? [] });
  }
  for (const [slot, events] of Object.entries(s.events ?? {})) events.forEach((event, i) => sync.apply({ type: "pushed", msg: { type: "event", slot, seq: i + 1, event } }));
}

export async function renderWith(ui: ReactElement, s: Seed = {}, controller = makeController().controller) {
  seed(controller, s);
  const result = await render(
    <SafeAreaProvider>
      <ControllerContext.Provider value={controller}>
        {s.tips ? <TipsContext.Provider value={s.tips}>{ui}</TipsContext.Provider> : ui}
      </ControllerContext.Provider>
    </SafeAreaProvider>,
  );
  return { ...result, controller };
}
