import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LinearWork } from "../types";
import { LinearSettings } from "./LinearSettings";

const work: LinearWork = { connected: true, viewer: "Aly", org: "Acme", teams: [{ key: "ENG", name: "Engineering" }], issues: [], error: null };

describe("Settings → Linear", () => {
  it("hides Ready issues with a remembered choice", () => {
    const onHideReady = vi.fn();
    render(<LinearSettings folders={[]} teams={{}} onTeams={() => {}} work={work} onWork={() => {}} hideReady={false} onHideReady={onHideReady} />);
    const box = screen.getByRole("checkbox", { name: /Hide Ready issues/ });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(onHideReady).toHaveBeenCalledWith(true);
  });

  it("offers it only once Linear is connected", () => {
    render(<LinearSettings folders={[]} teams={{}} onTeams={() => {}} work={{ ...work, connected: false }} onWork={() => {}} hideReady={false} onHideReady={() => {}} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
