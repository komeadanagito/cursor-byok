//! Maps the workspace-search extension status to the plugin-entry presentation.
import type { WorkspaceExtensionStatus } from "../../shared/api";

export type WorkspaceExtensionEntry =
  | { kind: "none" }
  | { kind: "missing" }
  | { kind: "outdated"; installed: string | null; expected: string }
  | { kind: "current"; version: string };

/** Plugin entry state; nothing renders until the first status fetch resolves. */
export function workspaceExtensionEntry(
  status: Pick<WorkspaceExtensionStatus, "state" | "installed_version" | "expected_version"> | null,
): WorkspaceExtensionEntry {
  if (!status) return { kind: "none" };
  switch (status.state) {
    case "missing":
      return { kind: "missing" };
    case "outdated":
      return {
        kind: "outdated",
        installed: status.installed_version,
        expected: status.expected_version,
      };
    case "current":
      return { kind: "current", version: status.installed_version ?? status.expected_version };
    default:
      return { kind: "none" };
  }
}

/** The plugin menu shows an indicator dot while the extension can be installed or updated. */
export function workspaceExtensionNeedsAttention(
  status: Pick<WorkspaceExtensionStatus, "state" | "installed_version" | "expected_version"> | null,
): boolean {
  const entry = workspaceExtensionEntry(status);
  return entry.kind === "missing" || entry.kind === "outdated";
}
