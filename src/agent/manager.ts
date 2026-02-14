// ============================================================
// Agent 実行: ライフサイクル管理
// ============================================================
//
// 責務:
// - Agent / Group のインメモリ管理（Map）
// - Agent ID / Group ID の発番
// - Agent 状態遷移の管理（queued → running → completed/failed/timedOut → resultReported）
// - 同時実行数の制御（maxConcurrent）
// - EventEmitter でイベント通知

import { EventEmitter } from "node:events";
import type {
  AgentState,
  AgentStatus,
  AgentResult,
  GroupDefinition,
  HealthCheckResult,
  AppConfig,
  RoleDefinition,
} from "../types/index.js";
import { AgentExecutor } from "./executor.js";
import { buildToolPromptBlock } from "./tools.js";

// --------------------------------------------------
// 許可される状態遷移マップ
// --------------------------------------------------

const VALID_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  queued: ["running", "failed"],
  running: ["completed", "failed", "timedOut", "resultReported"],
  completed: ["resultReported"],
  failed: ["resultReported"],
  timedOut: ["resultReported"],
  resultReported: [],
};

/** 完了系ステータス */
const DONE_STATUSES: AgentStatus[] = [
  "completed",
  "failed",
  "timedOut",
  "resultReported",
];

// --------------------------------------------------
// AgentManager
// --------------------------------------------------

/**
 * 全 Agent と Group のライフサイクルを管理する中核コンポーネント。
 * インメモリ Map で状態を保持し、EventEmitter パターンで状態変更を外部に通知する。
 */
export class AgentManager extends EventEmitter {
  /** Group 管理テーブル: groupId → GroupDefinition */
  private groups: Map<string, GroupDefinition>;

  /** Agent 管理テーブル: agentId → AgentState */
  private agents: Map<string, AgentState>;

  /** ヘルスチェック結果: roleId → HealthCheckResult */
  private healthCheckResults: Map<string, HealthCheckResult>;

  /** 利用可能モデル一覧（ヘルスチェック時に取得） */
  private availableModels: string[];

  /** Agent 完了待ちの Promise resolver: agentId → resolve[] */
  private waitResolvers: Map<string, Array<() => void>>;

  /** AgentExecutor インスタンス（内部保持） */
  private executor: AgentExecutor;

  constructor(private config: AppConfig) {
    super();
    this.groups = new Map();
    this.agents = new Map();
    this.healthCheckResults = new Map();
    this.availableModels = [];
    this.waitResolvers = new Map();
    this.executor = new AgentExecutor();
  }

  // ==================================================
  // Group 管理
  // ==================================================

  /** グループを作成し Map に登録する */
  createGroup(description: string): GroupDefinition {
    const group: GroupDefinition = {
      id: this.generateGroupId(),
      description,
      status: "active",
      createdAt: new Date().toISOString(),
      agentIds: [],
    };

    this.groups.set(group.id, group);
    this.emit("group:created", group);
    return group;
  }

  /** グループを取得する（存在しなければ undefined） */
  getGroup(groupId: string): GroupDefinition | undefined {
    return this.groups.get(groupId);
  }

