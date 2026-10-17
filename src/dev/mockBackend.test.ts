import { beforeEach, describe, expect, it } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { installMockBackend } from "./mockBackend";
import { version } from "../../package.json";

// Each test installs the mock again, since mockIPC is per window and the tests share one.
beforeEach(() => installMockBackend());

describe("mock backend", () => {
  it("answers apply_harness and close_session", async () => {
    await expect(invoke("apply_harness", { slot: "s1", model: null, effort: null, advisor: null, subagentModel: null })).resolves.toBeNull();
    await expect(invoke("close_session", { slot: "s1" })).resolves.toBeNull();
  });

  it("rejects an app command it has no case for", async () => {
    await expect(invoke("no_such_command", {})).rejects.toMatch(/no_such_command isn't in the mock/);
  });

  it("still answers plugin commands, which the mock doesn't model", async () => {
    await expect(invoke("plugin:dialog|ask", {})).resolves.toBeNull();
  });

  it("completes the login when the callback URL is sent after it", async () => {
    await expect(invoke("claude_request", { slot: "s1", request: { subtype: "mcp_oauth_callback_url", callbackUrl: "http://localhost/cb?code=1", serverName: "sentry" } })).resolves.toEqual({});
  });

  it("plays Claude asking for approval, and reports the user's answer and note back as the tool result", async () => {
    const events: { slot: string; event: { kind: string; tool_name?: string; input?: { action?: string; details?: string }; output?: string; is_error?: boolean } }[] = [];
    const off = await listen<(typeof events)[number]>("ui-event", (e) => events.push(e.payload));
    const seen = (kind: string) => new Promise<(typeof events)[number]["event"]>((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const hit = events.find((e) => e.slot === "ap" && e.event.kind === kind);
        if (hit) return resolve(hit.event);
        if (Date.now() - started > 4000) return reject(new Error(`no ${kind}`));
        setTimeout(tick, 20);
      };
      tick();
    });
    await invoke("send_message", { slot: "ap", text: "Merge the PR once you have my approval", mode: "ask" });
    const card = await seen("permission_requested");
    expect(card.tool_name).toBe("Approval");
    expect(card.input?.action).toBe("Merge PR #144 and release 0.1.42");
    await invoke("respond_permission", { slot: "ap", requestId: "approval-ap", allow: false, message: "wait for the release notes", updatedInput: null });
    const result = await seen("tool_finished");
    expect(result.is_error).toBe(false);
    expect(result.output).toBe("The user declined: Merge PR #144 and release 0.1.42. Their note: wait for the release notes");
    off();
  });

  it("reports the running version from package.json", async () => {
    await expect(invoke("app_version")).resolves.toBe(version);
  });
});
