import type { RiskLevel } from "../domain/schema";

export type UserRole = "viewer" | "proposer" | "approver" | "admin";

export interface ApprovalPolicy {
  /** Minimum number of reviewers required. */
  minReviewers: number;
  /** Required roles that must be represented among reviewers. */
  requiredRoles: UserRole[];
  /** Percentage of reviewers that must approve (0-100). */
  quorumPercent: number;
  /** Whether auto-approve is allowed below this risk level. */
  autoApproveBelow: RiskLevel;
}

export interface ReviewerVote {
  id: string;
  proposalId: string;
  userId: string;
  decision: "approved" | "rejected" | "abstain";
  note: string | null;
  createdAt: string;
}

export interface UserRoleEntry {
  id: string;
  projectId: string;
  userId: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalStatus {
  canApprove: boolean;
  votesReceived: number;
  votesRequired: number;
  approvals: number;
  rejections: number;
  missingRoles: UserRole[];
  message: string;
}
