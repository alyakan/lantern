import { beforeEach, describe, expect, it } from "vitest";
import { launchOf, migrateModeSettings, permissionsOf, PERMISSIONS_KEY, savedModeOf, settingLine, STEPS_AUTO, workflowOf, WORKFLOW_KEY } from "./workflow";

describe("Permissions and Workflow", () => {
  it("read Permissions the same in every workflow: Auto is the Auto mode, or Step by step with auto-approve", () => {
    expect(permissionsOf({ mode: "ask", autoApprove: false })).toBe("ask");
    expect(permissionsOf({ mode: "auto", autoApprove: false })).toBe("auto");
    expect(permissionsOf({ mode: "steps", autoApprove: false })).toBe("ask");
    expect(permissionsOf({ mode: "steps", autoApprove: true })).toBe("auto");
    // Auto-approve means something only in Step by step.
    expect(permissionsOf({ mode: "ask", autoApprove: true })).toBe("ask");
  });

  it("read Workflow from the mode and whether the chat leads a team", () => {
    expect(workflowOf({ mode: "ask", orchestrator: false })).toBe("chat");
    expect(workflowOf({ mode: "auto", orchestrator: false })).toBe("chat");
    expect(workflowOf({ mode: "steps", orchestrator: false })).toBe("steps");
    expect(workflowOf({ mode: "ask", orchestrator: true })).toBe("team");
    expect(workflowOf({ mode: "auto", orchestrator: true })).toBe("team");
  });

  it("turn into a launch mode: Permissions are the mode in Chat and Team, and auto-approve in Step by step", () => {
    expect(launchOf("ask", "chat")).toEqual({ mode: "ask", autoApprove: false, team: false });
    expect(launchOf("auto", "chat")).toEqual({ mode: "auto", autoApprove: false, team: false });
    expect(launchOf("ask", "steps")).toEqual({ mode: "steps", autoApprove: false, team: false });
    expect(launchOf("auto", "steps")).toEqual({ mode: "steps", autoApprove: true, team: false });
    expect(launchOf("ask", "team")).toEqual({ mode: "ask", autoApprove: false, team: true });
    expect(launchOf("auto", "team")).toEqual({ mode: "auto", autoApprove: false, team: true });
  });

  it("round-trip: what launchOf makes reads back as the same two settings", () => {
    for (const permissions of ["ask", "auto"] as const) {
      for (const workflow of ["chat", "steps", "team"] as const) {
        const { mode, autoApprove, team } = launchOf(permissions, workflow);
        expect([permissionsOf({ mode, autoApprove }), workflowOf({ mode, orchestrator: team })]).toEqual([permissions, workflow]);
      }
    }
  });

  it("say both settings in a line, and keep Step by step's Permissions with the session's mode", () => {
    expect(settingLine({ mode: "steps", autoApprove: true, orchestrator: false })).toBe("Auto · Step by step");
    expect(settingLine({ mode: "ask", autoApprove: false, orchestrator: true })).toBe("Ask · Team");
    expect(savedModeOf({ mode: "steps", autoApprove: true })).toBe(STEPS_AUTO);
    expect(savedModeOf({ mode: "steps", autoApprove: false })).toBe("steps");
    expect(savedModeOf({ mode: "auto", autoApprove: false })).toBe("auto");
  });
});

describe("migrateModeSettings", () => {
  beforeEach(() => localStorage.clear());
  const put = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));
  const get = (key: string) => JSON.parse(localStorage.getItem(key) ?? "null");

  it("turns a project in Step by step with auto-approve on into Workflow Step by step with Permissions Auto", () => {
    put("settings.modeByFolder", { "/a": "steps", "/b": "steps", "/c": "auto", "/d": "ask" });
    put("settings.autoApproveByFolder", { "/a": true, "/b": false, "/d": true });
    migrateModeSettings(localStorage);
    expect(get(PERMISSIONS_KEY)).toEqual({ "/a": "auto", "/b": "ask", "/c": "auto", "/d": "ask" });
    expect(get(WORKFLOW_KEY)).toEqual({ "/a": "steps", "/b": "steps", "/c": "chat", "/d": "chat" });
  });

  it("removes the old keys, including the team's own per-project mode", () => {
    put("settings.modeByFolder", { "/a": "ask" });
    put("settings.autoApproveByFolder", { "/a": true });
    put("settings.orchestraModeByFolder", { "/a": "auto" });
    migrateModeSettings(localStorage);
    for (const key of ["settings.modeByFolder", "settings.autoApproveByFolder", "settings.orchestraModeByFolder"]) expect(localStorage.getItem(key)).toBeNull();
  });

  it("takes a team's Auto for a project that never had a chat of its own, but the chat's own choice wins", () => {
    put("settings.modeByFolder", { "/chat": "ask" });
    put("settings.orchestraModeByFolder", { "/chat": "auto", "/team-only": "auto", "/team-ask": "ask" });
    migrateModeSettings(localStorage);
    expect(get(PERMISSIONS_KEY)).toEqual({ "/chat": "ask", "/team-only": "auto", "/team-ask": "ask" });
    // Only the projects that had a mode have a workflow.
    expect(get(WORKFLOW_KEY)).toEqual({ "/chat": "chat" });
  });

  it("reads the modes that are gone as what they became: Debug, Teach and Review were Step by step", () => {
    put("settings.modeByFolder", { "/debug": "debug", "/teach": "teach", "/plan": "plan" });
    put("settings.autoApproveByFolder", { "/debug": true });
    migrateModeSettings(localStorage);
    expect(get(WORKFLOW_KEY)).toEqual({ "/debug": "steps", "/teach": "steps", "/plan": "chat" });
    expect(get(PERMISSIONS_KEY)).toEqual({ "/debug": "auto", "/teach": "ask", "/plan": "ask" });
  });

  it("keeps what a project already has under the new keys, and is safe to run again", () => {
    put(PERMISSIONS_KEY, { "/a": "ask" });
    put("settings.modeByFolder", { "/a": "auto", "/b": "auto" });
    migrateModeSettings(localStorage);
    expect(get(PERMISSIONS_KEY)).toEqual({ "/a": "ask", "/b": "auto" });
    const once = [localStorage.getItem(PERMISSIONS_KEY), localStorage.getItem(WORKFLOW_KEY)];
    migrateModeSettings(localStorage);
    expect([localStorage.getItem(PERMISSIONS_KEY), localStorage.getItem(WORKFLOW_KEY)]).toEqual(once);
  });

  it("writes nothing when there is nothing old, and drops an old value that does not read", () => {
    migrateModeSettings(localStorage);
    expect(localStorage.getItem(PERMISSIONS_KEY)).toBeNull();
    expect(localStorage.getItem(WORKFLOW_KEY)).toBeNull();
    localStorage.setItem("settings.modeByFolder", "{not json");
    migrateModeSettings(localStorage);
    expect(localStorage.getItem(PERMISSIONS_KEY)).toBeNull();
  });
});
