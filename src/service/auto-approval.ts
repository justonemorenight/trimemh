/**
 * Auto-approval Service
 *
 * Determines whether a memory proposal should be auto-approved or
 * requires manual review. The default behavior flips the old model:
 * proposals are auto-approved unless the risk level exceeds the
 * configured threshold.
 *
 * Governance integration:
 * - Uses DEFAULT_APPROVAL_POLICIES[risk].autoApproveBelow from governance
 * - Falls back to CONFIG.autoApprove.maxRiskLevel
 *
 * Environment variable overrides:
 * - TRIMEMH_AUTO_APPROVE=<level> — force auto-approve up to this level
 * - TRIMEMH_REQUIRE_APPROVAL=<level> — force require approval above this level
 */

import { CONFIG } from "../config";
import type { MemoryKind, RiskLevel } from "../domain/schema";
import { KIND_RISK_MAP } from "../domain/schema";
import { DEFAULT_APPROVAL_POLICIES } from "../governance/index";

const RISK_ORDER: RiskLevel[] = ["low", "medium", "high", "critical"];

// ─── Public API ──────────────────────────────────────────────────────

export interface AutoApproveDecision {
  /** Whether to auto-approve */
  autoApprove: boolean;
  /** Reason for the decision */
  reason: string;
  /** The effective risk threshold used */
  threshold: RiskLevel;
}

/**
 * Decide whether a memory proposal should be auto-approved.
 *
 * Decision order:
 * 1. If autoApprove is disabled in config → no auto-approve
 * 2. If TRIMEMH_AUTO_APPROVE env var is set → use that as override
 * 3. If risk level <= governance autoApproveBelow → auto-approve
 * 4. If risk level <= config maxRiskLevel → auto-approve
 * 5. Otherwise → require manual approval
 */
export function shouldAutoApproveMemory(input: {
  kind: MemoryKind;
  source?: string;
  confidence?: number;
  requireReview?: boolean;
}): AutoApproveDecision {
  const { kind, source, confidence, requireReview } = input;
  const risk: RiskLevel = KIND_RISK_MAP[kind];

  // Agent explicitly requested review
  if (requireReview) {
    return {
      autoApprove: false,
      reason: `Agent explicitly requested manual review for risk level "${risk}".`,
      threshold: "low",
    };
  }

  // Master switch disabled
  if (!CONFIG.autoApprove.enabled) {
    return {
      autoApprove: false,
      reason: "Auto-approval is disabled in configuration.",
      threshold: "low",
    };
  }

  // Confidence check
  const minConf = CONFIG.autoApprove.minConfidence;
  if (confidence !== undefined && confidence < minConf) {
    return {
      autoApprove: false,
      reason: `Confidence ${confidence} is below minimum threshold ${minConf}.`,
      threshold: "low",
    };
  }

  // CLI user always gets auto-approved (they already bypass via remember())
  if (source === "cli:user:explicit") {
    return {
      autoApprove: true,
      reason: "Direct user write — always auto-approved.",
      threshold: "critical",
    };
  }

  // Check TRIMEMH_AUTO_APPROVE env var override
  const envOverride = resolveEnvOverride();
  if (envOverride) {
    return envOverrideDecision(risk, envOverride);
  }

  // Check governance policy first
  const govPolicy = DEFAULT_APPROVAL_POLICIES[risk];
  const govThreshold = govPolicy.autoApproveBelow;

  // Check config threshold
  const configThreshold = CONFIG.autoApprove.maxRiskLevel as RiskLevel;

  // Use the more permissive threshold (governance or config)
  const effectiveThreshold = higherRisk(govThreshold, configThreshold);

  if (riskOrderIndex(risk) <= riskOrderIndex(effectiveThreshold)) {
    return {
      autoApprove: true,
      reason: `Risk level "${risk}" is at or below auto-approve threshold "${effectiveThreshold}".`,
      threshold: effectiveThreshold,
    };
  }

  return {
    autoApprove: false,
    reason: `Risk level "${risk}" exceeds auto-approve threshold "${effectiveThreshold}" — requires manual approval.`,
    threshold: effectiveThreshold,
  };
}

