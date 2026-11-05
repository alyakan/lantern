import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { onFileDrop, type FileDrop } from "../lib/drop";
import { MessageInput } from "./MessageInput";

vi.mock("../api", () => ({ api: {} }));
vi.mock("../lib/drop", async (actual) => ({ ...(await actual<typeof import("../lib/drop")>()), onFileDrop: vi.fn(() => () => {}) }));

/** What the box listens with: the window's drops, as Tauri would hand them over. */
const dropper = (): FileDrop => vi.mocked(onFileDrop).mock.lastCall![0];

const box = (props: Partial<Parameters<typeof MessageInput>[0]> = {}) => <MessageInput status="idle" folder="/repo" onSend={() => {}} onStop={() => {}} {...props} />;
const area = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("files dropped on the window", () => {
  beforeEach(() => vi.mocked(onFileDrop).mockClear());

  it("go into the box as their paths, at the caret, quoted when they have spaces", () => {
    render(box());
    fireEvent.change(area(), { target: { value: "what's in" } });
    act(() => dropper().drop(["/Users/r/Desktop/Screenshot 1.png", "/Users/r/plan.pdf"]));
    expect(area().value).toBe("what's in '/Users/r/Desktop/Screenshot 1.png' /Users/r/plan.pdf ");
  });

  it("mark the box while they're over the window", () => {
    const { container } = render(box());
    act(() => dropper().over(true));
    expect(container.querySelector(".composer-box.dropping")).not.toBeNull();
    act(() => dropper().over(false));
    expect(container.querySelector(".composer-box.dropping")).toBeNull();
  });

  it("are left alone while the box can't be typed in", () => {
    render(box({ status: "starting" }));
    act(() => dropper().drop(["/Users/r/plan.pdf"]));
    expect(area().value).toBe("");
  });
});
