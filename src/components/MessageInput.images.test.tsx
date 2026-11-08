import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shrinkImage, type PastedImage } from "../lib/images";
import { MessageInput } from "./MessageInput";

vi.mock("../api", () => ({ api: {} }));
vi.mock("../lib/images", async (actual) => ({ ...(await actual<typeof import("../lib/images")>()), shrinkImage: vi.fn() }));

const shot: PastedImage = { media_type: "image/png", data: "iVBORw0KGgo=" };
const box = (props: Partial<Parameters<typeof MessageInput>[0]> = {}) => <MessageInput status="idle" folder="/repo" onSend={() => {}} onStop={() => {}} {...props} />;
const area = () => screen.getByRole("textbox") as HTMLTextAreaElement;

/** ⌘V with a screenshot on the clipboard, and the picture made ready to send. */
async function pasteScreenshot() {
  const file = new File(["png"], "image.png", { type: "image/png" });
  await act(async () => {
    fireEvent.paste(area(), { clipboardData: { files: [file], getData: () => "" } });
  });
}

describe("a picture pasted into the box", () => {
  beforeEach(() => vi.mocked(shrinkImage).mockReset().mockResolvedValue(shot));

  it("shows as [Image #1] and goes to Claude with the message", async () => {
    const onSend = vi.fn();
    render(box({ onSend }));
    fireEvent.change(area(), { target: { value: "what's wrong here " } });
    await pasteScreenshot();
    expect(area().value).toBe("what's wrong here [Image #1]");
    fireEvent.keyDown(area(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("what's wrong here [Image #1]", expect.anything(), [shot]);
  });

  it("isn't sent once its token is deleted from the box", async () => {
    const onSend = vi.fn();
    render(box({ onSend }));
    await pasteScreenshot();
    fireEvent.change(area(), { target: { value: "never mind" } });
    fireEvent.keyDown(area(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("never mind", expect.anything());
  });

  it("waits in the box while Claude works, since the queue carries text only", async () => {
    const onSend = vi.fn();
    render(box({ onSend, status: "running" }));
    await pasteScreenshot();
    fireEvent.keyDown(area(), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("Pictures go once Claude is done");
  });

  it("is still there after switching to another chat and back", async () => {
    let text = "";
    let images: Record<number, PastedImage> = {};
    const draft = () => ({ initial: text, save: (t: string) => (text = t), images, saveImages: (i: Record<number, PastedImage>) => (images = i) });
    const { unmount } = render(box({ draft: draft() }));
    fireEvent.change(area(), { target: { value: "look " } });
    await pasteScreenshot();
    unmount();
    // The box is drawn anew for the chat it comes back to.
    const onSend = vi.fn();
    render(box({ onSend, draft: draft() }));
    expect(area().value).toBe("look [Image #1]");
    fireEvent.keyDown(area(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("look [Image #1]", expect.anything(), [shot]);
    expect(images).toEqual({});
  });

  it("is left to the page for a provider that can't take pictures", async () => {
    render(box({ provider: { id: "codex", capabilities: { supports_images: false } } as Parameters<typeof MessageInput>[0]["provider"] }));
    await pasteScreenshot();
    expect(shrinkImage).not.toHaveBeenCalled();
    expect(area().value).toBe("");
  });
});
