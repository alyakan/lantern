import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { planLevel, planLine, setPlanUsage } from "../lib/planUsage";
import { PlanMeter } from "./PlanMeter";

describe("the plan meter", () => {
  it("says how full the five-hour window is and when it resets, and warns from 80% and stops at 95%", () => {
    const resetsAt = new Date(2026, 9, 15, 14, 30).getTime() / 1000;
    const at = new Date(resetsAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(planLine({ used: 0.423, resetsAt })).toBe(`Plan usage: 42% · resets ${at}`);
    expect(planLine({ used: 0.1, resetsAt: null })).toBe("Plan usage: 10%");
    expect([0.79, 0.8, 0.95].map((used) => planLevel({ used, resetsAt: null }))).toEqual(["ok", "warn", "stop"]);
  });

  it("shows nothing until claude has said, then the latest any chat reported", () => {
    const { container } = render(<PlanMeter />);
    expect(container.textContent).toBe("");
    act(() => setPlanUsage({ used: 0.85, resetsAt: null }));
    expect(screen.getByRole("status").textContent).toBe("Plan usage: 85%");
    expect(screen.getByRole("status").className).toContain("warn");
  });
});
