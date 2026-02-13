// ============================================================
// 設定ファイル読み込み
// ============================================================

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AppConfig } from "../types/index.js";

/** ビルトインデフォルト値 */
const DEFAULTS: AppConfig = {
  dashboard: {
    port: 9696,
  },
  agent: {
    defaultTimeout_ms: 300_000,
    maxConcurrent: 10,
  },
  log: {
    level: "info",
  },
  roles: [],
};

/**
 * 設定を読み込む。
 *
 * 優先順位:
 * 1. 環境変数（個別オーバーライド）
 * 2. kuromajutsu.config.yaml
 * 3. ビルトインデフォルト値
 */
export function loadConfig(configPath?: string): AppConfig {
  const filePath =
    configPath ??
    process.env["KUROMAJUTSU_CONFIG"] ??
    resolve(process.cwd(), "kuromajutsu.config.yaml");

  let fileConfig: Partial<AppConfig> = {};

  try {
    const raw = readFileSync(filePath, "utf-8");
    fileConfig = parseYaml(raw) as Partial<AppConfig>;
  } catch {
    console.warn(`[config] 設定ファイルが見つかりません: ${filePath} — デフォルト値を使用します`);
  }

  // マージ: デフォルト ← ファイル ← 環境変数
  const config: AppConfig = {
    dashboard: {
      ...DEFAULTS.dashboard,
      ...fileConfig.dashboard,
    },
    agent: {
      ...DEFAULTS.agent,
      ...fileConfig.agent,
    },
    log: {
      ...DEFAULTS.log,
      ...fileConfig.log,
    },
    roles: fileConfig.roles ?? DEFAULTS.roles,
  };

  // 環境変数によるオーバーライド
  if (process.env["KUROMAJUTSU_PORT"]) {
    config.dashboard.port = Number(process.env["KUROMAJUTSU_PORT"]);
  }
  if (process.env["KUROMAJUTSU_LOG_LEVEL"]) {
    config.log.level = process.env["KUROMAJUTSU_LOG_LEVEL"] as AppConfig["log"]["level"];
  }

  return config;
}
