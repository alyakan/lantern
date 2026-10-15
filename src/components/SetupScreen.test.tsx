import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const openUrl = vi.fn((_url: string) => Promise.resolve());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => openUrl(url) }));

import { INSTALL_URL, SetupScreen } from "./SetupScreen";

describe("SetupScreen", () => {
  it("links to how Claude Code is installed, beside the steps", () => {
    render(<SetupScreen error={null} onCheck={() => {}} />);
    expect(INSTALL_URL).toBe("https://docs.anthropic.com/en/docs/claude-code");
    const link = screen.getByRole("link", { name: "how to install it" });
    expect(link).toHaveAttribute("href", INSTALL_URL);
    fireEvent.click(link);
    expect(openUrl).toHaveBeenCalledWith(INSTALL_URL);
  });

  it("checks again with the path typed, or none", () => {
    const onCheck = vi.fn();
    render(<SetupScreen error="not found" onCheck={onCheck} />);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onCheck).toHaveBeenLastCalledWith(null);
    fireEvent.change(screen.getByPlaceholderText(/claude$/), { target: { value: " /x/claude " } });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onCheck).toHaveBeenLastCalledWith("/x/claude");
  });
});
