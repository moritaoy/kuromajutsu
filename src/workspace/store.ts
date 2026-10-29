// ============================================================
// Workspace ストア（docs/spec.md §13.12）
//
// ファイル（`<rootDir>/workspaces/<id>/workspace.json`）に保存し、メモリにもキャッシュする。
// 保存したレビュー資料や Workspace の自動削除は行わない。
// ============================================================

import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Workspace } from "../types/index.js";
import { generateWorkspaceId } from "./plan.js";

const WORKSPACE_FILE = "workspace.json";
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const STATUSES: ReadonlySet<string> = new Set([
  "planning",
  "review",
  "running",
  "waiting_human",
  "done",
  "failed",
  "aborted",
]);

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 読み込んだ JSON の最低限の形を検証する。問題があればその説明、なければ undefined */
function validateShape(raw: unknown, dirName: string): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "オブジェクトではありません";
  const o = raw as Record<string, unknown>;
  if (typeof o["id"] !== "string") return "id がありません";
  if (!ID_PATTERN.test(o["id"])) return `id が不正です: ${o["id"]}`;
  if (o["id"] !== dirName) return `id がディレクトリ名と一致しません: ${o["id"]}`;
  if (typeof o["status"] !== "string" || !STATUSES.has(o["status"])) return "status が不正です";
  if (!Array.isArray(o["revisions"])) return "revisions が配列ではありません";
  return undefined;
}

export class WorkspaceStore extends EventEmitter {
  private readonly cache = new Map<string, Workspace>();

  /**
   * @param rootDir `workspaces/` の親ディレクトリ（実運用は `resolve(process.cwd(), ".kuromajutsu")`）
   */
  constructor(private readonly rootDir: string) {
    super();
  }

  // ----------------------------------------------------
  // パス
  // ----------------------------------------------------

  /** Workspace のディレクトリ。ID にパス区切り等を含む場合は Error */
  workspaceDir(id: string): string {
    if (!ID_PATTERN.test(id)) {
      throw new Error(`不正な Workspace ID です: ${id}`);
    }
    return join(this.rootDir, "workspaces", id);
  }

  /** レビュー資料のディレクトリ（なければ作成する） */
  reviewsDir(id: string): string {
    const dir = join(this.workspaceDir(id), "reviews");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ----------------------------------------------------
  // CRUD
  // ----------------------------------------------------

  create(input: { instruction: string; workspacePath: string }): Workspace {
    let id = generateWorkspaceId();
    while (this.cache.has(id) || existsSync(this.workspaceDir(id))) {
      id = generateWorkspaceId();
    }
    const now = new Date().toISOString();
    const ws: Workspace = {
      id,
      instruction: input.instruction,
      workspacePath: input.workspacePath,
      status: "planning",
      revisions: [],
      gateResults: [],
      humanReviews: [],
      gateChanges: [],
      createdAt: now,
      updatedAt: now,
    };
    this.save(ws);
    this.emit("workspace:created", ws);
    return ws;
  }

  get(id: string): Workspace | undefined {
    return this.cache.get(id);
  }

  /** `createdAt` の降順 */
  list(): Workspace[] {
    return [...this.cache.values()].sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
    );
  }

  /**
   * 複製に mutator を適用し、`updatedAt` を更新して保存・キャッシュ更新し、
   * `workspace:updated` を emit する（複製を渡す）。
   * mutator や保存が例外を投げた場合、キャッシュもディスクも変わらない。
   * 以前に取得した参照は更新されないので、更新後は戻り値または `get` を使うこと。
   */
  update(id: string, mutator: (ws: Workspace) => void): Workspace {
    const current = this.cache.get(id);
    if (!current) {
      throw new Error(`Workspace が見つかりません: ${id}`);
    }
    const next = structuredClone(current);
    mutator(next);
    next.updatedAt = new Date().toISOString();
    this.save(next);
    this.emit("workspace:updated", structuredClone(next));
    return next;
  }

  /** 保存してキャッシュする（`updatedAt` の更新や emit はしない） */
  save(ws: Workspace): void {
    const dir = this.workspaceDir(ws.id);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, WORKSPACE_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(ws, null, 2), "utf-8");
    renameSync(tmp, file);
    this.cache.set(ws.id, ws);
  }

  // ----------------------------------------------------
  // 起動時の復元（§13.12）
  // ----------------------------------------------------

  /**
   * 全 Workspace をファイルから読み込む。
   * Orchestrator のプロセスと Magentic グループは失われているため、状態を次のとおり補正する。
   *
   * - `running` / `waiting_human` → `failed`（`server_restart`）
   * - `planning` → `revisions` があれば `review`、なければ `failed`（`server_restart`）
   * - それ以外はそのまま
   */
  loadAll(): Workspace[] {
    const base = join(this.rootDir, "workspaces");
    if (!existsSync(base)) return [];

    this.cache.clear();
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(base, entry.name, WORKSPACE_FILE);
      if (!existsSync(file)) continue;

      const ws = this.readWorkspace(file, entry.name);
      if (!ws) continue;

      this.cache.set(ws.id, ws);
      if (this.recoverAfterRestart(ws)) {
        ws.updatedAt = new Date().toISOString();
        try {
          this.save(ws);
        } catch (e) {
          console.warn(
            `[workspace] ${ws.id} の復旧結果を保存できませんでした（メモリ上は補正済み）: ${errMessage(e)}`,
          );
        }
      }
    }
    return this.list();
  }

  /** workspace.json を読み、最低限の形を検証する。不正なら警告して undefined */
  private readWorkspace(file: string, dirName: string): Workspace | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf-8"));
    } catch (e) {
      console.warn(`[workspace] ${file} を読み込めません。スキップします: ${errMessage(e)}`);
      return undefined;
    }
    const problem = validateShape(raw, dirName);
    if (problem) {
      console.warn(`[workspace] ${file} は不正です（${problem}）。スキップします`);
      return undefined;
    }
    return raw as Workspace;
  }

  /** 再起動時の状態補正。変更したら true */
  private recoverAfterRestart(ws: Workspace): boolean {
    const restart = { code: "server_restart" as const, message: "サーバー再起動" };
    switch (ws.status) {
      case "running":
      case "waiting_human":
        ws.status = "failed";
        ws.statusReason = restart;
        return true;
      case "planning":
        if (ws.revisions.length > 0) {
          ws.status = "review";
          delete ws.statusReason;
        } else {
          ws.status = "failed";
          ws.statusReason = restart;
        }
        return true;
      default:
        return false;
    }
  }
}
