import builtin from "./roles.json";

/**
 * A role: what an agent is told to do (a brief with `{task}` where its task goes), the model it runs on, where it works and
 * whether it may edit. The built-in ones are in roles.json, which the backend reads too (it starts an agent a Lead asks for
 * by role); the user's own are per project (see roleStore.tsx).
 */
export interface Role {
  id: string;
  label: string;
  description: string;
  brief: string;
  model: string;
  isolation: "worktree" | "shared";
  /** It can only read: it has no editing tools and no shell. */
  readOnly: boolean;
}

/** What an agent keeps of its role: shown on its card and in the sidebar, and its access is kept when it comes back. */
export interface AgentRole {
  id: string;
  label: string;
  read_only: boolean;
}

export const BUILTIN_ROLES: Role[] = builtin as Role[];
export const TASK_MARK = "{task}";

/** A team a Lead starts with: the roles its members are in (the Lead is always there). */
export interface TeamTemplate {
  id: string;
  label: string;
  description: string;
  /** Role ids, built-in or the project's own. */
  members: string[];
}

export const BUILTIN_TEMPLATES: TeamTemplate[] = [
  { id: "build-review", label: "Build and review", description: "A Lead, a Builder and a Reviewer.", members: ["builder", "reviewer"] },
  { id: "build-review-test", label: "Build, review and test", description: "A Lead, a Builder, a Reviewer and a QA tester.", members: ["builder", "reviewer", "qa"] },
];

export const roleTag = (r: Role): AgentRole => ({ id: r.id, label: r.label, read_only: r.readOnly });

export const accessLabel = (readOnly: boolean) => (readOnly ? "Read only" : "Can edit");

/** The brief with `task` in its place (at the end when the brief has no place for it); the same as the backend's. */
export function briefFor(role: Pick<Role, "brief">, task: string): string {
  return role.brief.includes(TASK_MARK) ? role.brief.split(TASK_MARK).join(task) : `${role.brief}\n\n${task}`;
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max).trimEnd()}…`);

/** "Reviewer: login form": the role's name and what the task is, until the user names the agent. */
export function agentName(role: Pick<Role, "label">, task: string): string {
  const what = clip(task.trim().split("\n")[0].trim(), 36);
  return what ? `${role.label}: ${what}` : role.label;
}

/** An id for a role of the user's own from its name: lowercase words with dashes, never one in `taken`. */
export function roleId(label: string, taken: string[]): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "role";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

/** Every role there is for a project: the built-in ones, then its own. */
export const allRoles = (custom: Role[]): Role[] => [...BUILTIN_ROLES, ...custom];

/** The team's members as roles: one the project no longer has (a deleted role) is left out. */
export function membersOf(template: TeamTemplate, custom: Role[]): Role[] {
  const all = allRoles(custom);
  return template.members.flatMap((id) => all.find((r) => r.id === id) ?? []);
}

/**
 * What a Lead is told when a team starts from a template: the job, each member and its role, and to start them with its
 * usual tool and the role's id. The roles bring their own briefs, so the Lead's brief for each only says what to work on.
 */
export function templateMessage(template: TeamTemplate, custom: Role[], task: string): string {
  const members = membersOf(template, custom);
  const lines = members.map((r) => `- ${r.label} (role "${r.id}", ${accessLabel(r.readOnly).toLowerCase()}): ${r.description}`);
  return [
    `Start a team for this job: ${task.trim()}`,
    [`The team is "${template.label}": you, the Lead, and ${members.length === 1 ? "one agent" : `${members.length} agents`}:`, ...lines].join("\n"),
    `Start each member with spawn_agent and give its role in \`role\`: the role brings the agent's instructions, model, place and access, so each brief only says what that agent should work on. Give each a short name that says its role and the work, such as "Reviewer: login form". Start the members that build now. Start the ones that check the work (review, test, audit) once there is a branch or change for them to look at, and name it in their brief. When each reports back, tell me what it found in plain words.`,
  ].join("\n\n");
}
