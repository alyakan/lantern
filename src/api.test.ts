import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";
import type { McpServerSpec, RuleEntry, Settings, TextQuery } from "./types";
import libRs from "../src-tauri/src/lib.rs?raw";
import mockSource from "./dev/mockBackend.ts?raw";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);
beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined as never);
});

// Each wrapper, the command it calls and the arguments Tauri gets: keys are camelCase, Rust's are snake_case.
const settings = {} as Settings;
const spec = {} as McpServerSpec;
const query = {} as TextQuery;
const folderRule: RuleEntry = { scope: "folder", folder: "/repo", tool: "Bash", kind: "prefix", text: "npm test" };

const wrappers: [string, () => unknown, unknown[]][] = [
  ["locateClaude", () => api.locateClaude(null), ["locate_claude", { pathOverride: null }]],
  ["startSession", () => api.startSession("s1", "/bin/claude", "/repo", settings), ["start_session", { slot: "s1", claudePath: "/bin/claude", folder: "/repo", settings }]],
  [
    "applyHarness",
    () => api.applyHarness("s1", { model: "opus", effort: "high", advisor: null, subagent_model: "haiku" }),
    ["apply_harness", { slot: "s1", model: "opus", effort: "high", advisor: null, subagentModel: "haiku" }],
  ],
  ["closeSession", () => api.closeSession("s1"), ["close_session", { slot: "s1" }]],
  ["setModel", () => api.setModel("s1", null), ["set_model", { slot: "s1", model: null }]],
  ["sendMessage", () => api.sendMessage("s1", "hi"), ["send_message", { slot: "s1", text: "hi" }]],
  ["runShell", () => api.runShell("s1", "r1", "ls"), ["run_shell", { slot: "s1", id: "r1", command: "ls" }]],
  ["claudeRequest", () => api.claudeRequest("s1", { subtype: "mcp_status" }), ["claude_request", { slot: "s1", request: { subtype: "mcp_status" } }]],
  ["skillIndex", () => api.skillIndex(null), ["skill_index", { slot: null }]],
  ["readSkill", () => api.readSkill(null, "/skills/a/SKILL.md"), ["read_skill", { slot: null, path: "/skills/a/SKILL.md" }]],
  [
    "skillCreate",
    () => api.skillCreate("s1", "command", "project", "ship", "Ship it"),
    ["skill_create", { slot: "s1", kind: "command", scope: "project", name: "ship", description: "Ship it" }],
  ],
  ["skillDelete", () => api.skillDelete("s1", "/skills/a/SKILL.md"), ["skill_delete", { slot: "s1", path: "/skills/a/SKILL.md" }]],
  ["skillSave", () => api.skillSave("s1", "/skills/a/SKILL.md", "new", "old"), ["skill_save", { slot: "s1", path: "/skills/a/SKILL.md", text: "new", expected: "old" }]],
  ["mcpAdd", () => api.mcpAdd("s1", spec), ["mcp_add", { slot: "s1", spec }]],
  ["mcpRemove", () => api.mcpRemove("s1", "linear", null), ["mcp_remove", { slot: "s1", name: "linear", scope: null }]],
  ["mcpForm", () => api.mcpForm("s1", "linear", "user"), ["mcp_form", { slot: "s1", name: "linear", scope: "user" }]],
  ["mcpEdit", () => api.mcpEdit("s1", { name: "linear", scope: "user" }, spec), ["mcp_edit", { slot: "s1", fromName: "linear", fromScope: "user", spec }]],
  ["shellInput", () => api.shellInput("s1", "r1", "y\r"), ["shell_input", { slot: "s1", id: "r1", text: "y\r" }]],
  ["stopShell", () => api.stopShell("s1", "r1"), ["stop_shell", { slot: "s1", id: "r1" }]],
  ["interrupt", () => api.interrupt("s1"), ["interrupt", { slot: "s1" }]],
  ["restartSession", () => api.restartSession("s1", "ask", null), ["restart_session", { slot: "s1", mode: "ask", effort: null, autoApprove: null }]],
  [
    "restartSession (auto-approve)",
    () => api.restartSession("s1", "steps", "high", true),
    ["restart_session", { slot: "s1", mode: "steps", effort: "high", autoApprove: true }],
  ],
  [
    "getFileDiff",
    () => api.getFileDiff("s1", "a.ts"),
    ["get_file_diff", { slot: "s1", path: "a.ts", scope: "session", turn: null, toTurn: null, pr: null }],
  ],
  [
    "getFileDiff (a turn range)",
    () => api.getFileDiff("s1", "a.ts", "turn", 2, 4),
    ["get_file_diff", { slot: "s1", path: "a.ts", scope: "turn", turn: 2, toTurn: 4, pr: null }],
  ],
  ["changeSummary", () => api.changeSummary("s1"), ["change_summary", { slot: "s1", scope: "session", turn: null, toTurn: null, pr: null, hints: null }]],
  [
    "changeSummary (a PR)",
    () => api.changeSummary("s1", "pr", null, null, 128, ["a.ts"]),
    ["change_summary", { slot: "s1", scope: "pr", turn: null, toTurn: null, pr: 128, hints: ["a.ts"] }],
  ],
  ["branchReview", () => api.branchReview("s1", ["a.ts"]), ["branch_review", { slot: "s1", hints: ["a.ts"] }]],
  ["respondPermission", () => api.respondPermission("s1", "req-1", true), ["respond_permission", { slot: "s1", requestId: "req-1", allow: true, message: null, updatedInput: null }]],
  [
    "respondPermission (answers)",
    () => api.respondPermission("s1", "req-1", true, null, { answers: { Codes: "503" } }),
    ["respond_permission", { slot: "s1", requestId: "req-1", allow: true, message: null, updatedInput: { answers: { Codes: "503" } } }],
  ],
  [
    "addPermissionRule",
    () => api.addPermissionRule("s1", { scope: "folder", tool: "Bash", kind: "prefix", text: "npm test" }),
    ["add_permission_rule", { slot: "s1", rule: { scope: "folder", tool: "Bash", kind: "prefix", text: "npm test" } }],
  ],
  ["listPermissionRules", () => api.listPermissionRules(null), ["list_permission_rules", { slot: null }]],
  ["removePermissionRule", () => api.removePermissionRule("s1", folderRule), ["remove_permission_rule", { slot: "s1", entry: folderRule }]],
  ["gitBranch", () => api.gitBranch("/repo"), ["git_branch", { folder: "/repo" }]],
  ["userName", () => api.userName(), ["user_name"]],
  ["stopTask", () => api.stopTask("s1", "t1"), ["stop_task", { slot: "s1", taskId: "t1" }]],
  ["listSessions", () => api.listSessions("/repo"), ["list_sessions", { folder: "/repo" }]],
  ["renameSession", () => api.renameSession("sid", "Retries"), ["rename_session", { sessionId: "sid", title: "Retries" }]],
  ["sessionEvents", () => api.sessionEvents("/repo", "sid"), ["session_events", { folder: "/repo", sessionId: "sid" }]],
  [
    "titleSession",
    () => api.titleSession("/bin/claude", "/repo", "sid", "fix it"),
    ["title_session", { claudePath: "/bin/claude", folder: "/repo", sessionId: "sid", prompt: "fix it" }],
  ],
  ["recentFolders", () => api.recentFolders(), ["recent_folders"]],
  [
    "openSession",
    () => api.openSession("s1", "/bin/claude", "/repo", settings, "sid"),
    ["open_session", { slot: "s1", claudePath: "/bin/claude", folder: "/repo", settings, sessionId: "sid" }],
  ],
  ["listDir", () => api.listDir("s1", "/repo/src"), ["list_dir", { slot: "s1", path: "/repo/src" }]],
  ["readFile", () => api.readFile("s1", "a.ts"), ["read_file", { slot: "s1", path: "a.ts" }]],
  ["writeFile", () => api.writeFile("s1", "a.ts", "x", null), ["write_file", { slot: "s1", path: "a.ts", text: "x", expected: null }]],
  [
    "revertFiles",
    () => api.revertFiles("s1", "turn", 2, 4, [{ path: "a.ts", expected: "x" }]),
    ["revert_files", { slot: "s1", scope: "turn", turn: 2, toTurn: 4, files: [{ path: "a.ts", expected: "x" }] }],
  ],
  ["undoRevert", () => api.undoRevert("s1", [{ path: "a.ts", target: null, expected: "x" }]), ["undo_revert", { slot: "s1", files: [{ path: "a.ts", target: null, expected: "x" }] }]],
  ["exportText", () => api.exportText("out.md", "# Doc"), ["export_text", { fileName: "out.md", text: "# Doc" }]],
  ["findFiles", () => api.findFiles("s1", "retry"), ["find_files", { slot: "s1", query: "retry" }]],
  ["searchText", () => api.searchText("s1", query), ["search_text", { slot: "s1", query }]],
  ["resolveFiles", () => api.resolveFiles("s1", ["retry.ts"]), ["resolve_files", { slot: "s1", mentions: ["retry.ts"] }]],
  ["updateStatus", () => api.updateStatus(), ["update_status"]],
  ["restartToUpdate", () => api.restartToUpdate(), ["restart_to_update"]],
  ["updateState", () => api.updateState(), ["update_state"]],
  ["checkForUpdates", () => api.checkForUpdates(), ["check_for_updates"]],
  ["appVersion", () => api.appVersion(), ["app_version"]],
];

