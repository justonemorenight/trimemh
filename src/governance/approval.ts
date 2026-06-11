import type { RiskLevel } from "../domain/schema";
import type {
  ApprovalPolicy,
  ApprovalStatus,
  ReviewerVote,
  UserRole,
  UserRoleEntry,
} from "./types";

export const DEFAULT_APPROVAL_POLICIES: Record<RiskLevel, ApprovalPolicy> = {
  low: {
    minReviewers: 0,
    requiredRoles: [],
    quorumPercent: 0,
    autoApproveBelow: "low",
  },
  medium: {
    minReviewers: 1,
    requiredRoles: [],
    quorumPercent: 0,
    autoApproveBelow: "low",
  },
  high: {
    minReviewers: 1,
    requiredRoles: ["approver"],
    quorumPercent: 0,
    autoApproveBelow: "medium",
  },
  critical: {
    minReviewers: 2,
    requiredRoles: ["approver", "admin"],
    quorumPercent: 100,
    autoApproveBelow: "medium",
  },
};

/**
 * Evaluate whether a proposal has sufficient approvals.
 */
export function evaluateApproval(
  risk: RiskLevel,
  votes: ReviewerVote[],
  availableReviewers: UserRoleEntry[],
  policy?: ApprovalPolicy,
): ApprovalStatus {
  const pol = policy ?? DEFAULT_APPROVAL_POLICIES[risk];
  const approvals = votes.filter((v) => v.decision === "approved").length;
  const rejections = votes.filter((v) => v.decision === "rejected").length;
  const votesReceived = approvals + rejections;

  // Check required roles are represented among approvers
  const approverRoles = new Set(
    votes
      .filter((v) => v.decision === "approved")
      .map((v) => availableReviewers.find((r) => r.userId === v.userId)?.role)
      .filter(Boolean) as UserRole[],
  );

  const missingRoles = pol.requiredRoles.filter((r) => !approverRoles.has(r));

  // Quorum check
  const totalVotes = votes.filter((v) => v.decision !== "abstain").length;
  const quorumMet = totalVotes >= pol.minReviewers;

  // Percentage check
  const totalDecisive = approvals + rejections;
  const approvePercent = totalDecisive > 0 ? (approvals / totalDecisive) * 100 : 0;
  const percentMet = approvePercent >= pol.quorumPercent;

  const canApprove =
    quorumMet &&
    percentMet &&
    missingRoles.length === 0 &&
    (totalDecisive === 0 || approvals > rejections);

  let message: string;
  if (canApprove) {
    message =
      `Approval met: ${approvals}/${totalDecisive} approved (${Math.round(approvePercent)}%), ` +
      `${pol.minReviewers} reviewers required.`;
  } else {
    const reasons: string[] = [];
    if (!quorumMet) {
      reasons.push(`need ${pol.minReviewers} reviewers, have ${totalVotes}`);
    }
    if (!percentMet) {
      reasons.push(`need ${pol.quorumPercent}% approval, have ${Math.round(approvePercent)}%`);
    }
    if (missingRoles.length > 0) {
      reasons.push(`missing roles: ${missingRoles.join(", ")}`);
    }
    message = `Approval not met: ${reasons.join("; ")}.`;
  }

  return {
    canApprove,
    votesReceived,
    votesRequired: pol.minReviewers,
    approvals,
    rejections,
    missingRoles,
    message,
  };
}
