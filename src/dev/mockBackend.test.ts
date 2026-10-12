import { beforeEach, describe, expect, it } from "vitest";
import { invoke } from "@tauri-apps/api/core";
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

  it("reports the running version from package.json", async () => {
    await expect(invoke("app_version")).resolves.toBe(version);
  });
});