  /** グループを削除する（status を "deleted" に変更） */
  deleteGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) {
      throw new Error(`グループが見つかりません: ${groupId}`);
    }
    if (group.status === "deleted") {
      throw new Error(`グループは既に削除されています: ${groupId}`);
    }

    group.status = "deleted";

    // グループに属する Agent のデータも削除する
    for (const agentId of group.agentIds) {
      this.agents.delete(agentId);
    }

    this.emit("group:deleted", { groupId });
  }

  /** 全グループ一覧を取得する */
  listGroups(): GroupDefinition[] {
    return Array.from(this.groups.values());
  }

  /** グループに所属する Agent を取得する */
  getAgentsByGroup(groupId: string): AgentState[] {
    return Array.from(this.agents.values()).filter(
      (a) => a.groupId === groupId,
    );
  }

  // ==================================================
  // Agent 管理
  // ==================================================

  /**
   * Agent を起動し Map に登録する。AgentExecutor にプロセス起動を委譲。
   */
  startAgent(
    groupId: string,
    role: RoleDefinition,
    prompt: string,
    options?: { workingDirectory?: string; timeout_ms?: number },
  ): AgentState {
    // グループの存在・アクティブチェック
    const group = this.groups.get(groupId);
    if (!group) {
      throw new Error(`グループが見つかりません: ${groupId}`);
    }
    if (group.status !== "active") {
      throw new Error(`グループがアクティブではありません: ${groupId}`);
    }

    // 同時実行数チェック
    const running = this.getRunningCount();
    if (running >= this.config.agent.maxConcurrent) {
      throw new Error(
        `maxConcurrent (${this.config.agent.maxConcurrent}) に達しています。現在 ${running} Agent が実行中です。`,
      );
    }

    const agentId = this.generateAgentId(role.id);
    const now = new Date().toISOString();

    const agent: AgentState = {
      agentId,
      groupId,
      role: role.id,
      model: role.model,
      status: "queued",
      startedAt: now,
      elapsed_ms: 0,
      toolCallCount: 0,
      recentToolCalls: [],
      result: null,
      prompt,
      editedFiles: [],
      createdFiles: [],
    };

    // Map に登録
    this.agents.set(agentId, agent);

    // グループに追加
    group.agentIds.push(agentId);

    // イベント通知
    this.emit("agent:created", agent);

    // AgentExecutor でプロセス起動
    const fullPrompt = this.buildFullPrompt(role, agentId, groupId, prompt);
    const timeout_ms =
      options?.timeout_ms ?? this.config.agent.defaultTimeout_ms ?? undefined;

    try {
      const pid = this.executor.execute(
        agentId,
        {
          model: role.model,
          prompt: fullPrompt,
          workingDirectory: options?.workingDirectory,
          timeout_ms,
        },
        {
          onStreamEvent: (event) => {
            this.handleStreamEvent(agentId, event);
          },
          onExit: (exitCode, signal) => {
            this.handleProcessExit(agentId, exitCode, signal);
          },
          onError: (error) => {
            this.handleProcessError(agentId, error);
          },
        },
      );

      agent.pid = pid;
    } catch {
      // spawn 失敗
      agent.status = "failed";
    }

    return agent;
  }

  /** Agent の状態を取得する（存在しなければ undefined） */
  getAgent(agentId: string): AgentState | undefined {
    return this.agents.get(agentId);
  }

  /** フィルタ付き Agent 一覧を取得する */
  listAgents(filter?: {
    groupId?: string;
    status?: string;
  }): AgentState[] {
    let agents = Array.from(this.agents.values());

    if (filter?.groupId) {
      agents = agents.filter((a) => a.groupId === filter.groupId);
    }
    if (filter?.status) {
      agents = agents.filter((a) => a.status === filter.status);
    }

    return agents;
  }

  /** 現在実行中（queued + running）の Agent 数を取得する */
  getRunningCount(): number {
    return Array.from(this.agents.values()).filter(
      (a) => a.status === "queued" || a.status === "running",
    ).length;
  }

  // ==================================================
  // 状態更新
  // ==================================================

  /** Agent の状態を部分更新する（stream-json イベント由来） */
  updateAgentState(agentId: string, partial: Partial<AgentState>): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // ステータス遷移のバリデーション
    if (partial.status && partial.status !== agent.status) {
      if (!this.isValidTransition(agent.status, partial.status)) {
        console.warn(
          `[manager] 不正な状態遷移: ${agent.status} → ${partial.status} (agent=${agentId})`,
        );
        // ステータス以外の更新は適用する
        const { status: _, ...rest } = partial;
        Object.assign(agent, rest);
        this.emit("agent:status_update", { agentId, ...rest });
        return;
      }
    }

    const previousStatus = agent.status;
    Object.assign(agent, partial);

    // イベント通知
    this.emit("agent:status_update", { agentId, ...partial });

    // 完了系ステータスへの遷移時
    if (
      partial.status &&
      DONE_STATUSES.includes(partial.status) &&
      !DONE_STATUSES.includes(previousStatus)
    ) {
      this.handleAgentCompletion(agentId);
    }
  }

  // ==================================================
  // 待機
  // ==================================================

  /**
   * 指定 Agent の完了を待機する（Promise ベース）。
   * @param mode "all" → 全完了で resolve / "any" → いずれか完了で resolve
   * @param timeout_ms タイムアウト（ミリ秒）
   */
  async waitForAgents(
    agentIds: string[],
    mode: "all" | "any" = "all",
    timeout_ms?: number,
  ): Promise<{
    completed: AgentState[];
    pending: AgentState[];
    timedOut: boolean;
  }> {
    // 1. 既に完了している Agent を分離
    const alreadyDone = agentIds.filter((id) => {
      const agent = this.agents.get(id);
      return agent && DONE_STATUSES.includes(agent.status);
    });
    const remaining = agentIds.filter((id) => !alreadyDone.includes(id));

    // 2. mode="any" で既完了があればすぐ返却
    if (mode === "any" && alreadyDone.length > 0) {
      return this.buildWaitResult(agentIds);
    }

    // 3. mode="all" で全完了ならすぐ返却
    if (remaining.length === 0) {
      return this.buildWaitResult(agentIds);
    }

    // 4. 未完了 Agent に対して Promise を作成し waitResolvers に登録
    const promises = remaining.map(
      (id) =>
        new Promise<void>((resolve) => {
          const resolvers = this.waitResolvers.get(id) ?? [];
          resolvers.push(resolve);
          this.waitResolvers.set(id, resolvers);
        }),
    );

    // 5. mode に応じて Promise.all / Promise.race
    const waitPromise =
      mode === "all" ? Promise.all(promises) : Promise.race(promises);

    // 6. timeout_ms があれば Promise.race でタイムアウトと競合
    if (timeout_ms !== undefined) {
      const timeoutPromise = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), timeout_ms),
      );

      const raceResult = await Promise.race([
        waitPromise.then(() => "done" as const),
        timeoutPromise,
      ]);

      if (raceResult === "timeout") {
        return {
          ...this.buildWaitResult(agentIds),
          timedOut: true,
        };
      }
    } else {
      await waitPromise;
    }

    return this.buildWaitResult(agentIds);
  }

  // ==================================================
  // 結果登録
  // ==================================================

  /**
   * 結果を登録し、ステータスを resultReported に更新する。
   * 自動収集データ（stream-json 由来）とマージする。
   */
  reportResult(
    agentId: string,
    reportData: {
      status: "success" | "failure" | "timeout" | "cancelled";
      summary: string;
      editedFiles?: string[];
      createdFiles?: string[];
      errorMessage?: string;
    },
  ): AgentResult {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent が見つかりません: ${agentId}`);
    }

    // running（Agent 自身が実行中に MCP 経由で呼ぶケース）または
    // 完了系ステータスで結果登録を受け付ける
    if (!["running", "completed", "failed", "timedOut"].includes(agent.status)) {
      throw new Error(
        `Agent のステータスが結果登録可能な状態ではありません: ${agent.status} (agent=${agentId})`,
      );
    }

    // 自動収集データと手動レポートをマージ
    const mergedEditedFiles = [
      ...new Set([...agent.editedFiles, ...(reportData.editedFiles ?? [])]),
    ];
    const mergedCreatedFiles = [
      ...new Set([...agent.createdFiles, ...(reportData.createdFiles ?? [])]),
    ];

    const result: AgentResult = {
      agentId,
      groupId: agent.groupId,
      status: reportData.status,
      summary: reportData.summary,
      editedFiles: mergedEditedFiles,
      createdFiles: mergedCreatedFiles,
      duration_ms: agent.elapsed_ms,
      model: agent.model,
      role: agent.role,
      toolCallCount: agent.toolCallCount,
      errorMessage: reportData.errorMessage,
      timestamp: new Date().toISOString(),
    };

    // ステータスを resultReported に遷移
    // updateAgentState を使用して handleAgentCompletion が呼ばれるようにする
    this.updateAgentState(agentId, {
      status: "resultReported",
      result,
    });

    this.emit("agent:result_reported", result);
    return result;
  }

  // ==================================================
  // ヘルスチェック結果管理
  // ==================================================

  /** ヘルスチェック結果を登録する */
  setHealthCheckResults(results: HealthCheckResult[]): void {
    for (const r of results) {
      this.healthCheckResults.set(r.roleId, r);
    }
  }

  /** 特定職種のヘルスチェック結果を取得する */
  getHealthCheckResult(roleId: string): HealthCheckResult | undefined {
    return this.healthCheckResults.get(roleId);
  }

  /** 全職種のヘルスチェック結果を取得する */
  getHealthCheckResults(): HealthCheckResult[] {
    return Array.from(this.healthCheckResults.values());
  }

  /** 利用可能モデル一覧を設定する */
  setAvailableModels(models: string[]): void {
    this.availableModels = [...models];
  }

  /** 利用可能モデル一覧を取得する */
  getAvailableModels(): string[] {
    return this.availableModels;
  }

  // ==================================================
  // 内部メソッド
  // ==================================================

  /** 状態遷移が有効かを判定する */
  private isValidTransition(
    from: AgentStatus,
    to: AgentStatus,
  ): boolean {
    return VALID_TRANSITIONS[from]?.includes(to) ?? false;
  }

  /** Agent の完了処理（waitResolvers の resolve、イベント通知） */
  private handleAgentCompletion(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // agent:completed イベント
    this.emit("agent:completed", agent);

    // waitResolvers を resolve
    const resolvers = this.waitResolvers.get(agentId) ?? [];
    for (const resolve of resolvers) {
      resolve();
    }
    this.waitResolvers.delete(agentId);
  }

  /** stream-json イベントのハンドリング */
  private handleStreamEvent(
    agentId: string,
    event: { type: string; subtype?: string; data: Record<string, unknown> },
  ): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Cursor CLI の stream-json 出力フォーマット:
    //   system:    {"type":"system","subtype":"init","model":"...","cwd":"..."}
    //   user:      {"type":"user","message":{"role":"user","content":[...]}}
    //   thinking:  {"type":"thinking","subtype":"delta"|"completed","text":"..."}
    //   assistant: {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}
    //   tool_call: {"type":"tool_call","subtype":"started"|"completed","call_id":"...","tool_call":{...}}
    //   result:    {"type":"result","subtype":"success","duration_ms":N,...}

    switch (event.type) {
      case "system":
        if (event.subtype === "init") {
          this.updateAgentState(agentId, { status: "running" });
        }
        break;

      case "assistant": {
        // message.content[0].text からテキストを抽出
        const message = event.data.message as
          | { content?: Array<{ text?: string }> }
          | undefined;
        const text = message?.content?.[0]?.text;
        if (text !== undefined) {
          this.updateAgentState(agentId, {
            lastAssistantMessage: text,
          });
        }
        break;
      }

      case "tool_call": {
        // tool_call オブジェクトからツール情報を抽出
        const callId = event.data.call_id as string | undefined;
        const toolCallObj = event.data.tool_call as
          | Record<string, Record<string, unknown>>
          | undefined;

        // ツール名とツール引数を抽出
        // 形式: { "editToolCall": { "args": { "path": "..." } } }
        // または { "readToolCall": { "args": { "path": "..." } } } 等
        const toolEntry = toolCallObj
          ? Object.entries(toolCallObj)[0]
          : undefined;
        const toolName = toolEntry?.[0]; // e.g. "editToolCall"
        const toolDetails = toolEntry?.[1] as
          | { args?: Record<string, unknown>; result?: Record<string, unknown> }
          | undefined;
        const toolArgs = toolDetails?.args;
        const filePath = toolArgs?.path as string | undefined;

        if (event.subtype === "started") {
          this.updateAgentState(agentId, {
            toolCallCount: agent.toolCallCount + 1,
            recentToolCalls: [
              ...agent.recentToolCalls.slice(-9),
              {
                callId: callId ?? "",
                type: toolName ?? event.type,
                subtype: event.subtype ?? "",
                args: toolArgs,
              },
            ],
          });
        } else if (event.subtype === "completed") {
          // ファイル変更の抽出
          // editToolCall はファイル編集（新規作成含む）
          if (filePath && toolName === "editToolCall") {
            // result.success があれば成功
            const result = toolDetails?.result as
              | { success?: Record<string, unknown> }
              | undefined;
            if (result?.success) {
              // linesAdded > 0 かつ linesRemoved === 0 なら新規作成の可能性が高い
              // ただし確実な判定は困難なので、全て editedFiles に追加する
              this.updateAgentState(agentId, {
                editedFiles: [...new Set([...agent.editedFiles, filePath])],
              });
            }
          }
        }
        break;
      }

      case "result":
        if (event.subtype === "success") {
          this.updateAgentState(agentId, {
            status: "completed",
            elapsed_ms: (event.data.duration_ms as number) ?? 0,
          });
        }
        break;

      case "thinking":
        // thinking イベントは無視（デバッグ用途のみ）
        break;
    }
  }

  /** プロセス終了のハンドリング */
  private handleProcessExit(
    agentId: string,
    exitCode: number | null,
    signal: string | null,
  ): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    console.error(
      `[manager] Agent プロセス終了 (${agentId}): exitCode=${exitCode}, signal=${signal}`,
    );

    // 既に完了系ステータスなら何もしない
    if (DONE_STATUSES.includes(agent.status)) return;

    if (exitCode === 0) {
      // result イベント経由で completed になっていなければここで
      if (agent.status !== "completed") {
        this.updateAgentState(agentId, { status: "completed" });
      }
    } else {
      this.updateAgentState(agentId, { status: "failed" });
    }
  }

  /** プロセスエラーのハンドリング */
  private handleProcessError(agentId: string, error: Error): void {
    console.error(`[manager] Agent プロセスエラー (${agentId}):`, error.message);
    const agent = this.agents.get(agentId);
    if (!agent) return;

    if (!DONE_STATUSES.includes(agent.status)) {
      this.updateAgentState(agentId, { status: "failed" });
    }
  }

  /** waitForAgents の結果を構築する */
  private buildWaitResult(agentIds: string[]): {
    completed: AgentState[];
    pending: AgentState[];
    timedOut: boolean;
  } {
    const completed: AgentState[] = [];
    const pending: AgentState[] = [];

    for (const id of agentIds) {
      const agent = this.agents.get(id);
      if (!agent) continue;

      if (DONE_STATUSES.includes(agent.status)) {
        completed.push(agent);
      } else {
        pending.push(agent);
      }
    }

    return { completed, pending, timedOut: false };
  }

  // ==================================================
  // ID 発番
  // ==================================================

  /** Group ID を発番する */
  private generateGroupId(): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const random = Math.random().toString(16).slice(2, 6);
    return `grp-${timestamp}-${random}`;
  }

  /** Agent ID を発番する */
  private generateAgentId(role: string): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const random = Math.random().toString(16).slice(2, 6);
    return `${role}-${timestamp}-${random}`;
  }

  // ==================================================
  // プロンプト構築
  // ==================================================

  /**
   * Agent に渡す最終プロンプトを構築する。
   *
   * 構造:
   *   1. ロールのシステムプロンプト（設定ファイル由来）
   *   2. kuromajutsu メタデータブロック（agentId, groupId, report_result 指示）
   *   3. ユーザープロンプト
   */
  buildFullPrompt(
    role: RoleDefinition,
    agentId: string,
    groupId: string,
    userPrompt: string,
  ): string {
    const metadataBlock = [
      "---",
      "【kuromajutsu システム情報】",
      "",
      `あなたは kuromajutsu Agent 管理システムによって起動されたサブ Agent です。`,
      "",
      `- Agent ID: ${agentId}`,
      `- Group ID: ${groupId}`,
      `- Role: ${role.id}`,
      "",
      `【重要: タスク完了時の結果報告】`,
      `タスクが完了したら、必ず kuromajutsu MCP の \`report_result\` ツールを呼び出して結果を報告してください。`,
      `以下のパラメータを指定してください:`,
      "",
      "```",
      `agentId: "${agentId}"`,
      `status: "success" または "failure"`,
      `summary: "実行結果の要約（何を実施し、どうなったか）"`,
      `editedFiles: ["編集したファイルパスの配列"]  // 省略可`,
      `createdFiles: ["新規作成したファイルパスの配列"]  // 省略可`,
      `errorMessage: "エラーメッセージ"  // 失敗時のみ`,
      "```",
      "",
      `report_result を呼ばないとメイン Agent が結果を受け取れません。タスクの成否に関わらず必ず呼び出してください。`,
      "---",
    ].join("\n");

    // ツールブロック（role.tools に定義があれば挿入）
    const toolBlock = buildToolPromptBlock(role.tools ?? []);
    const toolSection = toolBlock ? `\n\n${toolBlock}` : "";

    return `${role.systemPrompt}\n\n${metadataBlock}${toolSection}\n\n${userPrompt}`;
  }
}