/**
 * Decide whether a link proposal (memory edge or code link) should be auto-approved.
 * Simpler than memory auto-approval — links are lower risk.
 */
export function shouldAutoApproveLink(input: {
  relation: string;
  source?: string;
  requireReview?: boolean;
}): AutoApproveDecision {
  const { requireReview, relation, source } = input;

  if (requireReview) {
    return {
      autoApprove: false,
      reason: "Agent explicitly requested manual review.",
      threshold: "low",
    };
  }

  if (!CONFIG.autoApprove.enabled) {
    return {
      autoApprove: false,
      reason: "Auto-approval is disabled in configuration.",
      threshold: "low",
    };
  }

  if (!CONFIG.autoApprove.autoApproveLinks) {
    return {
      autoApprove: false,
      reason: "Link auto-approval is disabled in configuration.",
      threshold: "low",
    };
  }

  // Supersedes/contradicts relations are higher risk — always require review
  if (relation === "supersedes" || relation === "contradicts") {
    return {
      autoApprove: false,
      reason: `Relation "${relation}" requires manual review (high-impact relationship).`,
      threshold: "low",
    };
  }

  // CLI user direct link
  if (source === "cli:user:explicit") {
    return {
      autoApprove: true,
      reason: "Direct user link — always auto-approved.",
      threshold: "critical",
    };
  }

  return {
    autoApprove: true,
    reason: "Link proposals are auto-approved by default.",
    threshold: "critical",
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function riskOrderIndex(risk: RiskLevel): number {
  return RISK_ORDER.indexOf(risk);
}

function higherRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return riskOrderIndex(a) >= riskOrderIndex(b) ? a : b;
}

function resolveEnvOverride(): RiskLevel | null {
  const envVal = process.env.TRIMEMH_AUTO_APPROVE?.toLowerCase();
  if (!envVal) {
    return null;
  }
  if (envVal === "all" || envVal === "critical") {
    return "critical";
  }
  if (RISK_ORDER.includes(envVal as RiskLevel)) {
    return envVal as RiskLevel;
  }
  return null;
}

function resolveRequireApprovalEnv(): RiskLevel | null {
  const envVal = process.env.TRIMEMH_REQUIRE_APPROVAL?.toLowerCase();
  if (!envVal) {
    return null;
  }
  if (envVal === "all") {
    return "low"; // require approval for everything
  }
  if (RISK_ORDER.includes(envVal as RiskLevel)) {
    return envVal as RiskLevel;
  }
  return null;
}

function envOverrideDecision(
  risk: RiskLevel,
  overrideThreshold: RiskLevel,
): AutoApproveDecision {
  // TRIMEMH_REQUIRE_APPROVAL takes precedence as a ceiling
  const requireApprovalFrom = resolveRequireApprovalEnv();
  if (requireApprovalFrom && riskOrderIndex(risk) >= riskOrderIndex(requireApprovalFrom)) {
    return {
      autoApprove: false,
      reason: `Risk "${risk}" requires approval (TRIMEMH_REQUIRE_APPROVAL=${requireApprovalFrom}).`,
      threshold: requireApprovalFrom,
    };
  }

  if (riskOrderIndex(risk) <= riskOrderIndex(overrideThreshold)) {
    return {
      autoApprove: true,
      reason: `Auto-approved via TRIMEMH_AUTO_APPROVE=${overrideThreshold}.`,
      threshold: overrideThreshold,
    };
  }

  return {
    autoApprove: false,
    reason: `Risk "${risk}" exceeds TRIMEMH_AUTO_APPROVE threshold "${overrideThreshold}".`,
    threshold: overrideThreshold,
  };
}
