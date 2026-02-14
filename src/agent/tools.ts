// ============================================================
// ロールツールレジストリ
// ============================================================
//
// 責務:
// - Agent が利用可能な外部ツール（linter 等）を定義する
// - ツール ID から定義を解決する
// - ロールに紐付くツール群のプロンプト用テキストを生成する

import type { RoleToolDefinition } from "../types/index.js";

// --------------------------------------------------
// ビルトインツール定義
// --------------------------------------------------

const TEXTLINT_TOOL: RoleToolDefinition = {
  id: "textlint",
  name: "textlint",
  description: "文章の品質チェックツール。日本語の文法・表現ルールに基づいて問題を検出する。",
  healthCheckCommand: { command: "npx", args: ["textlint", "--version"] },
  promptInstructions: `## 利用可能ツール: textlint（文章 linter）

あなたはレビュー対象のファイルに対して \`textlint\` を実行し、機械的にチェック可能な文章品質の問題を検出できます。

### 使い方

\`\`\`bash
# 特定ファイルをチェック
npx textlint <ファイルパス>

# 複数ファイルをチェック
npx textlint <ファイル1> <ファイル2>

# glob パターンでチェック
npx textlint "docs/**/*.md"
\`\`\`

### 出力の読み方

textlint はエラーと警告を行番号付きで出力します。例:

\`\`\`
docs/spec.md
  1:10  error  Found invalid control character  preset-japanese
  5:3   error  文末が"。"で終わっていません。   preset-japanese
\`\`\`

### レビューでの活用方法

1. まず textlint を実行して機械的に検出可能な問題を洗い出す
2. textlint の結果を踏まえた上で、人間の目で文脈・構成・一貫性を確認する
3. textlint では検出できない表現の改善提案も行う
4. レポートには textlint の結果と手動レビューの結果を両方含める`,
};

// --------------------------------------------------
// ツールレジストリ
// --------------------------------------------------

/** ビルトインツールの Map: id → RoleToolDefinition */
const BUILTIN_TOOLS: Map<string, RoleToolDefinition> = new Map([
  [TEXTLINT_TOOL.id, TEXTLINT_TOOL],
]);

/**
 * ツール ID から定義を解決する。
 * 見つからない場合は undefined を返す。
 */
export function getToolDefinition(toolId: string): RoleToolDefinition | undefined {
  return BUILTIN_TOOLS.get(toolId);
}

/**
 * 全ビルトインツールの一覧を返す。
 */
export function listToolDefinitions(): RoleToolDefinition[] {
  return Array.from(BUILTIN_TOOLS.values());
}

/**
 * 指定されたツール ID 一覧から、プロンプトに注入するテキストを生成する。
 * 存在しないツール ID は警告ログを出してスキップする。
 *
 * @returns プロンプト注入用テキスト（ツールがなければ空文字列）
 */
export function buildToolPromptBlock(toolIds: string[]): string {
  if (!toolIds || toolIds.length === 0) return "";

  const instructions: string[] = [];

  for (const id of toolIds) {
    const tool = BUILTIN_TOOLS.get(id);
    if (!tool) {
      console.warn(`[tools] 未知のツール ID: "${id}" — スキップします`);
      continue;
    }
    instructions.push(tool.promptInstructions);
  }

  if (instructions.length === 0) return "";

  return [
    "---",
    "【利用可能ツール】",
    "",
    ...instructions,
    "---",
  ].join("\n");
}
