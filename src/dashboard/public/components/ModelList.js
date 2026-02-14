// ============================================================
// ModelList — 利用可能モデル一覧
// ============================================================

import { createElement as h } from "react";

/**
 * 利用可能モデル一覧を表示するコンポーネント。
 * 職種登録時にどのモデルが使用できるかを確認するために使用する。
 *
 * @param {{ models: string[] }} props
 */
export function ModelList({ models }) {
  if (models.length === 0) {
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

  return h("div", { className: "info-section" },
    h("h3", { className: "info-section-title" }, "利用可能モデル"),
    h("div", { className: "info-description" },
      "職種（Role）の設定で使用できるモデルの一覧です。",
      h("code", { className: "inline-code" }, "agent models"),
      " コマンドで取得されます。",
    ),
    h("div", { className: "model-count" },
      `${models.length} モデルが利用可能`,
    ),
    h("ul", { className: "model-list" },
      models.map((model) =>
        h("li", { key: model, className: "model-item" },
          h("span", { className: "model-icon" }, "\u2728"),
          h("span", { className: "model-name" }, model),
        ),
      ),
    ),
  );
}
