import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoleStoreProvider, useRoleStoreState } from "../lib/roleStore";
import { TeamTemplateDialog } from "./TeamTemplateDialog";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function Roles({ children }: { children: React.ReactNode }) {
  return <RoleStoreProvider store={useRoleStoreState()}>{children}</RoleStoreProvider>;
}

function mount() {
  const h = { onStart: vi.fn(), onClose: vi.fn() };
  render(
    <Roles>
      <TeamTemplateDialog folder="/p/acme" {...h} />
    </Roles>,
  );
  return h;
}
const dialog = () => screen.getByRole("dialog", { name: "Team from a template" });
const task = () => within(dialog()).getByLabelText("What the team should do") as HTMLTextAreaElement;
const type = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } });

describe("Team from a template", () => {
  it("lists the two built-in teams with their members, the first chosen, and opens on the task", () => {
    mount();
    const radios = within(dialog()).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.closest("label")?.textContent)).toEqual([
      "Build and reviewBuilder and Reviewer (read only)",
      "Build, review and testBuilder, Reviewer (read only) and QA / tester",
    ]);
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    expect(document.activeElement).toBe(task());
  });

  it("starts the chosen template with the task", () => {
    const h = mount();
    fireEvent.click(within(dialog()).getByRole("radio", { name: /Build, review and test/ }));
    type(task(), "  add a dark mode toggle ");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Start team" }));
    expect(h.onStart).toHaveBeenCalledWith(expect.objectContaining({ id: "build-review-test", members: ["builder", "reviewer", "qa"] }), "add a dark mode toggle");
  });

  it("starts on Command-Enter in the task, too", () => {
    const h = mount();
    type(task(), "x");
    fireEvent.keyDown(task(), { key: "Enter", metaKey: true });
    expect(h.onStart).toHaveBeenCalledTimes(1);
  });

  it("asks for a task and starts nothing without one", () => {
    const h = mount();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Start team" }));
    expect(within(dialog()).getByRole("alert").textContent).toBe("Say what the team should do.");
    expect(task().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(task());
    expect(h.onStart).not.toHaveBeenCalled();
  });

  it("closes on Cancel and on Escape", () => {
    const h = mount();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    fireEvent(dialog(), new Event("cancel", { cancelable: true }));
    expect(h.onClose).toHaveBeenCalledTimes(2);
  });

  it("saves a template of the project's own, chosen from the roles there are, and starts it", () => {
    const h = mount();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Make a template of your own…" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save template" }));
    expect(within(dialog()).getByRole("alert").textContent).toBe("Give the template a name.");
    type(within(dialog()).getByLabelText("Template name"), "Build and audit");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save template" }));
    expect(within(dialog()).getByRole("alert").textContent).toBe("Tick at least one role.");
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: /Builder/ }));
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: /Security auditor/ }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save template" }));
    expect(JSON.parse(localStorage.getItem("settings.teamTemplatesByFolder")!)).toEqual({
      "/p/acme": [{ id: "build-and-audit", label: "Build and audit", description: "A Lead and Builder and Security auditor.", members: ["builder", "security"] }],
    });
    // It is the chosen one now, and the creator is closed.
    expect((within(dialog()).getByRole("radio", { name: /Build and audit/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(dialog()).queryByLabelText("Template name")).toBeNull();
    type(task(), "audit the API");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Start team" }));
    expect(h.onStart).toHaveBeenCalledWith(expect.objectContaining({ id: "build-and-audit", members: ["builder", "security"] }), "audit the API");
  });

  it("offers the project's own roles to a template, and says nothing of another project's", () => {
    localStorage.setItem("settings.rolesByFolder", JSON.stringify({ "/p/acme": [{ id: "api-reviewer", label: "API reviewer", description: "", brief: "{task}", model: "sonnet", isolation: "shared", readOnly: true }], "/p/other": [{ id: "x", label: "Elsewhere", description: "", brief: "{task}", model: "sonnet", isolation: "shared", readOnly: true }] }));
    mount();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Make a template of your own…" }));
    const boxes = within(dialog()).getAllByRole("checkbox").map((c) => c.closest("label")?.textContent);
    expect(boxes).toContain("API reviewer Read only");
    expect(boxes.join()).not.toContain("Elsewhere");
  });

  it("deletes a template of its own, and the built-in ones have no delete", () => {
    localStorage.setItem("settings.teamTemplatesByFolder", JSON.stringify({ "/p/acme": [{ id: "mine", label: "Mine", description: "", members: ["builder", "gone"] }] }));
    mount();
    expect(within(dialog()).getAllByRole("button", { name: /^Delete the template/ })).toHaveLength(1);
    // A role the project no longer has is left out of what it says.
    expect(within(dialog()).getByRole("radio", { name: /Mine/ }).closest("label")?.textContent).toBe("MineBuilder");
    fireEvent.click(within(dialog()).getByRole("radio", { name: /Mine/ }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Delete the template Mine" }));
    expect(within(dialog()).queryByRole("radio", { name: /Mine/ })).toBeNull();
    expect((within(dialog()).getAllByRole("radio")[0] as HTMLInputElement).checked).toBe(true);
    expect(JSON.parse(localStorage.getItem("settings.teamTemplatesByFolder")!)["/p/acme"]).toEqual([]);
  });
});
