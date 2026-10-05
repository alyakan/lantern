import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { ChatItem } from "../store";
import { ChatStream } from "./ChatStream";

const items: ChatItem[] = [
  { type: "user", id: "u1", text: "First question" },
  { type: "assistant", id: "a1", text: "First answer" },
  { type: "user", id: "u2", text: "Second question" },
  { type: "assistant", id: "a2", text: "Second answer" },
];
const handlers = { onDecide: () => {}, onOpenFile: () => {} };

describe("ChatStream", () => {
  it("groups each prompt and its reply into a section headed by a sticky prompt", () => {
    const { container } = render(<ChatStream items={items} folder={null} sections {...handlers} />);
    const sections = container.querySelectorAll("section.turn-section");
    expect(sections).toHaveLength(2);
    expect(sections[0].querySelector(".turn-head .msg.user")?.textContent).toBe("First question");
    expect(sections[0].textContent).toContain("First answer");
    expect(sections[1].querySelector(".turn-head .msg.user")?.textContent).toBe("Second question");
  });

  it("stays flat without sections (e.g. nested subagent streams)", () => {
    const { container } = render(<ChatStream items={items} folder={null} {...handlers} />);
    expect(container.querySelector("section")).toBeNull();
    expect(container.querySelectorAll(".msg.user")).toHaveLength(2);
  });
});
