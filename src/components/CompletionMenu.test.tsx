import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CompletionMenu } from "./CompletionMenu";
import type { MenuCommand } from "../lib/complete";

const skill: MenuCommand = { name: "grill-me", description: "Interview the user", argument_hint: "", kind: "skill", source: "Yours" };
const command: MenuCommand = { name: "context", description: "Show context", argument_hint: "", kind: "command", source: "Built-in" };

const props = { kind: "/" as const, files: [], pick: 0, onPickCommand: () => {}, onPickFile: () => {}, onHover: () => {} };

describe("the / menu", () => {
  it("names each section above its rows", () => {
    render(<CompletionMenu {...props} sections={[{ kind: "skill", items: [skill] }, { kind: "command", items: [command] }]} />);
    expect(screen.getByText("Skills")).toBeInTheDocument();
    expect(screen.getByText("Commands")).toBeInTheDocument();
  });

  it("leaves out a heading with no rows under it", () => {
    render(<CompletionMenu {...props} sections={[{ kind: "skill", items: [skill] }, { kind: "command", items: [] }]} />);
    expect(screen.queryByText("Commands")).toBeNull();
    // With only one section left, its heading isn't needed either.
    expect(screen.queryByText("Skills")).toBeNull();
    expect(screen.getByText("/grill-me")).toBeInTheDocument();
  });
});
