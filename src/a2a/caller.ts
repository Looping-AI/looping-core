import type { GatekeeperIdentity } from "./verify.js";

/**
 * Per-request system-prompt suffix describing the verified calling gatekeeper-agent
 * instance, from the gatekeeper identity JWT.
 *
 * Core ships this and not a soul, and the line between them is the point: a soul
 * is prompt copy expressing who an agent *is*, which nobody else can write for
 * you. This is a **rendering of a protocol fact** — who the gatekeeper proved it was
 * — and that fact has one correct rendering. Two agents disagreeing about how to
 * describe their caller would be a bug, not a personality. It is the same
 * category as `renderSubagentPrompt`'s budget section, which core also owns.
 *
 * **Advisory context only.** This is the calling *agent instance*, not the human
 * on the other end of it, so an agent's soul must never let the model read it as
 * "who you're talking to" — point the model at whatever speaker wrapper the
 * gatekeeper applies instead.
 *
 * Deliberately neutral about what a workspace is: `GatekeeperIdentity.workspaceId`
 * is whatever the calling gatekeeper partitions by, and core does not know that it
 * is a Slack team. Override `DynamicAgent.callerContext` for a deployment that
 * wants to name it.
 */
export function callerContext(identity: GatekeeperIdentity): string {
  const label = identity.name ?? identity.key;
  if (!label) {
    return "\n\nCalling agent instance: unknown (the gatekeeper did not include an agent identity).";
  }
  const withKind = identity.kind ? `${label} (${identity.kind})` : label;
  const lines = ["", "", `Calling agent instance: ${withKind}.`];
  if (identity.workspaceId != null) {
    lines.push(`Calling workspace: ${identity.workspaceId}.`);
  }
  return lines.join("\n");
}
