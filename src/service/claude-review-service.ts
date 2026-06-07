export interface ClaudeReviewRequest {
  kind: "plan" | "patch";
  content: string;
  maxBudgetUsd?: number;
}

export interface ClaudeReviewFinding {
  severity: "low" | "medium" | "high";
  title: string;
  detail: string;
}

export interface ClaudeReview {
  findings: ClaudeReviewFinding[];
  recommendations: string[];
  raw?: string;
}

function reviewPrompt(request: ClaudeReviewRequest): string {
  return [
    "You are a read-only architecture critic for triMemh.",
    "Do not ask to inspect files. Do not suggest mutating the repository.",
    "Return strict JSON with shape:",
    '{"findings":[{"severity":"low|medium|high","title":"...","detail":"..."}],"recommendations":["..."]}',
    `Review kind: ${request.kind}`,
    "Content:",
    request.content,
  ].join("\n");
}

export function buildClaudeReviewCommand(request: ClaudeReviewRequest): string[] {
  return [
    "claude",
    "-p",
    reviewPrompt(request),
    "--output-format",
    "text",
    "--tools",
    "",
    "--permission-mode",
    "plan",
    "--max-budget-usd",
    String(request.maxBudgetUsd ?? 1),
  ];
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

function isFinding(value: unknown): value is ClaudeReviewFinding {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ClaudeReviewFinding>;
  return (
    (candidate.severity === "low" ||
      candidate.severity === "medium" ||
      candidate.severity === "high") &&
    typeof candidate.title === "string" &&
    typeof candidate.detail === "string"
  );
}

export function parseClaudeReviewOutput(output: string): ClaudeReview {
  const json = extractJsonObject(output);
  if (!json) {
    return { findings: [], recommendations: [], raw: output };
  }

  try {
    const parsed = JSON.parse(json) as { findings?: unknown; recommendations?: unknown };
    return {
      findings: Array.isArray(parsed.findings) ? parsed.findings.filter(isFinding) : [],
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.filter((item): item is string => typeof item === "string")
        : [],
      raw: output,
    };
  } catch {
    return { findings: [], recommendations: [], raw: output };
  }
}

export function runClaudeReview(request: ClaudeReviewRequest): ClaudeReview {
  const command = buildClaudeReviewCommand(request);
  const result = Bun.spawnSync(command, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  if (result.exitCode !== 0) {
    throw new Error(stderr || stdout || "Claude review failed.");
  }
  return parseClaudeReviewOutput(stdout);
}
