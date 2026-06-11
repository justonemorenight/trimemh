import type { RiskLevel } from "../domain/schema";
import type { UserRole } from "./types";

export const PERMISSIONS: Record<UserRole, string[]> = {
  viewer: ["memory:read", "memory:search"],
  proposer: ["memory:read", "memory:search", "memory:propose"],
  approver: ["memory:read", "memory:search", "memory:propose", "memory:approve", "memory:reject"],
  admin: [
    "memory:read",
    "memory:search",
    "memory:propose",
    "memory:approve",
    "memory:reject",
    "memory:delete",
    "role:manage",
  ],
};

/**
 * Check if a role has a specific permission.
 */
export function hasPermission(role: UserRole, permission: string): boolean {
  return PERMISSIONS[role]?.includes(permission) ?? false;
}

/**
 * Check if the user can perform a direct write (bypass proposal).
 * Only cli:user:explicit actor or admin role.
 */
export function canDirectWrite(role: UserRole | null, risk: RiskLevel): boolean {
  if (risk === "low") {
    return true; // anyone can propose low-risk
  }
  if (role === "admin") {
    return true;
  }
  if (role === "approver" && (risk === "medium" || risk === "high")) {
    return true;
  }
  return false;
}
