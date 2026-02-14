// ============================================================
// RoleEditor — 職種設定エディタ
// ============================================================

import { createElement as h, useState } from "react";

/**
 * @param {{ role: object, healthCheck: object|null, onSave: function, onRevalidate: function }} props
 */
export function RoleEditor({ role, healthCheck, onSave, onRevalidate }) {
  const [model, setModel] = useState(role.model);
  const [systemPrompt, setSystemPrompt] = useState(role.systemPrompt);
  const [healthCheckPrompt, setHealthCheckPrompt] = useState(role.healthCheckPrompt);
  const [name, setName] = useState(role.name);
  const [dirty, setDirty] = useState(false);

  const isAvailable = healthCheck && healthCheck.available;

  const handleSave = () => {
    onSave({
      id: role.id,
      name,
      model,
      systemPrompt,
      healthCheckPrompt,
    });
    setDirty(false);
  };

  const markDirty = (setter) => (value) => {
    setter(value);
    setDirty(true);
  };

  return h("div", { className: "role-card" },
    // ヘッダー
    h("div", { className: "role-header" },
      h("span", { className: "role-id" }, role.id),
      h("span", { className: "role-name" }, "\u2014"),
      h("input", {
        type: "text",
        value: name,
        onChange: (e) => markDirty(setName)(e.target.value),
        style: {
          background: "transparent",
          border: "none",
          color: "var(--text-primary)",
          fontSize: "16px",
          fontWeight: 600,
          outline: "none",
          flex: 1,
        },
      }),
      h("span", {
        className: `role-availability ${isAvailable ? "available" : "unavailable"}`,
      }, isAvailable ? "\u2705 利用可能" : "\u274C 利用不可"),
    ),

    // モデル
    h("div", { className: "role-field" },
      h("label", { className: "role-field-label" }, "モデル"),
      h("input", {
        type: "text",
        value: model,
        onChange: (e) => markDirty(setModel)(e.target.value),
      }),
    ),

    // システムプロンプト
    h("div", { className: "role-field" },
      h("label", { className: "role-field-label" }, "システムプロンプト"),
      h("textarea", {
        value: systemPrompt,
        onChange: (e) => markDirty(setSystemPrompt)(e.target.value),
        rows: 4,
      }),
    ),

    // ヘルスチェックプロンプト
    h("div", { className: "role-field" },
      h("label", { className: "role-field-label" }, "ヘルスチェックプロンプト"),
      h("input", {
        type: "text",
        value: healthCheckPrompt,
        onChange: (e) => markDirty(setHealthCheckPrompt)(e.target.value),
      }),
    ),

    // ヘルスチェック情報
    healthCheck ? h("div", { style: { fontSize: "12px", color: "var(--text-secondary)", marginBottom: "12px" } },
      healthCheck.modelValidation
        ? h("div", null,
            `モデル検証: ${healthCheck.modelValidation.status}`,
            healthCheck.modelValidation.message ? ` - ${healthCheck.modelValidation.message}` : "",
          )
        : null,
      healthCheck.healthCheck
        ? h("div", null,
            `ヘルスチェック: ${healthCheck.healthCheck.status}`,
            healthCheck.healthCheck.responseTime_ms != null
              ? ` (${(healthCheck.healthCheck.responseTime_ms / 1000).toFixed(1)}s)`
              : "",
          )
        : null,
    ) : null,

    // アクションボタン
    h("div", { className: "role-actions" },
      h("button", {
        className: `btn btn-primary`,
        onClick: handleSave,
        disabled: !dirty,
        style: { opacity: dirty ? 1 : 0.5 },
      }, "保存"),
      h("button", {
        className: "btn",
        onClick: () => onRevalidate(role.id),
      }, "モデル再検証"),
    ),
  );
}
