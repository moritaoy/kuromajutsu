// ============================================================
// ゲートの command チェックの安全性判定（docs/spec.md §13.5.3）
//
// 判定のみを行う。実行（sh -c）は run_gate_check 側の責務。
// denylist は事故を防ぐための安全網であり、サンドボックスではない。
// ============================================================

import type { AppConfig, WorkspaceConfig } from "../types/index.js";

/** workspace 設定のデフォルト値（§9.2） */
export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
  gateCommands: {
    deny: [],
    allow: [],
    timeout_ms: 600000,
    maxOutput_bytes: 1048576,
  },
};

/** `AppConfig.workspace` を、省略時はデフォルトで補って返す */
export function getWorkspaceConfig(config: AppConfig): WorkspaceConfig {
  const gc = {
    ...DEFAULT_WORKSPACE_CONFIG.gateCommands,
    ...config.workspace?.gateCommands,
  };
  // 配列は共有しない（呼び出し側が書き換えても既定値に影響しない）
  return { gateCommands: { ...gc, deny: [...gc.deny], allow: [...gc.allow] } };
}

/** 判定ポリシー */
export interface CommandPolicy {
  /** 禁止パターン（既定 + 追加） */
  deny: RegExp[];
  /** 前方一致の許可リスト。空なら denylist のみで判定する */
  allow: string[];
}

// 連結子（; && || | &）をまたがない任意文字列。リダイレクトの &（2>&1 / &>）は許す
const NO_CONNECTOR = "(?:[^;&|\\n]|(?<=[<>])&|&(?=>))*";

// git のグローバルオプション。値を取るもの（-C / -c / --git-dir / --work-tree / --namespace）と
// 値を取らないもの。曖昧さがないよう、値は `-` で始まらないものに限る（バックトラッキング対策）
const GIT_VALUE = `(?!-)(?:"[^"]*"|'[^']*'|\\S+)`;
const GIT_OPT =
  `(?:(?:-[Cc]|--(?:git-dir|work-tree|namespace))\\s+${GIT_VALUE}` +
  `|-{1,2}\\w[\\w-]*(?:=\\S+)?)`;
const GIT = `(?<![\\w-])git(?:\\s+${GIT_OPT})*\\s+`;

// 「コマンド位置」: 行頭・連結子・括弧・コマンド置換・`sh -c "` の直後。
// 環境変数代入（FOO=1）やラッパー（env / time / nohup / exec / command / xargs / then / do / else）、
// パス指定（/usr/bin/）を挟んでもよい
const CMD_START = "(?:^|[;&|(){`]|\\$\\(|(?:ba|z|da)?sh\\s+-\\w*c\\s+[\"'])\\s*";
const CMD_WRAPPER =
  "(?:(?:\\w+=\\S*|then|do|else|(?:env|time|nohup|exec|command|xargs)(?:\\s+-\\S+)*)\\s+)*";
const CMD = `${CMD_START}${CMD_WRAPPER}(?:\\S*\\/)?`;
const WORD_END = "(?![\\w.-])";

/**
 * 既定の禁止パターン（§13.5.3）。
 * 各セグメントとコマンド全体の両方に対して照合される。
 */
export const DEFAULT_DENY_PATTERNS: RegExp[] = [
  // ルート削除: rm の再帰オプションと / / // /* /. を同時に指すもの
  new RegExp(
    `(?<![\\w-])rm(?=\\s)` +
      `(?=${NO_CONNECTOR}\\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?:\\s|$))` +
      `(?=${NO_CONNECTOR}\\s["']?/+(?:\\*|\\.)?["']?(?:\\s|$))`,
  ),
  // 権限昇格（コマンド位置のみ）
  new RegExp(`${CMD}sudo${WORD_END}`),
  // リモートへの反映
  new RegExp(`${GIT}push(?![\\w-])`),
  // 変更の破棄
  new RegExp(`${GIT}reset(?![\\w-])${NO_CONNECTOR}\\s--hard(?![\\w-])`),
  // パイプ実行: curl / wget の出力をシェルへ流す
  /(?<![\w-])(?:curl|wget)(?![\w-])(?:[^\n;&|]|&(?!&)|\|(?!\|))*\|(?!\|)\s*(?:sudo\s+)?(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|fish)(?![\w-])/,
  // 電源操作（コマンド位置のみ）
  new RegExp(`${CMD}(?:shutdown|reboot)${WORD_END}`),
];

/**
 * 設定からポリシーを組み立てる。
 * 不正な正規表現があれば、該当パターンを含む Error を投げる。
 */
export function buildCommandPolicy(config: WorkspaceConfig): CommandPolicy {
  const extra = config.gateCommands.deny.map((pattern) => {
    try {
      return new RegExp(pattern);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(`禁止パターンの正規表現が不正です: ${pattern} (${detail})`);
    }
  });
  return {
    deny: [...DEFAULT_DENY_PATTERNS, ...extra],
    allow: config.gateCommands.allow.map((a) => a.trim()).filter((a) => a.length > 0),
  };
}

/**
 * シェルの連結子（`;` `&&` `||` `|` `|&` 単独の `&` 改行）で分割する。空セグメントは除く。
 * リダイレクトの `&`（`2>&1` / `&>` / `>&`）は連結子として扱わない。
 */
export function splitCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||\|&|;|\||\r?\n|(?<![<>&])&(?![&>])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export type CommandCheckResult = { allowed: true } | { allowed: false; reason: string };

/**
 * コマンドが実行可能か判定する（§13.5.3）。
 *
 * 1. 禁止パターンを、コマンド全体と各セグメントに照合する
 * 2. `allow` が非空なら、`$(` / バッククォートを含まず、
 *    各セグメントがいずれかの許可プレフィックスで始まること
 */
export function checkCommand(command: string, policy: CommandPolicy): CommandCheckResult {
  if (command.trim().length === 0) {
    return { allowed: false, reason: "コマンドが空です" };
  }

  const segments = splitCommandSegments(command);

  for (const pattern of policy.deny) {
    for (const target of [command, ...segments]) {
      if (pattern.test(target)) {
        return { allowed: false, reason: `禁止パターンに一致します: ${pattern.source}` };
      }
    }
  }

  if (policy.allow.length > 0) {
    if (command.includes("$(") || command.includes("`")) {
      return {
        allowed: false,
        reason: "許可リスト方式では $( とバッククォート（コマンド置換）を含むコマンドは許可されません",
      };
    }
    for (const segment of segments) {
      if (!policy.allow.some((prefix) => segment.startsWith(prefix))) {
        return { allowed: false, reason: `許可リストにないコマンドです: ${segment}` };
      }
    }
  }

  return { allowed: true };
}
