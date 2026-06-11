// ─── Proposal Service barrel — re-exports focused modules ──────────

export { propose } from "./proposal-create";
export { approve, reject } from "./proposal-decide";
export { proposals, status } from "./proposal-query";
