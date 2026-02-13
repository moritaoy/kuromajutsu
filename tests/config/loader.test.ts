// ============================================================
// 設定ローダー テスト
// ============================================================

import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/loader.js";

describe("loadConfig", () => {
  it("デフォルト設定を読み込める", () => {
    const config = loadConfig();

    expect(config.dashboard.port).toBe(9696);
    expect(config.agent.defaultTimeout_ms).toBe(300_000);
    expect(config.agent.maxConcurrent).toBe(10);
    expect(config.log.level).toBe("info");
    expect(config.roles.length).toBeGreaterThan(0);
  });

  it("4つの初期職種が定義されている", () => {
    const config = loadConfig();
    const roleIds = config.roles.map((r) => r.id);

    expect(roleIds).toContain("impl-code");
    expect(roleIds).toContain("code-review");
    expect(roleIds).toContain("text-review");
    expect(roleIds).toContain("impl-test");
  });

  it("存在しないファイルでもデフォルト値で動作する", () => {
    const config = loadConfig("/tmp/nonexistent.yaml");

    expect(config.dashboard.port).toBe(9696);
    expect(config.roles).toHaveLength(0);
  });
});
