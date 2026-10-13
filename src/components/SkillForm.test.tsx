import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const skillCreate = vi.fn();
vi.mock("../api", () => ({ api: { skillCreate: (...a: unknown[]) => skillCreate(...a) } }));

import { NewSkillForm, SKILL_NAME } from "./SkillForm";

const NAME = "daily-notes";
const LINE = "Keeps my meeting notes tidy";

function fill(name: string, line: string) {
  fireEvent.change(screen.getByPlaceholderText("daily-notes"), { target: { value: name } });
  fireEvent.change(screen.getByPlaceholderText(LINE), { target: { value: line } });
}

describe("NewSkillForm", () => {
  beforeEach(() => skillCreate.mockReset());

  it("takes lowercase letters, digits and single dashes only", () => {
    for (const ok of ["a", "daily-notes", "v2-tools"]) expect(SKILL_NAME.test(ok)).toBe(true);
    for (const bad of ["Daily", "a--b", "-a", "a-", "a_b", "a b", ""]) expect(SKILL_NAME.test(bad)).toBe(false);
  });

  it("refuses a bad name or an empty line without writing anything, and says what a name is", () => {
    render(<NewSkillForm slot="s1" kind="skill" onCreated={vi.fn()} onCancel={() => {}} />);
    fill("Daily Notes", LINE);
    fireEvent.click(screen.getByRole("button", { name: "Make skill" }));
    expect(screen.getByRole("alert")).toHaveTextContent("lowercase letters, digits and dashes, like daily-notes");
    fill(NAME, "   ");
    fireEvent.click(screen.getByRole("button", { name: "Make skill" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Say what the skill is for, in a line.");
    expect(skillCreate).not.toHaveBeenCalled();
  });

  it("makes a personal command and hands back its file", async () => {
    skillCreate.mockResolvedValueOnce("/h/.claude/commands/ship.md");
    const onCreated = vi.fn();
    render(<NewSkillForm slot="s1" kind="command" onCreated={onCreated} onCancel={() => {}} />);
    fill("ship", "Ships the build");
    fireEvent.click(screen.getByRole("button", { name: "Make command" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("/h/.claude/commands/ship.md"));
    expect(skillCreate).toHaveBeenCalledWith("s1", "command", "user", "ship", "Ships the build");
  });

  it("offers the project only when a folder is open, and shows the reason when the app refuses", async () => {
    skillCreate.mockRejectedValueOnce("There's already a skill called notes there.");
    render(<NewSkillForm slot={null} kind="skill" onCreated={vi.fn()} onCancel={() => {}} />);
    expect(screen.getByRole("radio", { name: /Everyone on this project/ })).toBeDisabled();
    fill("notes", "Notes");
    fireEvent.click(screen.getByRole("button", { name: "Make skill" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("There's already a skill called notes there.");
  });

  it("goes back without writing when cancelled", () => {
    const onCancel = vi.fn();
    render(<NewSkillForm slot="s1" kind="skill" onCreated={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    expect(skillCreate).not.toHaveBeenCalled();
  });
});