describe("api wrappers", () => {
  it.each(wrappers)("%s calls its command with camelCase arguments", async (_name, call, expected) => {
    await call();
    expect(invokeMock).toHaveBeenLastCalledWith(...expected);
  });
});

// The drift guards below read the sources as text, so a command added on one side and not the other fails here.
const frontendFiles = import.meta.glob("./**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const sourceFiles = Object.entries(frontendFiles).filter(([path]) => !/\.test\.tsx?$/.test(path));

/** The command names in `invoke("name")` and `invoke<T>("name")` calls. */
const invokedCommands = (text: string) => [...text.matchAll(/\binvoke(?:<[^;]*?>)?\(\s*"([^"]+)"/g)].map((m) => m[1]);

/** The command names in lib.rs's `generate_handler![...]`, without comments and module paths. */
function registeredCommands(rust: string) {
  const list = /generate_handler!\[([^\]]*)\]/.exec(rust)?.[1];
  if (list === undefined) throw new Error("lib.rs has no generate_handler![...] list");
  return list
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n")
    .split(",")
    .map((entry) => entry.trim().split("::").pop() ?? "")
    .filter(Boolean);
}

/** The labels of the `case "name":` lines in the text from `start` up to `end` (or the end of the file). */
function caseLabels(text: string, start: number, end = text.length) {
  return [...text.slice(start, end).matchAll(/\bcase "([^"]+)":/g)].map((m) => m[1]);
}

const invoked = [...new Set(sourceFiles.flatMap(([, text]) => invokedCommands(text)))];
const registered = registeredCommands(libRs);
// Registered commands no frontend code calls yet. Empty: add a name here only on purpose.
const UNCALLED_ALLOWLIST: string[] = [];

// The mock answers commands in the switch inside mockIPC(...), and claude_request subtypes in mockClaudeRequest.
const mockCommands = caseLabels(mockSource, mockSource.indexOf("mockIPC("));
const requestStart = mockSource.indexOf("function mockClaudeRequest");
const mockSubtypes = caseLabels(mockSource, requestStart, mockSource.indexOf("\n}\n", requestStart));
const usedSubtypes = [...new Set(sourceFiles.flatMap(([, text]) => [...text.matchAll(/subtype: "([a-z_]+)"/g)].map((m) => m[1])))];

describe("frontend, backend and mock stay in step", () => {
  it("the parsers find the lists they read", () => {
    expect(invoked.length).toBeGreaterThan(30);
    expect(registered.length).toBeGreaterThan(30);
    expect(mockCommands.length).toBeGreaterThan(30);
    expect(usedSubtypes.length).toBeGreaterThan(3);
    expect(mockSubtypes.length).toBeGreaterThan(3);
  });

  it("every command the frontend invokes is registered in lib.rs", () => {
    expect(invoked.filter((name) => !registered.includes(name))).toEqual([]);
  });

  it("every registered command is invoked by the frontend or on the allowlist", () => {
    expect(registered.filter((name) => !invoked.includes(name) && !UNCALLED_ALLOWLIST.includes(name))).toEqual([]);
  });

  it("the mock has a case for every command the frontend invokes", () => {
    expect(invoked.filter((name) => !mockCommands.includes(name))).toEqual([]);
  });

  it("the mock has a case for every claude_request subtype the frontend sends", () => {
    expect(usedSubtypes.filter((subtype) => !mockSubtypes.includes(subtype))).toEqual([]);
  });
});
