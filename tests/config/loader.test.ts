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
  describe("workspace", () => {
    function writeConfig(yaml: string): string {
      const dir = mkdtempSync(join(tmpdir(), "kuromajutsu-cfg-"));
      const file = join(dir, "config.yaml");
      writeFileSync(file, yaml, "utf-8");
      return file;
    }

    const defaults = {
      gateCommands: { deny: [], allow: [], timeout_ms: 600000, maxOutput_bytes: 1048576 },
    };

    afterEach(() => vi.restoreAllMocks());

    it("省略時は既定値が入る", () => {
      expect(loadConfig(writeConfig("log:\n  level: info\n")).workspace).toEqual(defaults);
      expect(loadConfig("/tmp/nonexistent.yaml").workspace).toEqual(defaults);
    });

    it("既定値を共有しない（結果を書き換えても次の読み込みに影響しない）", () => {
      const a = loadConfig(writeConfig("log:\n  level: info\n"));
      a.workspace!.gateCommands.deny.push("x");
      const b = loadConfig(writeConfig("log:\n  level: info\n"));
      expect(b.workspace!.gateCommands.deny).toEqual([]);
    });

    it("指定したキーだけ上書きし、残りは既定値（ディープマージ）", () => {
      const config = loadConfig(
        writeConfig(
          "workspace:\n  gateCommands:\n    allow:\n      - npm test\n    timeout_ms: 1000\n",
        ),
      );
      expect(config.workspace).toEqual({
        gateCommands: { deny: [], allow: ["npm test"], timeout_ms: 1000, maxOutput_bytes: 1048576 },
      });
    });

    it("deny を読み込める", () => {
      const config = loadConfig(
        writeConfig("workspace:\n  gateCommands:\n    deny:\n      - 'terraform\\s+apply'\n"),
      );
      expect(config.workspace?.gateCommands.deny).toEqual(["terraform\\s+apply"]);
    });

    it("gateCommands が空（値なし）でも既定値になる", () => {
      expect(loadConfig(writeConfig("workspace:\n  gateCommands:\n")).workspace).toEqual(defaults);
      expect(loadConfig(writeConfig("workspace:\n")).workspace).toEqual(defaults);
    });

    it("deny の正規表現が不正ならエラー", () => {
      expect(() =>
        loadConfig(writeConfig("workspace:\n  gateCommands:\n    deny:\n      - '(unclosed'\n")),
      ).toThrow(/gateCommands\.deny.*\(unclosed/);
    });

    it("allow が空文字・空白だけの要素で構成されていたらエラー（denylist へ黙ってフォールバックしない）", () => {
      expect(() =>
        loadConfig(writeConfig("workspace:\n  gateCommands:\n    allow:\n      - ''\n")),
      ).toThrow(/allow/);
      expect(() =>
        loadConfig(writeConfig("workspace:\n  gateCommands:\n    allow:\n      - '  '\n      - ''\n")),
      ).toThrow(/allow/);
      // 有効な要素があれば通る
      expect(
        loadConfig(writeConfig("workspace:\n  gateCommands:\n    allow:\n      - npm test\n")).workspace
          ?.gateCommands.allow,
      ).toEqual(["npm test"]);
    });

    it("deny / allow が文字列の配列でなければエラー", () => {
      expect(() =>
        loadConfig(writeConfig("workspace:\n  gateCommands:\n    deny: foo\n")),
      ).toThrow(/deny/);
      expect(() =>
        loadConfig(writeConfig("workspace:\n  gateCommands:\n    allow: [1]\n")),
      ).toThrow(/allow/);
    });

    it("timeout_ms / maxOutput_bytes が正の数でなければエラー", () => {
      expect(() =>
        loadConfig(writeConfig("workspace:\n  gateCommands:\n    timeout_ms: 0\n")),
      ).toThrow(/timeout_ms/);
      expect(() =>
        loadConfig(writeConfig("workspace:\n  gateCommands:\n    maxOutput_bytes: abc\n")),
      ).toThrow(/maxOutput_bytes/);
    });
  });
});
