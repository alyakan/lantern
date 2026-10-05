import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent, fireEvent, render, screen } from "@testing-library/react";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (...args: unknown[]) => openUrl(...args) }));

import { ExternalLink } from "./ExternalLink";

describe("ExternalLink", () => {
  beforeEach(() => openUrl.mockReset().mockResolvedValue(undefined));

  it("opens https links via the opener and prevents navigation", () => {
    render(<ExternalLink href="https://example.com/x">docs</ExternalLink>);
    const link = screen.getByText("docs");
    const event = createEvent.click(link);
    fireEvent(link, event);
    expect(event.defaultPrevented).toBe(true);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/x");
  });

  it("does not open javascript: links", () => {
    render(<ExternalLink href="javascript:alert(1)">bad</ExternalLink>);
    const link = screen.getByText("bad");
    const event = createEvent.click(link);
    fireEvent(link, event);
    expect(event.defaultPrevented).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
  });
});
