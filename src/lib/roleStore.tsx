import { createContext, useContext, useMemo, type ReactNode } from "react";
import { usePersistentState } from "./layout";
import { BUILTIN_ROLES, BUILTIN_TEMPLATES, type Role, type TeamTemplate } from "./roles";

/** The project's own roles and team templates (kept per project folder), and what the user does to them. */
export interface RoleStore {
  /** The project's own roles; the built-in ones are in roles.ts. */
  roles(folder: string | null): Role[];
  /** Adds a role, or replaces the one with the same id. */
  saveRole(folder: string, role: Role): void;
  deleteRole(folder: string, id: string): void;
  /** The built-in templates, then the project's own. */
  templates(folder: string | null): TeamTemplate[];
  saveTemplate(folder: string, template: TeamTemplate): void;
  deleteTemplate(folder: string, id: string): void;
  /** A folder moved: what its migration wrote (see relocate.ts), taken into the state kept here, which would otherwise be written back as it was. */
  carry(changed: Record<string, unknown>): void;
}

const NONE: Role[] = [];

/** What a place with no store (a test, the canvas before the app has one) gets: the built-in templates and no own roles, and nothing is kept. */
export const NO_STORE: RoleStore = {
  roles: () => NONE,
  saveRole: () => {},
  deleteRole: () => {},
  templates: () => BUILTIN_TEMPLATES,
  saveTemplate: () => {},
  deleteTemplate: () => {},
  carry: () => {},
};

export const RoleStoreContext = createContext<RoleStore>(NO_STORE);

/** Opens "Team from a template" (the Workflow menu offers it when there is one). Null: there is nowhere to start one. */
export const TemplateTeamContext = createContext<(() => void) | null>(null);

export const useRoleStore = () => useContext(RoleStoreContext);

const withOne = <T extends { id: string }>(list: T[], item: T): T[] => (list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item]);

/** The store the app provides: roles and templates in localStorage, each keyed by the project's folder (see relocate.ts). */
export function useRoleStoreState(): RoleStore {
  const [rolesBy, setRolesBy] = usePersistentState<Record<string, Role[]>>("settings.rolesByFolder", {});
  const [templatesBy, setTemplatesBy] = usePersistentState<Record<string, TeamTemplate[]>>("settings.teamTemplatesByFolder", {});
  return useMemo<RoleStore>(
    () => ({
      roles: (folder) => (folder && rolesBy[folder]) || NONE,
      saveRole: (folder, role) => setRolesBy({ ...rolesBy, [folder]: withOne(rolesBy[folder] ?? [], role) }),
      deleteRole: (folder, id) => setRolesBy({ ...rolesBy, [folder]: (rolesBy[folder] ?? []).filter((r) => r.id !== id) }),
      templates: (folder) => [...BUILTIN_TEMPLATES, ...((folder && templatesBy[folder]) || [])],
      saveTemplate: (folder, template) => setTemplatesBy({ ...templatesBy, [folder]: withOne(templatesBy[folder] ?? [], template) }),
      deleteTemplate: (folder, id) => setTemplatesBy({ ...templatesBy, [folder]: (templatesBy[folder] ?? []).filter((t) => t.id !== id) }),
      carry: (changed) => {
        if (changed["settings.rolesByFolder"]) setRolesBy(changed["settings.rolesByFolder"] as Record<string, Role[]>);
        if (changed["settings.teamTemplatesByFolder"]) setTemplatesBy(changed["settings.teamTemplatesByFolder"] as Record<string, TeamTemplate[]>);
      },
    }),
    [rolesBy, templatesBy],
  );
}

export function RoleStoreProvider({ store, children }: { store: RoleStore; children: ReactNode }) {
  return <RoleStoreContext.Provider value={store}>{children}</RoleStoreContext.Provider>;
}

/** The ids a custom role must not take: every built-in one. */
export const BUILTIN_IDS = BUILTIN_ROLES.map((r) => r.id);
