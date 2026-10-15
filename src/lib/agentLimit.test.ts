import { beforeEach, describe, expect, it, vi } from "vitest";

const setAgentLimitApi = vi.fn((_n: number) => Promise.resolve());
vi.mock("../api", () => ({ api: { setAgentLimit: (n: number) => setAgentLimitApi(n) } }));

import { AGENT_LIMIT_DEFAULT, agentLimit, pushAgentLimit, setAgentLimit } from "./agentLimit";

describe("the limit on agents running at once", () => {
  beforeEach(() => {
    localStorage.clear();
    setAgentLimitApi.mockClear();
  });

  it("is 3 until the user sets it, and only 1 to 6 are kept", () => {
    expect(agentLimit()).toBe(AGENT_LIMIT_DEFAULT);
    localStorage.setItem("lantern.agentLimit", "9");
    expect(agentLimit()).toBe(3);
    localStorage.setItem("lantern.agentLimit", "nonsense");
    expect(agentLimit()).toBe(3);
  });

  it("is saved, and the backend told, when it changes and when the window starts", async () => {
    setAgentLimit(5);
    expect(agentLimit()).toBe(5);
    expect(setAgentLimitApi).toHaveBeenLastCalledWith(5);
    await pushAgentLimit();
    expect(setAgentLimitApi).toHaveBeenCalledTimes(2);
    expect(setAgentLimitApi).toHaveBeenLastCalledWith(5);
  });
});
