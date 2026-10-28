// ============================================================
// Provider レジストリ
// ============================================================

import type { AgentProviderId, RoleDefinition } from "../../types/index.js";
import { ClaudeProvider } from "./claude.js";
import { CursorProvider } from "./cursor.js";
import type { AgentProvider } from "./types.js";

export type {
  AgentProvider,
  ExecCommandOptions,
  ProviderCommand,
  StreamNormalizer,
} from "./types.js";

/** デフォルトの Provider（provider 未指定の職種に適用。後方互換） */
export const DEFAULT_PROVIDER_ID: AgentProviderId = "cursor";

export const AGENT_PROVIDER_IDS: readonly AgentProviderId[] = ["cursor", "claude"];

const PROVIDERS: Record<AgentProviderId, AgentProvider> = {
  cursor: new CursorProvider(),
  claude: new ClaudeProvider(),
};

export function getProvider(id: AgentProviderId): AgentProvider {
  return PROVIDERS[id];
}

export function isAgentProviderId(value: unknown): value is AgentProviderId {
  return typeof value === "string" && (AGENT_PROVIDER_IDS as readonly string[]).includes(value);
}

/** 職種の Provider ID を解決する（未指定は cursor） */
export function resolveProviderId(role: Pick<RoleDefinition, "provider">): AgentProviderId {
  return role.provider ?? DEFAULT_PROVIDER_ID;
}
