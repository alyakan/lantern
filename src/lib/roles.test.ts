import { describe, expect, it } from "vitest";
import { agentName, allRoles, BUILTIN_ROLES, BUILTIN_TEMPLATES, briefFor, membersOf, roleId, roleTag, templateMessage, type Role } from "./roles";

const custom: Role = { id: "api-reviewer", label: "API reviewer", description: "Checks the API.", brief: "Check the API: {task}", model: "haiku", isolation: "shared", readOnly: true };

describe("the built-in roles", () => {
  it("are a builder, a reviewer, a QA tester, docs and a security auditor, each with a brief that asks for a fixed report", () => {
    expect(BUILTIN_ROLES.map((r) => r.label)).toEqual(["Builder", "Reviewer", "QA / tester", "Docs", "Security auditor"]);
    for (const r of BUILTIN_ROLES) {
      expect(r.brief).toContain("{task}");
      expect(r.brief.toLowerCase()).toContain("report in exactly this format");
      expect(r.description).toMatch(/\.$/);
      expect(r.model).toBe("sonnet");
    }
  });

  it("let the reviewer and the security auditor read and not edit, in the shared folder, and the others edit in a worktree of their own", () => {
    const by = Object.fromEntries(BUILTIN_ROLES.map((r) => [r.id, r]));
    expect([by.reviewer, by.security].map((r) => [r.readOnly, r.isolation])).toEqual([[true, "shared"], [true, "shared"]]);
    expect([by.builder, by.qa, by.docs].map((r) => [r.readOnly, r.isolation])).toEqual([[false, "worktree"], [false, "worktree"], [false, "worktree"]]);
  });

  it("tell a reader not to edit, and the QA tester not to change the code it tests", () => {
    const by = Object.fromEntries(BUILTIN_ROLES.map((r) => [r.id, r]));
    expect(by.reviewer.brief).toContain("you cannot edit anything");
    expect(by.security.brief).toContain("you cannot edit anything");
    // They can only read, so neither brief sends them to run git or anything else.
    for (const id of ["reviewer", "security"]) {
      expect(by[id].brief).toContain("you cannot run commands");
      expect(by[id].brief).not.toMatch(/git diff|git log|run commands that only read/);
    }
    expect(by.qa.brief).toContain("Don't change the code you are testing");
    expect(by.docs.brief).toContain("documentation files only");
  });
});

describe("briefFor", () => {
  it("puts the task where the brief has a place for it, every time it does, and at the end when it has none", () => {
    expect(briefFor({ brief: "Review {task}. Again: {task}." }, "the form")).toBe("Review the form. Again: the form.");
    expect(briefFor({ brief: "Review carefully." }, "the form")).toBe("Review carefully.\n\nthe form");
  });

  it("takes a task with $ or {task} in it as it is", () => {
    expect(briefFor({ brief: "A {task} B" }, "costs $& and {task}")).toBe("A costs $& and {task} B");
  });
});

describe("agentName", () => {
  it("is the role and the first line of the task, kept short", () => {
    expect(agentName({ label: "Reviewer" }, "login form")).toBe("Reviewer: login form");
    expect(agentName({ label: "Reviewer" }, "  the login form\nand the rest of it")).toBe("Reviewer: the login form");
    expect(agentName({ label: "Reviewer" }, "x".repeat(60))).toBe(`Reviewer: ${"x".repeat(36)}…`);
    expect(agentName({ label: "Reviewer" }, "   ")).toBe("Reviewer");
  });
});

describe("roleId", () => {
  it("makes a lowercase id from the name and never one that is taken", () => {
    expect(roleId("API reviewer", [])).toBe("api-reviewer");
    expect(roleId("  QA / tester!! ", ["qa-tester"])).toBe("qa-tester-2");
    expect(roleId("API reviewer", ["api-reviewer", "api-reviewer-2"])).toBe("api-reviewer-3");
    expect(roleId("???", [])).toBe("role");
    expect(roleId("x".repeat(80), []).length).toBe(36);
  });

  it("is an id the backend takes: lowercase letters, digits and dashes", () => {
    for (const label of ["Ünïcode name", "a b c", "Rôle 2"]) expect(roleId(label, [])).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

describe("roleTag", () => {
  it("is what an agent keeps of its role", () => {
    expect(roleTag(custom)).toEqual({ id: "api-reviewer", label: "API reviewer", read_only: true });
  });
});

describe("team templates", () => {
  it("have the two built-in teams, as lists of the built-in roles", () => {
    expect(BUILTIN_TEMPLATES.map((t) => [t.label, membersOf(t, []).map((r) => r.label)])).toEqual([
      ["Build and review", ["Builder", "Reviewer"]],
      ["Build, review and test", ["Builder", "Reviewer", "QA / tester"]],
    ]);
  });

  it("find the project's own roles, and leave out one that has been deleted", () => {
    const t = { id: "t", label: "Build and audit API", description: "", members: ["builder", "api-reviewer", "gone"] };
    expect(membersOf(t, [custom]).map((r) => r.id)).toEqual(["builder", "api-reviewer"]);
    expect(allRoles([custom])[BUILTIN_ROLES.length]).toBe(custom);
  });

  it("tell the Lead the job, each member with its role id and access, and to start them with spawn_agent", () => {
    const text = templateMessage(BUILTIN_TEMPLATES[1], [], "  add a dark mode toggle ");
    expect(text.startsWith("Start a team for this job: add a dark mode toggle\n\n")).toBe(true);
    expect(text).toContain('The team is "Build, review and test": you, the Lead, and 3 agents:\n- Builder (role "builder", can edit): ');
    expect(text).toContain('- Reviewer (role "reviewer", read only): ');
    expect(text).toContain('- QA / tester (role "qa", can edit): ');
    expect(text).toContain("spawn_agent");
    expect(text).toContain("give its role in `role`");
    expect(text).toContain("once there is a branch or change for them to look at");
  });

  it("name a project's own role by its id, so the Lead can ask for it", () => {
    const text = templateMessage({ id: "t", label: "Build and audit API", description: "", members: ["builder", "api-reviewer"] }, [custom], "x");
    expect(text).toContain('- API reviewer (role "api-reviewer", read only): Checks the API.');
    expect(text).toContain("you, the Lead, and 2 agents");
    expect(templateMessage({ id: "t", label: "Solo", description: "", members: ["builder"] }, [], "x")).toContain("and one agent:");
  });
});
