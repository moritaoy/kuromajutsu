// ============================================================
// ModelList — 利用可能モデル一覧（Provider 別）
// ============================================================

import { createElement as h } from "react";

const PROVIDER_LABELS = {
  cursor: { name: "Cursor", source: "agent models" },
  claude: { name: "Claude", source: "Claude Code のエイリアス / claude-* の完全 ID" },
};

/**
 * 利用可能モデル一覧を Provider 別に表示するコンポーネント。
 * 職種登録時にどのモデルが使用できるかを確認するために使用する。
 *
 * @param {{ models: string[], modelsByProvider?: Record<string, string[]> }} props
 */
export function ModelList({ models, modelsByProvider }) {
  const groups = Object.entries(modelsByProvider || {}).filter(
    ([, list]) => list && list.length > 0,
  );
  // Provider 別情報が無い場合はフラットな一覧にフォールバック
  const effectiveGroups = groups.length > 0 ? groups : models.length > 0 ? [["", models]] : [];

  if (effectiveGroups.length === 0) {
    return h("div", { className: "info-section" },
      h("h3", { className: "info-section-title" }, "利用可能モデル"),
      h("div", { className: "empty-state" },
        h("div", { className: "empty-state-icon" }, "\uD83E\uDD16"),
        h("div", { className: "empty-state-text" }, "モデル情報がありません"),
        h("div", { className: "empty-state-subtext" },
          "サーバー起動時にヘルスチェックが実行されるとモデル一覧が表示されます",
        ),
      ),
    );
  }

  const total = effectiveGroups.reduce((n, [, list]) => n + list.length, 0);

  return h("div", { className: "info-section" },
    h("h3", { className: "info-section-title" }, "利用可能モデル"),
    h("div", { className: "info-description" },
      "職種（Role）の設定で provider と組み合わせて使用できるモデルの一覧です。",
    ),
    h("div", { className: "model-count" }, `${total} モデルが利用可能`),
    effectiveGroups.map(([providerId, list]) =>
      h("div", { key: providerId || "all" },
        providerId
          ? h("h4", { className: "info-section-subtitle" },
              (PROVIDER_LABELS[providerId] || { name: providerId }).name,
              PROVIDER_LABELS[providerId]
                ? h("span", { className: "info-description" }, ` — ${PROVIDER_LABELS[providerId].source}`)
                : null,
            )
          : null,
        h("ul", { className: "model-list" },
          list.map((model) =>
            h("li", { key: `${providerId}:${model}`, className: "model-item" },
              h("span", { className: "model-icon" }, "\u2728"),
              h("span", { className: "model-name" }, model),
            ),
          ),
        ),
      ),
    ),
  );
}
