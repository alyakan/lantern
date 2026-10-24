import "@shopify/flash-list/jestSetup";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import type { CardFactory, CardInstance, CardProps } from "../liveActivity";
import { attachSession } from "../test/fakeSession";
import { chat, connectedWith, makeController, renderWith } from "../test/render";
import { ChatScreen } from "./ChatScreen";

/** A fake native side: the cards it started, and what became of each. */
function fakeCards() {
  const started: { props: CardProps; url?: string; ended: string[]; token: string | null }[] = [];
  const factory: CardFactory = {
    start: (props, url) => {
      const card = { props, url, ended: [] as string[], token: "ab".repeat(32) };
      started.push(card);
      const instance: CardInstance = {
        getId: () => "id",
        getPushToken: async () => card.token,
        addPushTokenListener: () => ({ remove: () => {} }),
        end: async (policy) => void card.ended.push(policy ?? "default"),
      };
      return instance;
    },
  };
  return { started, factory };
}

async function chatScreen(features: string[], liveFactory?: () => CardFactory | null, before?: (c: ReturnType<typeof makeController>["controller"]) => Promise<void>, answers: Parameters<typeof attachSession>[1] = {}, chatOver: Parameters<typeof chat>[0] = {}) {
  const { controller } = makeController({ liveFactory });
  const session = attachSession(controller, answers, features);
  await before?.(controller);
  await renderWith(<ChatScreen slot="a" onBack={jest.fn()} onReview={jest.fn()} />, { connection: connectedWith(features), chats: [chat(chatOver)], events: { a: [] } }, controller);
  await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
  return { ...session, controller };
}

const send = async (text: string) => {
  await fireEvent.changeText(screen.getByLabelText("Message"), text);
  await fireEvent.press(screen.getByRole("button", { name: "Send" }));
};

describe("the lock-screen card, from the chat screen", () => {
  it("starts when a message is sent to a Mac that keeps cards, and tells the Mac its token", async () => {
    const { started, factory } = fakeCards();
    const { lastOf } = await chatScreen(["liveactivity"], () => factory);
    await send("ship it");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0].props).toMatchObject({ project: "lantern", status: "working" });
    expect(started[0].url).toBe("lantern://chat/a");
    await waitFor(() => expect(lastOf("live_activity")).toEqual({ op: "live_activity", card: { slot: "a", token: "ab".repeat(32), project: "lantern", since: expect.any(Number) } }));
  });

  it("takes the card back, and starts none the Mac hears of, when the Mac refuses the message", async () => {
    const { started, factory } = fakeCards();
    const { lastOf } = await chatScreen(["liveactivity"], () => factory, undefined, { send: new Error("That chat isn't open on your Mac.") });
    await send("ship it");
    await waitFor(() => expect(started).toHaveLength(1));
    await waitFor(() => expect(started[0].ended).toEqual(["immediate"]));
    expect(lastOf("live_activity")).toBeUndefined();
  });

  it("doesn't start for a Mac that doesn't keep cards", async () => {
    const { started, factory } = fakeCards();
    const { lastOf } = await chatScreen([], () => factory);
    await send("ship it");
    await waitFor(() => expect(lastOf("send")).toBeTruthy());
    expect(started).toEqual([]);
    expect(lastOf("live_activity")).toBeUndefined();
  });

  it("is cleared by opening the chat it is for, which tells the Mac there is none", async () => {
    const { started, factory } = fakeCards();
    const { lastOf } = await chatScreen(["liveactivity"], () => factory, async (controller) => {
      await controller.liveCards.begin("m0", "a", "lantern");
      await controller.liveCards.confirm("m0");
    });
    await waitFor(() => expect(started[0].ended).toEqual(["immediate"]));
    await waitFor(() => expect(lastOf("live_activity")).toEqual({ op: "live_activity" }));
  });

  it("stays while the chat is still working, or waiting on you, and clears once it has stopped and you are looking at it", async () => {
    for (const status of ["working", "needs_you"] as const) {
      const { started, factory } = fakeCards();
      const { lastOf, controller } = await chatScreen(
        ["liveactivity"],
        () => factory,
        async (c) => {
          await c.liveCards.begin("m0", "a", "lantern");
          await c.liveCards.confirm("m0");
        },
        {},
        { status },
      );
      // Opened while it works: the card is still there, and the Mac was told of it (when the message was taken), not told to forget it.
      await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
      expect(started[0].ended).toEqual([]);
      expect(lastOf("live_activity")).toMatchObject({ op: "live_activity", card: { slot: "a" } });
      // It finishes with the chat open: the card goes.
      await act(async () => controller.sync.onPushed({ type: "chats", chats: [chat({ status: "idle" })] }));
      await waitFor(() => expect(started[0].ended).toEqual(["immediate"]));
      await waitFor(() => expect(lastOf("live_activity")).toEqual({ op: "live_activity" }));
    }
  });

  it("is left alone by opening a different chat", async () => {
    const { started, factory } = fakeCards();
    await chatScreen(["liveactivity"], () => factory, async (controller) => {
      await controller.liveCards.begin("m0", "other", "elsewhere");
    });
    expect(started[0].ended).toEqual([]);
  });
});
