/**
 * Role and capability model (pure, client-safe).
 *
 * Capabilities are explicit: authorization decisions call can(role, cap) —
 * hidden buttons are presentation, never authorization. Enforcement happens
 * server-side in authz.ts.
 */

export const ROLES = ["admin", "coach", "analyst", "readonly"] as const;
export type Role = (typeof ROLES)[number];

export type Capability =
  | "members.manage" // invitations, role changes
  | "settings.manage" // facility settings, monitoring templates
  | "audit.view"
  | "athletes.view"
  | "agent.ask"
  | "monitoring.configure" // coach templates + athlete overrides
  | "alerts.acknowledge" // ack / resolve / dismiss / note
  | "notes.write"
  | "reports.create"
  | "imports.write"
  | "exports.create"
  | "data.delete";

const CAPS: Record<Role, Capability[]> = {
  admin: [
    "members.manage", "settings.manage", "audit.view", "athletes.view", "agent.ask",
    "monitoring.configure", "alerts.acknowledge", "notes.write", "reports.create",
    "imports.write", "exports.create", "data.delete",
  ],
  coach: [
    "athletes.view", "agent.ask", "monitoring.configure", "alerts.acknowledge", "notes.write", "reports.create",
  ],
  analyst: ["athletes.view", "agent.ask", "reports.create", "exports.create"],
  readonly: ["athletes.view"],
};

export function can(role: Role, cap: Capability): boolean {
  return CAPS[role]?.includes(cap) ?? false;
}

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}
