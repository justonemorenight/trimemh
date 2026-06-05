import type { RateLimiter } from "../infrastructure/rate-limit";

export function checkRateLimit(
  rateLimiter: RateLimiter,
  toolName: string,
): { allowed: true } | { allowed: false; retryAfter: number } {
  const result = rateLimiter.check(toolName);
  if (!result.allowed) {
    console.warn(
      `[triMemh] rate_limit: ${toolName} denied (retry in ${result.retryAfter}s, ` +
        `remaining: ${result.remainingTokens})`,
    );
    return { allowed: false, retryAfter: result.retryAfter };
  }
  return { allowed: true };
}

export function enforceStdinPayloadLimit(limitBytes = 15360): void {
  let accumulatedBuffer = "";
  process.stdin.on("data", (chunk) => {
    accumulatedBuffer += chunk.toString();
    const lines = accumulatedBuffer.split("\n");
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i]?.length > limitBytes) {
        console.error(
          `[SECURITY ALERT] [${new Date().toISOString()}] ACTOR: mcp:system | EVENT: payload_boundary_violation | DETAILS: Request payload size exceeds 15KB limit (${lines[i]?.length} bytes). Process terminated.`,
        );
        process.exit(1);
      }
    }
    if (lines[lines.length - 1]?.length > limitBytes) {
      console.error(
        `[SECURITY ALERT] [${new Date().toISOString()}] ACTOR: mcp:system | EVENT: payload_boundary_violation | DETAILS: Request payload size exceeds 15KB limit. Process terminated.`,
      );
      process.exit(1);
    }
    accumulatedBuffer = lines[lines.length - 1] ?? "";
  });
}
