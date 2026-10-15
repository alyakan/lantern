import { planLevel, planLine, usePlanUsage } from "../lib/planUsage";

/** How full the plan's five-hour window is, once claude has said: amber from 80%, red from 95% (no new workers then). */
export function PlanMeter() {
  const plan = usePlanUsage();
  if (!plan) return null;
  const level = planLevel(plan);
  const title = level === "stop" ? "Nearly used up: no new workers start until it resets." : level === "warn" ? "Getting close to the plan's five-hour limit." : "The plan's five-hour window, for every chat and team.";
  return (
    <span className={`plan-meter ${level}`} role="status" title={title}>
      {planLine(plan)}
    </span>
  );
}
