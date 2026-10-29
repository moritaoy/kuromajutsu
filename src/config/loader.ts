// ============================================================
// 設定ファイル読み込み
// ============================================================

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_PROVIDER_ID, isAgentProviderId } from "../agent/providers/index.js";
import type { AppConfig, RoleDefinition, WorkspaceConfig } from "../types/index.js";
import {
  DEFAULT_WORKSPACE_CONFIG,
  buildCommandPolicy,
} from "../workspace/gate-commands.js";

/** ビルトインデフォルト値 */
const DEFAULTS: AppConfig = {
  dashboard: {
    port: 9696,
  },
  agent: {
    maxConcurrent: 10,
  },
  log: {
    level: "info",
  },
  roles: [],
  workspace: DEFAULT_WORKSPACE_CONFIG,
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
    roles: normalizeRoles(fileConfig.roles ?? DEFAULTS.roles),
    workspace: normalizeWorkspaceConfig(fileConfig.workspace),
  };
  if (fileConfig.providers) {
    config.providers = fileConfig.providers;
  }

  // 環境変数によるオーバーライド
  if (process.env["KUROMAJUTSU_PORT"]) {
    config.dashboard.port = Number(process.env["KUROMAJUTSU_PORT"]);
  }
  if (process.env["KUROMAJUTSU_LOG_LEVEL"]) {
    config.log.level = process.env["KUROMAJUTSU_LOG_LEVEL"] as AppConfig["log"]["level"];
  }

  return config;
}

/**
 * 職種定義を正規化する。
 * - provider 省略時は cursor（後方互換）
 * - 未知の provider はエラー
 */
function normalizeRoles(roles: RoleDefinition[]): RoleDefinition[] {
  return roles.map((role) => {
    const provider = role.provider ?? DEFAULT_PROVIDER_ID;
    if (!isAgentProviderId(provider)) {
      throw new Error(
        `[config] 職種 '${role.id}' の provider '${String(provider)}' は未対応です（cursor | claude）`,
      );
    }
    return { ...role, provider };
  });
}

/**
 * workspace 設定をデフォルトとディープマージして検証する（§9.2）。
 * `gateCommands.deny` の正規表現が不正な場合はエラー（起動時に報告する）。
 */
function normalizeWorkspaceConfig(file: Partial<WorkspaceConfig> | undefined | null): WorkspaceConfig {
  const defaults = DEFAULT_WORKSPACE_CONFIG.gateCommands;
  const gc = (file?.gateCommands ?? {}) as Partial<WorkspaceConfig["gateCommands"]>;

  const strings = (key: "deny" | "allow"): string[] => {
    const v = gc[key];
    if (v == null) return [...defaults[key]];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      throw new Error(`[config] workspace.gateCommands.${key} は文字列の配列で指定してください`);
    }
    return [...v];
  };
  const positive = (key: "timeout_ms" | "maxOutput_bytes"): number => {
    const v = gc[key];
    if (v == null) return defaults[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(`[config] workspace.gateCommands.${key} は正の数で指定してください`);
    }
    return v;
  };

  const allow = strings("allow");
  if (allow.length > 0 && allow.every((a) => a.trim() === "")) {
    throw new Error(
      "[config] workspace.gateCommands.allow が空文字・空白のみです（許可リストとして無効。使わない場合は省略するか [] にしてください）",
    );
  }

  const workspace: WorkspaceConfig = {
    gateCommands: {
      deny: strings("deny"),
      allow,
      timeout_ms: positive("timeout_ms"),
      maxOutput_bytes: positive("maxOutput_bytes"),
    },
  };

  try {
    buildCommandPolicy(workspace);
  } catch (e) {
    throw new Error(
      `[config] workspace.gateCommands.deny: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return workspace;
}
