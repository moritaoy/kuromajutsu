// ============================================================
// HealthStatus — ヘルスチェック状況表示
// ============================================================

import { createElement as h } from "react";

/** アイコンマップ */
const ICONS = {
  valid: "\u2705",    // ✅
  invalid: "\u274C",  // ❌
  passed: "\u2705",   // ✅
  failed: "\u274C",   // ❌
  skipped: "\u23ED",  // ⏭
  checking: "\uD83D\uDD04", // 🔄
  waiting: "\u23F3",  // ⏳
};

/**
 * @param {{ healthChecks: object, roles: object[] }} props
 */
export function HealthStatus({ healthChecks, roles }) {
  const results = Object.values(healthChecks);
  const hasResults = results.length > 0;

  if (!hasResults && (!roles || roles.length === 0)) {
    return h("div", { className: "empty-state" },
      h("div", { className: "empty-state-icon" }, "\uD83D\uDC89"),
      h("div", { className: "empty-state-text" }, "ヘルスチェック情報がありません"),
      h("div", { className: "empty-state-subtext" }, "サーバー起動時に自動で実行されます"),
    );
  }

  // 完了カウント
  const availableCount = results.filter((r) => r.available).length;
  const totalCount = results.length;

  return h("div", null,
    h("h2", { className: "page-title" }, "ヘルスチェック状況"),

    // Step 1: モデル検証
    h("div", { className: "health-section" },
      h("div", { className: "health-step-title" }, "[1/3] モデル検証"),
      h("ul", { className: "health-role-list" },
        results.map((r) =>
          h("li", { key: r.roleId, className: "health-role-item" },
            h("span", {
              className: `health-icon ${r.modelValidation ? r.modelValidation.status : "waiting"}`,
            }, r.modelValidation
              ? ICONS[r.modelValidation.status] || ICONS.waiting
              : ICONS.waiting,
            ),
            h("span", { className: "health-role-name" }, r.roleId),
            r.modelValidation && r.modelValidation.message
              ? h("span", { className: "health-role-model" }, r.modelValidation.message)
              : null,
          ),
        ),
      ),
    ),

    // Step 2: ヘルスチェック実行
    h("div", { className: "health-section" },
      h("div", { className: "health-step-title" }, "[2/3] ヘルスチェック実行"),
      h("ul", { className: "health-role-list" },
        results.map((r) =>
          h("li", { key: r.roleId, className: "health-role-item" },
            h("span", {
              className: `health-icon ${r.healthCheck ? r.healthCheck.status : "waiting"}`,
            }, r._checking
              ? ICONS.checking
              : r.healthCheck
                ? ICONS[r.healthCheck.status] || ICONS.waiting
                : ICONS.waiting,
            ),
            h("span", { className: "health-role-name" }, r.roleId),
            r.healthCheck && r.healthCheck.responseTime_ms != null
              ? h("span", { className: "health-response-time" },
                  `(${(r.healthCheck.responseTime_ms / 1000).toFixed(1)}s)`,
                )
              : null,
            r.healthCheck && r.healthCheck.reason
              ? h("span", { className: "health-role-model" }, r.healthCheck.reason)
              : null,
          ),
        ),
      ),
    ),

    // Step 3: 完了サマリ
    h("div", { className: "health-section" },
      h("div", { className: "health-step-title" }, "[3/3] 完了"),
      h("div", { className: "health-summary" },
        totalCount > 0
          ? `全 ${totalCount} 職種中 ${availableCount} 職種が利用可能です`
          : "チェック結果を待機中...",
      ),
    ),
  );
}
