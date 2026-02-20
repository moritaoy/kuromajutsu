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
  GroupMode,
  HealthCheckResult,
  AppConfig,
  RoleDefinition,
  TaskDefinition,
  StageDefinition,
  SequentialPlan,
  MagenticConfig,
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

/** 削除済みグループに残す履歴 Agent の最大件数 */
const MAX_HISTORY_AGENTS = 20;

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

  /** Sequential 実行計画: groupId → SequentialPlan */
  private sequentialPlans: Map<string, SequentialPlan>;

  /** Magentic 実行設定: groupId → MagenticConfig */
  private magenticConfigs: Map<string, MagenticConfig>;

  /** AgentExecutor インスタンス（内部保持） */
  private executor: AgentExecutor;

  constructor(private config: AppConfig) {
    super();
    this.groups = new Map();
    this.agents = new Map();
    this.healthCheckResults = new Map();
    this.availableModels = [];
    this.waitResolvers = new Map();
    this.sequentialPlans = new Map();
    this.magenticConfigs = new Map();
    this.executor = new AgentExecutor();
  }

  // ==================================================
  // Group 管理
  // ==================================================

  /** グループを作成し Map に登録する */
  createGroup(
    description: string,
    mode: GroupMode = "concurrent",
    parentGroupId?: string,
  ): GroupDefinition {
    const group: GroupDefinition = {
      id: this.generateGroupId(),
      description,
      status: "active",
      mode,
      createdAt: new Date().toISOString(),
      agentIds: [],
      parentGroupId,
    };

    this.groups.set(group.id, group);
    this.emit("group:created", group);
    return group;
  }

  /** グループを取得する（存在しなければ undefined） */
  getGroup(groupId: string): GroupDefinition | undefined {
    return this.groups.get(groupId);
  }

  /** グループを削除する（status を "deleted" に変更、完了済み Agent は履歴として保持） */
  deleteGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) {
      throw new Error(`グループが見つかりません: ${groupId}`);
    }
    if (group.status === "deleted") {
      throw new Error(`グループは既に削除されています: ${groupId}`);
    }

    // Magentic グループの場合、子グループ（parentGroupId が一致する）を連鎖的に削除
    if (group.mode === "magentic") {
      const childGroups = Array.from(this.groups.values()).filter(
        (g) => g.parentGroupId === groupId && g.status === "active",
      );
      for (const child of childGroups) {
        this.deleteGroup(child.id);
      }
    }

    group.status = "deleted";
    this.sequentialPlans.delete(groupId);
    this.magenticConfigs.delete(groupId);

    this.trimDeletedGroupAgents(MAX_HISTORY_AGENTS);

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

  /** Magentic 設定を登録する */
  setMagenticConfig(groupId: string, config: MagenticConfig): void {
    this.magenticConfigs.set(groupId, config);
  }

  /** Magentic 設定を取得する */
  getMagenticConfig(groupId: string): MagenticConfig | undefined {
    return this.magenticConfigs.get(groupId);
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
    options?: {
      workingDirectory?: string;
      timeout_ms?: number;
      /** 指定時は buildFullPrompt をスキップし、この文字列をそのまま使用（Magentic Orchestrator 用） */
      prebuiltFullPrompt?: string;
    },
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
    const fullPrompt =
      options?.prebuiltFullPrompt ??
      this.buildFullPrompt(role, agentId, groupId, prompt);
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

  /**
   * 複数の Agent を一括起動する（Concurrent モード用）。
   * 全 Agent の起動を試み、結果を配列で返す。
   */
  startAgents(
    groupId: string,
    tasks: TaskDefinition[],
  ): AgentState[] {
    const group = this.groups.get(groupId);
    if (!group) {
      throw new Error(`グループが見つかりません: ${groupId}`);
    }
    if (group.status !== "active") {
      throw new Error(`グループがアクティブではありません: ${groupId}`);
    }
    if (group.mode !== "concurrent") {
      throw new Error(`グループのモードが concurrent ではありません: ${group.mode}`);
    }

    const running = this.getRunningCount();
    if (running + tasks.length > this.config.agent.maxConcurrent) {
      throw new Error(
        `maxConcurrent (${this.config.agent.maxConcurrent}) を超えます。現在 ${running} Agent 実行中、${tasks.length} 台の起動を要求。`,
      );
    }

    const results: AgentState[] = [];
    for (const task of tasks) {
      const roleDef = this.config.roles.find((r) => r.id === task.role);
      if (!roleDef) {
        throw new Error(`職種 '${task.role}' が見つかりません`);
      }
      const agent = this.startAgent(groupId, roleDef, task.prompt, {
        workingDirectory: task.workingDirectory,
        timeout_ms: task.timeout_ms,
      });
      results.push(agent);
    }
    return results;
  }

  /**
   * Sequential 実行計画を投入する。
   * 全ステージの全 Agent を queued で登録し、Stage 0 の Agent のみ起動する。
   */
  submitSequential(
    groupId: string,
    stages: StageDefinition[],
  ): { plan: SequentialPlan; agents: AgentState[] } {
    const group = this.groups.get(groupId);
    if (!group) {
      throw new Error(`グループが見つかりません: ${groupId}`);
    }
    if (group.status !== "active") {
      throw new Error(`グループがアクティブではありません: ${groupId}`);
    }
    if (group.mode !== "sequential") {
      throw new Error(`グループのモードが sequential ではありません: ${group.mode}`);
    }
    if (this.sequentialPlans.has(groupId)) {
      throw new Error(`グループ '${groupId}' には既に実行計画が登録されています`);
    }

    const maxStageTasks = Math.max(...stages.map((s) => s.tasks.length));
    const running = this.getRunningCount();
    if (running + maxStageTasks > this.config.agent.maxConcurrent) {
      throw new Error(
        `最大ステージのタスク数 (${maxStageTasks}) が maxConcurrent (${this.config.agent.maxConcurrent}) の残枠 (${this.config.agent.maxConcurrent - running}) を超えます`,
      );
    }

    const plan: SequentialPlan = {
      stages: [],
      currentStageIndex: -1,
    };
    const allAgents: AgentState[] = [];

    for (let si = 0; si < stages.length; si++) {
      const stageAgentIds: string[] = [];
      for (const task of stages[si].tasks) {
        const roleDef = this.config.roles.find((r) => r.id === task.role);
        if (!roleDef) {
          throw new Error(`職種 '${task.role}' が見つかりません`);
        }

        const agentId = this.generateAgentId(roleDef.id);
        const now = new Date().toISOString();

        const agent: AgentState = {
          agentId,
          groupId,
          role: roleDef.id,
          model: roleDef.model,
          status: "queued",
          startedAt: now,
          elapsed_ms: 0,
          toolCallCount: 0,
          recentToolCalls: [],
          result: null,
          prompt: task.prompt,
          editedFiles: [],
          createdFiles: [],
          stageIndex: si,
          workingDirectory: task.workingDirectory,
          timeout_ms: task.timeout_ms,
        };

        this.agents.set(agentId, agent);
        group.agentIds.push(agentId);
        stageAgentIds.push(agentId);
        allAgents.push(agent);
        this.emit("agent:created", agent);
      }
      plan.stages.push({ stageIndex: si, agentIds: stageAgentIds });
    }

    this.sequentialPlans.set(groupId, plan);

    // Stage 0 を起動
    this.advanceSequentialStage(groupId);

    return { plan, agents: allAgents };
  }

  /** Sequential 実行計画を取得する */
  getSequentialPlan(groupId: string): SequentialPlan | undefined {
    return this.sequentialPlans.get(groupId);
  }

  /**
   * Magentic グループの Orchestrator Agent を起動する。
   * run_magentic ツールから呼ばれる。
   * orchestratorAgentId の設定と group:updated イベント発行を一元管理する。
   */
  startMagenticOrchestrator(
    groupId: string,
    orchestratorRole: RoleDefinition,
    prompt: string,
    options?: { timeout_ms?: number },
  ): AgentState {
    const group = this.groups.get(groupId);
    if (!group) {
      throw new Error(`グループが見つかりません: ${groupId}`);
    }
    if (group.status !== "active") {
      throw new Error(`グループがアクティブではありません: ${groupId}`);
    }
    if (group.mode !== "magentic") {
      throw new Error(`グループのモードが magentic ではありません: ${group.mode}`);
    }

    const agent = this.startAgent(groupId, orchestratorRole, prompt, {
      timeout_ms: options?.timeout_ms,
    });

    group.orchestratorAgentId = agent.agentId;
    this.emit("group:updated", group);
    return agent;
  }

  /**
   * Orchestrator 用の 7 層プロンプトを構築する。
   */
  buildMagenticOrchestratorPrompt(
    role: RoleDefinition,
    agentId: string,
    groupId: string,
    config: MagenticConfig,
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
      `summary: "実行結果の要約（1-2文で簡潔に）"`,
      `response: "実行結果の詳細レポート（下記ガイドライン参照）"`,
      `editedFiles: ["編集したファイルパスの配列"]  // 省略可`,
      `createdFiles: ["新規作成したファイルパスの配列"]  // 省略可`,
      `errorMessage: "エラーメッセージ"  // 失敗時のみ`,
      "```",
      "",
      `**response のガイドライン:**`,
      `response は生の実行ログではなく、実行結果を適切にまとめた構造化レポートです。`,
      `メイン Agent や人間が読んで内容を正確に把握できるよう、以下を整理して記載してください:`,
      `- 何を実施したか（実施内容）`,
      `- 結果どうなったか（成果・変更点）`,
      `- 判断や選択の理由（なぜそうしたか）`,
      `- 注意点・懸念事項（あれば）`,
      `- 次のステップへの申し送り事項（あれば）`,
      "",
      `report_result を呼ばないとメイン Agent が結果を受け取れません。タスクの成否に関わらず必ず呼び出してください。`,
      "---",
    ].join("\n");

    const toolGuideBlock = [
      "",
      "---",
      "【Orchestrator ツール使用ガイド】",
      "",
      "あなたは以下の kuromajutsu MCP ツールを使用してサブ Agent を管理できます:",
      "",
      "- **create_group**: 子グループを作成する。必ず parentGroupId にこのグループの ID を指定すること。",
      "- **run_agents**: 子グループ内で Agent を一括起動する。",
      "- **wait_agent**: 指定した Agent の完了を待機する。",
      "- **get_agent_status**: Agent の状態を取得する。",
      "- **list_agents**: Agent 一覧を取得する。",
      "- **delete_group**: グループを削除する。",
      "",
      "---",
    ].join("\n");

    const taskBlock = [
      "",
      "---",
      "【タスク定義】",
      "",
      config.task,
      "",
      "---",
    ].join("\n");

    const completionBlock = [
      "",
      "---",
      "【完了条件】",
      "",
      config.completionCriteria,
      "",
      "---",
    ].join("\n");

    const scopeParts: string[] = [config.scope];
    if (config.constraints) {
      scopeParts.push(`制約: ${config.constraints}`);
    }
    if (config.context) {
      scopeParts.push(`補足コンテキスト: ${config.context}`);
    }
    const scopeBlock = [
      "",
      "---",
      "【操作範囲・制約】",
      "",
      scopeParts.join("\n\n"),
      "",
      "---",
    ].join("\n");

    const roleInfos = config.availableRoles.map((roleId) => {
      const r = this.config.roles.find((x) => x.id === roleId);
      return r
        ? `- ${r.id}: ${r.name} — ${r.description}`
        : `- ${roleId}: (未定義)`;
    });
    const paramsBlock = [
      "",
      "---",
      "【実行パラメータ】",
      "",
      "利用可能な職種:",
      ...roleInfos,
      "",
      `最大反復回数: ${config.maxIterations}`,
      "",
      "---",
    ].join("\n");

    return [
      role.systemPrompt,
      metadataBlock,
      toolGuideBlock,
      taskBlock,
      completionBlock,
      scopeBlock,
      paramsBlock,
    ].join("\n\n");
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
      response: string;
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
      response: reportData.response,
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

  /**
   * 削除済みグループの Agent を maxHistory 件に制限する。
   * 古い Agent から削除し、Agent がなくなった削除済みグループも除去する。
   */
  private trimDeletedGroupAgents(maxHistory: number): void {
    const deletedGroupIds = new Set(
      Array.from(this.groups.values())
        .filter((g) => g.status === "deleted")
        .map((g) => g.id),
    );

    const historyAgents = Array.from(this.agents.values())
      .filter((a) => deletedGroupIds.has(a.groupId))
      .sort(
        (a, b) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      );

    if (historyAgents.length > maxHistory) {
      const toRemove = historyAgents.slice(maxHistory);
      for (const agent of toRemove) {
        this.agents.delete(agent.agentId);
      }
    }

    for (const groupId of deletedGroupIds) {
      const hasAgents = Array.from(this.agents.values()).some(
        (a) => a.groupId === groupId,
      );
      if (!hasAgents) {
        this.groups.delete(groupId);
      }
    }
  }

  /** 状態遷移が有効かを判定する */
  private isValidTransition(
    from: AgentStatus,
    to: AgentStatus,
  ): boolean {
    return VALID_TRANSITIONS[from]?.includes(to) ?? false;
  }

  /** Agent の完了処理（waitResolvers の resolve、イベント通知、Sequential ステージ進行） */
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

    // Sequential グループの場合、ステージ進行を試みる
    const group = this.groups.get(agent.groupId);
    if (group?.mode === "sequential") {
      this.advanceSequentialStage(agent.groupId);
    }
  }

  /**
   * Sequential ステージを進行させる。
   * - currentStageIndex === -1 の場合: Stage 0 を起動
   * - 現ステージの全 Agent が完了系の場合: 次ステージを起動
   */
  private advanceSequentialStage(groupId: string): void {
    const plan = this.sequentialPlans.get(groupId);
    if (!plan) return;

    // 初回起動 (currentStageIndex === -1)
    if (plan.currentStageIndex === -1) {
      plan.currentStageIndex = 0;
      const firstStage = plan.stages[0];
      if (!firstStage) return;
      for (const agentId of firstStage.agentIds) {
        this.launchQueuedAgent(agentId);
      }
      this.emit("group:stage_advanced", {
        groupId,
        stageIndex: 0,
        totalStages: plan.stages.length,
      });
      return;
    }

    // 現ステージの全 Agent が完了しているか確認
    const currentStage = plan.stages[plan.currentStageIndex];
    if (!currentStage) return;

    const allDone = currentStage.agentIds.every((id) => {
      const a = this.agents.get(id);
      return a && DONE_STATUSES.includes(a.status);
    });
    if (!allDone) return;

    // 次のステージへ
    plan.currentStageIndex++;
    if (plan.currentStageIndex >= plan.stages.length) return;

    const nextStage = plan.stages[plan.currentStageIndex];
    const running = this.getRunningCount();
    const nextStageSize = nextStage.agentIds.length;
    if (running + nextStageSize > this.config.agent.maxConcurrent) {
      console.warn(
        `[manager] maxConcurrent 超過のためステージ ${plan.currentStageIndex} の起動を保留 (running=${running}, staged=${nextStageSize}, max=${this.config.agent.maxConcurrent})`,
      );
      plan.currentStageIndex--;
      return;
    }

    // 前ステージの結果を収集
    const previousStageResults = this.collectStageResults(
      currentStage.agentIds,
    );

    // 次ステージの Agent を起動（前ステージ結果をプロンプトに注入）
    for (const agentId of nextStage.agentIds) {
      this.launchQueuedAgent(agentId, previousStageResults);
    }

    this.emit("group:stage_advanced", {
      groupId,
      stageIndex: plan.currentStageIndex,
      totalStages: plan.stages.length,
    });
  }

  /**
   * queued 状態の Agent を実際に起動する。
   * Sequential モードで使用。
   */
  private launchQueuedAgent(
    agentId: string,
    previousStageResults?: AgentResult[],
  ): void {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status !== "queued") return;

    const roleDef = this.config.roles.find((r) => r.id === agent.role);
    if (!roleDef) {
      this.updateAgentState(agentId, { status: "failed" });
      return;
    }

    const fullPrompt = this.buildFullPrompt(
      roleDef,
      agentId,
      agent.groupId,
      agent.prompt ?? "",
      previousStageResults,
    );
    const timeout_ms =
      agent.timeout_ms ?? this.config.agent.defaultTimeout_ms ?? undefined;

    try {
      const pid = this.executor.execute(
        agentId,
        {
          model: roleDef.model,
          prompt: fullPrompt,
          workingDirectory: agent.workingDirectory,
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
      this.updateAgentState(agentId, { status: "failed" });
    }
  }

  /** 指定 Agent ID 群の結果を収集する（前ステージ結果注入用） */
  private collectStageResults(agentIds: string[]): AgentResult[] {
    const results: AgentResult[] = [];
    for (const id of agentIds) {
      const agent = this.agents.get(id);
      if (!agent) continue;

      if (agent.result) {
        results.push(agent.result);
      } else {
        results.push({
          agentId: id,
          groupId: agent.groupId,
          status: agent.status === "completed" ? "success" : "failure",
          summary: agent.lastAssistantMessage ?? "(結果報告なし)",
          response: agent.lastAssistantMessage ?? "(report_result 未呼出)",
          editedFiles: agent.editedFiles,
          createdFiles: agent.createdFiles,
          duration_ms: agent.elapsed_ms,
          model: agent.model,
          role: agent.role,
          toolCallCount: agent.toolCallCount,
          timestamp: new Date().toISOString(),
        });
      }
    }
    return results;
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
          const durationMs = (event.data.duration_ms as number) ?? 0;
          if (DONE_STATUSES.includes(agent.status)) {
            const patch: Partial<AgentState> = { elapsed_ms: durationMs };
            if (agent.result && !agent.result.duration_ms) {
              patch.result = { ...agent.result, duration_ms: durationMs };
            }
            this.updateAgentState(agentId, patch);
          } else {
            this.updateAgentState(agentId, {
              status: "completed",
              elapsed_ms: durationMs,
            });
          }
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
   *   3. ツールブロック（ロールにツールが紐付いている場合）
   *   4. 前ステージ結果ブロック（Sequential モードの Stage 1 以降）
   *   5. ユーザープロンプト
   */
  buildFullPrompt(
    role: RoleDefinition,
    agentId: string,
    groupId: string,
    userPrompt: string,
    previousStageResults?: AgentResult[],
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
      `summary: "実行結果の要約（1-2文で簡潔に）"`,
      `response: "実行結果の詳細レポート（下記ガイドライン参照）"`,
      `editedFiles: ["編集したファイルパスの配列"]  // 省略可`,
      `createdFiles: ["新規作成したファイルパスの配列"]  // 省略可`,
      `errorMessage: "エラーメッセージ"  // 失敗時のみ`,
      "```",
      "",
      `**response のガイドライン:**`,
      `response は生の実行ログではなく、実行結果を適切にまとめた構造化レポートです。`,
      `メイン Agent や人間が読んで内容を正確に把握できるよう、以下を整理して記載してください:`,
      `- 何を実施したか（実施内容）`,
      `- 結果どうなったか（成果・変更点）`,
      `- 判断や選択の理由（なぜそうしたか）`,
      `- 注意点・懸念事項（あれば）`,
      `- 次のステップへの申し送り事項（あれば）`,
      "",
      `report_result を呼ばないとメイン Agent が結果を受け取れません。タスクの成否に関わらず必ず呼び出してください。`,
      "---",
    ].join("\n");

    // ツールブロック（role.tools に定義があれば挿入）
    const toolBlock = buildToolPromptBlock(role.tools ?? []);
    const toolSection = toolBlock ? `\n\n${toolBlock}` : "";

    // 前ステージ結果ブロック（Sequential モード用）
    const prevResultsSection = previousStageResults && previousStageResults.length > 0
      ? `\n\n${this.buildPreviousStageResultsBlock(previousStageResults)}`
      : "";

    return `${role.systemPrompt}\n\n${metadataBlock}${toolSection}${prevResultsSection}\n\n${userPrompt}`;
  }

  /** 前ステージの結果をプロンプト注入用テキストに整形する */
  private buildPreviousStageResultsBlock(results: AgentResult[]): string {
    const lines = [
      "---",
      "【前ステージの実行結果】",
      "",
    ];

    for (const r of results) {
      lines.push(`[Agent: ${r.agentId} (${r.role}) — ${r.status}]`);
      lines.push(`Summary: ${r.summary}`);
      lines.push(`Response:`);
      lines.push(r.response);
      lines.push("");
    }

    lines.push("---");
    return lines.join("\n");
  }
}
