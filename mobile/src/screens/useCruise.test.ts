import { act, renderHook } from "@testing-library/react-native";
import type { ChatStatus } from "../protocol/generated/ChatStatus";
import type { Suggestion } from "../protocol/generated/Suggestion";
import { useCruise } from "./useCruise";

const step = (id: string, slot = "a"): Suggestion => ({ id, title: `Step ${id}`, why: "w", message: `do ${id}`, target: { kind: "continue", slot } });

/** A Mac whose answers the test settles by hand, one ask at a time. */
function mac() {
  const asks: { slot: string; refresh: boolean; resolve: (items: Suggestion[]) => void; reject: (why: string) => void }[] = [];
  const sync = {
    cruise: jest.fn(
      (slot: string, refresh = false) =>
        new Promise<{ items: Suggestion[]; generated_at: number }>((resolve, reject) => {
          asks.push({ slot, refresh, resolve: (items) => resolve({ items, generated_at: 1 }), reject: (why) => reject(new Error(why)) });
        }),
    ),
  };
  return { sync, asks };
}

type Props = { slot?: string; status?: ChatStatus; turnKey?: string; disabled?: boolean };

async function setup() {
  const m = mac();
  const send = jest.fn();
  const view = await renderHook(({ slot = "a", status = "idle", turnKey = "t1", disabled = false }: Props) => useCruise({ slot, available: true, status, turnKey, disabled, sync: m.sync, send }), { initialProps: {} as Props });
  return { ...m, send, ...view };
}

describe("useCruise", () => {
  it("does nothing until it is turned on, then asks once for the turn that ended, however often it re-renders", async () => {
    const { result, rerender, asks } = await setup();
    expect(asks).toHaveLength(0);
    await act(async () => result.current.toggle());
    expect(asks).toEqual([expect.objectContaining({ slot: "a", refresh: false })]);
    await rerender({});
    await rerender({});
    expect(asks).toHaveLength(1);
    await act(async () => asks[0].resolve([step("1")]));
    expect(result.current.draft?.id).toBe("1");
    expect(asks).toHaveLength(1);
  });

  it("asks again when the next turn ends, and the last turn's draft is gone meanwhile, so it can't be sent", async () => {
    const { result, rerender, asks, send } = await setup();
    await act(async () => result.current.toggle());
    await act(async () => asks[0].resolve([step("1")]));
    expect(result.current.draft?.id).toBe("1");
    await rerender({ status: "working" });
    await rerender({ status: "idle", turnKey: "t2" });
    expect(asks).toHaveLength(2);
    expect(result.current.draft).toBeNull();
    await act(async () => result.current.doIt());
    expect(send).not.toHaveBeenCalled();
    await act(async () => asks[1].resolve([step("2")]));
    expect(result.current.draft?.id).toBe("2");
  });

  it("waits while the chat works or waits on you, and in Step by step", async () => {
    const { result, rerender, asks } = await setup();
    await rerender({ status: "working" });
    await act(async () => result.current.toggle());
    await rerender({ status: "needs_you" });
    await rerender({ status: "idle", disabled: true });
    expect(asks).toHaveLength(0);
    await rerender({ status: "idle", disabled: false });
    expect(asks).toHaveLength(1);
  });

  it("sends the draft that is shown, only when told to, and asks again after the next turn", async () => {
    const { result, rerender, asks, send } = await setup();
    await act(async () => result.current.toggle());
    await act(async () => asks[0].resolve([step("1")]));
    expect(send).not.toHaveBeenCalled();
    await act(async () => result.current.doIt());
    expect(send).toHaveBeenCalledWith("do 1");
    expect(result.current.draft).toBeNull();
    await rerender({ status: "working" });
    await rerender({ status: "idle", turnKey: "t2" });
    expect(asks).toHaveLength(2);
  });

  it("Another goes round the drafts it has, then asks for more, one ask at a time", async () => {
    const { result, asks } = await setup();
    await act(async () => result.current.toggle());
    await act(async () => asks[0].resolve([step("1"), step("2")]));
    await act(async () => result.current.another());
    expect(result.current.draft?.id).toBe("2");
    expect(asks).toHaveLength(1);
    await act(async () => result.current.another());
    expect(asks).toHaveLength(2);
    expect(asks[1].refresh).toBe(true);
    expect(result.current.asking).toBe(true);
    // The draft stays up while it asks, and a second press does nothing.
    expect(result.current.draft?.id).toBe("2");
    await act(async () => result.current.another());
    expect(asks).toHaveLength(2);
    await act(async () => asks[1].resolve([step("3")]));
    expect(result.current.draft?.id).toBe("3");
  });

  it("drops an answer that comes after Stop, and doesn't bring it back when Cruise is turned on again", async () => {
    const { result, asks } = await setup();
    await act(async () => result.current.toggle());
    await act(async () => result.current.stop());
    await act(async () => asks[0].resolve([step("1")]));
    expect(result.current.draft).toBeNull();
    expect(result.current.asking).toBe(false);
    await act(async () => result.current.toggle());
    expect(result.current.draft).toBeNull();
  });

  it("only offers a next step for this chat, whatever the Mac sends", async () => {
    const { result, asks } = await setup();
    await act(async () => result.current.toggle());
    await act(async () => asks[0].resolve([step("x", "b"), { ...step("y"), target: { kind: "new_chat", project: "/p", project_name: "p" } }, step("1")]));
    expect(result.current.draft?.id).toBe("1");
    await act(async () => result.current.another());
    expect(result.current.draft?.id).toBe("1");
  });

  it("starts another chat with Cruise off and none of the first chat's draft, even if its answer is late", async () => {
    const { result, rerender, asks } = await setup();
    await act(async () => result.current.toggle());
    await rerender({ slot: "b", turnKey: "u1" });
    expect(result.current.on).toBe(false);
    await act(async () => asks[0].resolve([step("1")]));
    expect(result.current.draft).toBeNull();
  });

  it("says why when the Mac couldn't, and tries again only at the next turn", async () => {
    const { result, rerender, asks } = await setup();
    await act(async () => result.current.toggle());
    await act(async () => asks[0].reject("Claude didn't answer in time."));
    expect(result.current.error).toBe("Claude didn't answer in time.");
    expect(result.current.asking).toBe(false);
    await rerender({});
    expect(asks).toHaveLength(1);
    await rerender({ status: "working" });
    await rerender({ status: "idle", turnKey: "t2" });
    expect(asks).toHaveLength(2);
  });
});
