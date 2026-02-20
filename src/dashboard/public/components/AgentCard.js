// ============================================================
// AgentCard — Agent ステータスカード
// ============================================================

import { createElement as h, useState, useEffect } from "react";

/**
 * 経過時間をフォーマット（MM:SS）
 */
function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const sec = String(totalSec % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

/**
 * ツール名を短縮表示用に変換
 * e.g. "editToolCall" → "Edit", "readToolCall" → "Read"
 */
function shortenToolName(rawName) {
  if (!rawName) return "";
  const name = rawName.replace(/ToolCall$/i, "").replace(/Tool$/i, "");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * 詳細モーダル
 * @param {{ agent: object, onClose: function }} props
 */
function AgentDetailModal({ agent, onClose }) {
  // ESC キーで閉じる
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return h("div", {
    className: "modal-overlay",
    onClick: (e) => {
      // オーバーレイ部分クリックで閉じる
      if (e.target === e.currentTarget) onClose();
    },
  },
    h("div", { className: "modal-content" },
      // ヘッダー
      h("div", { className: "modal-header" },
        h("div", { className: "modal-title-row" },
          h("span", { className: `status-dot ${agent.status}` }),
          h("span", { className: "modal-agent-id" }, agent.agentId),
          h("span", { className: `role-badge role-badge-${agent.role}` }, agent.role),
        ),
        h("button", {
          className: "modal-close",
          onClick: onClose,
        }, "\u2715"),
      ),
      // プロンプト
      h("div", { className: "modal-section" },
        h("div", { className: "modal-section-label" }, "Prompt"),
        h("div", { className: "modal-section-body modal-prompt" },
          agent.prompt || "(プロンプトなし)",
        ),
      ),
      // サマリ（result がある場合）
      agent.result
        ? h("div", { className: "modal-section" },
            h("div", { className: "modal-section-label" }, "Summary"),
            h("div", { className: "modal-section-body modal-summary" },
              agent.result.summary || "(サマリなし)",
            ),
          )
        : null,
      // レスポンス（result.response がある場合、折りたたみ式）
      agent.result && agent.result.response
        ? h("div", { className: "modal-section" },
            h("details", { className: "modal-response-details" },
              h("summary", { className: "modal-response-toggle" }, "Response（詳細レポート）"),
              h("div", { className: "modal-section-body modal-response" },
                agent.result.response,
              ),
            ),
          )
        : null,
      // 最新アシスタントメッセージ（result がない場合のフォールバック）
      !agent.result && agent.lastAssistantMessage
        ? h("div", { className: "modal-section" },
            h("div", { className: "modal-section-label" }, "Latest Message"),
            h("div", { className: "modal-section-body modal-summary" },
              agent.lastAssistantMessage,
            ),
          )
        : null,
    ),
  );
}

/**
 * @param {{ agent: object }} props
 */
export function AgentCard({ agent }) {
  const [elapsed, setElapsed] = useState(agent.elapsed_ms || 0);
  const [showModal, setShowModal] = useState(false);

  // running 状態のときはカウントアップ
  useEffect(() => {
    if (agent.status !== "running") {
      setElapsed(agent.elapsed_ms || 0);
      return;
    }

    const startTime = new Date(agent.startedAt).getTime();
    const tick = () => {
      setElapsed(Date.now() - startTime);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [agent.status, agent.startedAt, agent.elapsed_ms]);

  const statusClass = `status-${agent.status}`;

  return h("div", null,
    h("div", {
      className: `agent-card ${statusClass}`,
      onClick: () => setShowModal(true),
      style: { cursor: "pointer" },
    },
      // ヘッダー: ステータスドット + Agent ID + Stage ラベル（あれば）+ 職種バッジ
      h("div", { className: "agent-card-header" },
        h("span", { className: `status-dot ${agent.status}` }),
        h("span", { className: "agent-id" }, agent.agentId),
        agent.stageIndex != null
          ? h("span", { className: "agent-stage-label" }, `Stage ${agent.stageIndex + 1}`)
          : null,
        h("span", { className: `role-badge role-badge-${agent.role}` }, agent.role),
      ),
      // ボディ: 経過時間 + ツール活動表示
      h("div", { className: "agent-card-body" },
        h("span", { className: "agent-elapsed" },
          formatElapsed(elapsed),
          agent.status === "running" ? " \u25B6" : "",
        ),
        agent.toolCallCount > 0
          ? h("span", { className: "agent-activity" },
              agent.status === "running" && agent.recentToolCalls && agent.recentToolCalls.length > 0
                ? h("span", { className: "agent-tool-name" },
                    shortenToolName(agent.recentToolCalls[agent.recentToolCalls.length - 1].type),
                  )
                : null,
              h("span", { className: "agent-step-count" },
                `Step ${agent.toolCallCount}`,
              ),
            )
          : null,
      ),
    ),
    // モーダル
    showModal
      ? h(AgentDetailModal, {
          agent,
          onClose: () => setShowModal(false),
        })
      : null,
  );
}
