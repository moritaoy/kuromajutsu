// ============================================================
// Provider レジストリ テスト
// ============================================================

import { describe, it, expect } from "vitest";
import {
  AGENT_PROVIDER_IDS,
  getProvider,
  isAgentProviderId,
  resolveProviderId,
} from "../../../src/agent/providers/index.js";

describe("provider registry", () => {
  it("cursor と claude の 2 Provider を提供する", () => {
    expect([...AGENT_PROVIDER_IDS].sort()).toEqual(["claude", "cursor"]);
    expect(getProvider("cursor").id).toBe("cursor");
    expect(getProvider("claude").id).toBe("claude");
  });

  it("provider 省略時は cursor に解決する（後方互換）", () => {
    expect(resolveProviderId({})).toBe("cursor");
    expect(resolveProviderId({ provider: "claude" })).toBe("claude");
  });

  it("isAgentProviderId が未知の値を弾く", () => {
    expect(isAgentProviderId("cursor")).toBe(true);
    expect(isAgentProviderId("claude")).toBe(true);
    expect(isAgentProviderId("gemini")).toBe(false);
    expect(isAgentProviderId(undefined)).toBe(false);
  });
});
