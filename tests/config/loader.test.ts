// ============================================================
// 設定ローダー テスト
// ============================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/loader.js";

describe("loadConfig", () => {
  it("デフォルト設定を読み込める", () => {
    const config = loadConfig();

    expect(config.dashboard.port).toBe(9696);
    expect(config.agent.defaultTimeout_ms).toBeUndefined();
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

  describe("provider", () => {
    function writeConfig(yaml: string): string {
      const dir = mkdtempSync(join(tmpdir(), "kuromajutsu-cfg-"));
      const file = join(dir, "config.yaml");
      writeFileSync(file, yaml, "utf-8");
      return file;
    }

    afterEach(() => vi.restoreAllMocks());

    const role = (extra = "") => `
roles:
  - id: r1
    name: R1
    description: d
    ${extra}
    model: sonnet
    systemPrompt: s
    healthCheckPrompt: hi
`;

    it("provider を省略した職種は cursor になる", () => {
      const config = loadConfig(writeConfig(role()));
      expect(config.roles[0].provider).toBe("cursor");
    });

    it("provider: claude を読み込める", () => {
      const config = loadConfig(writeConfig(role("provider: claude")));
      expect(config.roles[0].provider).toBe("claude");
    });

    it("未知の provider はエラーにする", () => {
      expect(() => loadConfig(writeConfig(role("provider: gemini")))).toThrow(/provider/);
    });

    it("providers.claude.permissionMode を読み込める（デフォルトは bypassPermissions）", () => {
      const withMode = loadConfig(
        writeConfig("providers:\n  claude:\n    permissionMode: acceptEdits\n" + role()),
      );
      expect(withMode.providers?.claude?.permissionMode).toBe("acceptEdits");

      const without = loadConfig(writeConfig(role()));
      expect(without.providers?.claude?.permissionMode ?? "bypassPermissions").toBe("bypassPermissions");
    });
  });
});
