// ============================================================
// ヘルスチェッカー テスト
// ============================================================

import { describe, it, expect } from "vitest";
import { HealthChecker } from "../../src/health/checker.js";
import { loadConfig } from "../../src/config/loader.js";

describe("HealthChecker", () => {
  it("全職種のヘルスチェック結果を返す", async () => {
    const config = loadConfig();
    const checker = new HealthChecker(config);
    const results = await checker.runAll();

    expect(results).toHaveLength(config.roles.length);
    for (const result of results) {
      expect(result.roleId).toBeTruthy();
      expect(result.available).toBe(true);
    }
  });
});
