import { act, renderHook } from "@testing-library/react-native";
import type { PickedImage } from "../view/attachments";
import { resetKeptAttachments, useAttachments } from "./useAttachments";

const photo = (id: string): PickedImage => ({ id, uri: `file:///${id}.jpg`, data: "AAAA", mediaType: "image/jpeg", width: 10, height: 10 });
let mockNext: PickedImage[] = [];
jest.mock("../platformImages", () => ({ pickImages: jest.fn(async () => ({ images: mockNext })) }));

beforeEach(() => {
  resetKeptAttachments();
  mockNext = [photo("p1")];
});

describe("pictures attached to a chat's message", () => {
  it("are still attached when the chat is left and opened again, and are its own", async () => {
    const first = await renderHook(() => useAttachments("a"));
    await act(async () => first.result.current.add("library"));
    expect(first.result.current.images.map((i) => i.id)).toEqual(["p1"]);
    await act(async () => first.unmount());
    // Another chat has none of them.
    expect((await renderHook(() => useAttachments("b"))).result.current.images).toEqual([]);
    // The chat again: still attached.
    expect((await renderHook(() => useAttachments("a"))).result.current.images.map((i) => i.id)).toEqual(["p1"]);
  });

  it("are forgotten once sent (cleared) or taken off", async () => {
    const box = await renderHook(() => useAttachments("a"));
    mockNext = [photo("p1"), photo("p2")];
    await act(async () => box.result.current.add("library"));
    await act(async () => box.result.current.remove("p1"));
    await act(async () => box.unmount());
    const again = await renderHook(() => useAttachments("a"));
    expect(again.result.current.images.map((i) => i.id)).toEqual(["p2"]);
    await act(async () => again.result.current.clear());
    await act(async () => again.unmount());
    expect((await renderHook(() => useAttachments("a"))).result.current.images).toEqual([]);
  });

  it("are not kept for a box that belongs to no chat (a new chat's sheet)", async () => {
    const sheet = await renderHook(() => useAttachments());
    await act(async () => sheet.result.current.add("library"));
    await act(async () => sheet.unmount());
    expect((await renderHook(() => useAttachments())).result.current.images).toEqual([]);
  });
});
