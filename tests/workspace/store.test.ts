import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../../src/workspace/store.js";
import type { Workspace } from "../../src/types/index.js";
import { makeAuthPlan } from "./fixtures.js";

let root: string;
let store: WorkspaceStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kuromajutsu-ws-"));
  store = new WorkspaceStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const fileOf = (id: string) => join(root, "workspaces", id, "workspace.json");
const readJson = (id: string) => JSON.parse(readFileSync(fileOf(id), "utf-8")) as Workspace;

describe("WorkspaceStore.create", () => {
  it("planning 状態の Workspace を作成して保存する", () => {
    const ws = store.create({ instruction: "認証を追加して", workspacePath: "/tmp/project" });

    expect(ws.id).toMatch(/^ws-\d+-[0-9a-f]{4}$/);
    expect(ws.status).toBe("planning");
    expect(ws.instruction).toBe("認証を追加して");
    expect(ws.workspacePath).toBe("/tmp/project");
    expect(ws.revisions).toEqual([]);
    expect(ws.gateResults).toEqual([]);
    expect(ws.humanReviews).toEqual([]);
    expect(ws.gateChanges).toEqual([]);
    expect(ws.createdAt).toBe(ws.updatedAt);
    expect(Number.isNaN(Date.parse(ws.createdAt))).toBe(false);
    expect(existsSync(fileOf(ws.id))).toBe(true);
    expect(readJson(ws.id)).toEqual(ws);
  });

  it("workspace:created を emit する", () => {
    const listener = vi.fn();
    store.on("workspace:created", listener);
    const ws = store.create({ instruction: "x", workspacePath: "/p" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(ws);
  });

  it("連続して作成しても ID が衝突しない", () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => store.create({ instruction: "x", workspacePath: "/p" }).id),
    );
    expect(ids.size).toBe(50);
  });

  it("一時ファイルを残さない", () => {
    const ws = store.create({ instruction: "x", workspacePath: "/p" });
    expect(readdirSync(join(root, "workspaces", ws.id))).toEqual(["workspace.json"]);
  });
});

describe("WorkspaceStore.get / list", () => {
  it("get は作成した Workspace を返し、なければ undefined", () => {
    const ws = store.create({ instruction: "x", workspacePath: "/p" });
    expect(store.get(ws.id)).toBe(ws);
    expect(store.get("ws-0-0000")).toBeUndefined();
  });

  it("list は createdAt の降順", () => {
    const a = store.create({ instruction: "a", workspacePath: "/p" });
    const b = store.create({ instruction: "b", workspacePath: "/p" });
    const c = store.create({ instruction: "c", workspacePath: "/p" });
    a.createdAt = "2026-01-01T00:00:00.000Z";
    b.createdAt = "2026-01-03T00:00:00.000Z";
    c.createdAt = "2026-01-02T00:00:00.000Z";
    expect(store.list().map((w) => w.instruction)).toEqual(["b", "c", "a"]);
  });

  it("不正な ID（パス区切りを含む）は拒否する", () => {
    expect(store.get("../etc")).toBeUndefined();
    expect(() => store.workspaceDir("../etc")).toThrow();
    expect(() => store.workspaceDir("a/b")).toThrow();
  });
});

describe("WorkspaceStore.update", () => {
  it("mutator で更新し、updatedAt を更新して保存する", async () => {
    const ws = store.create({ instruction: "x", workspacePath: "/p" });
    const before = ws.updatedAt;
    await new Promise((r) => setTimeout(r, 5));

    const updated = store.update(ws.id, (w) => {
      w.status = "review";
      w.revisions.push(makeAuthPlan());
    });

    expect(updated.status).toBe("review");
    expect(updated.updatedAt >= before).toBe(true);
    expect(updated.updatedAt).not.toBe(before);
    expect(store.get(ws.id)?.status).toBe("review");
    const onDisk = readJson(ws.id);
    expect(onDisk.status).toBe("review");
    expect(onDisk.revisions).toHaveLength(1);
    expect(onDisk.updatedAt).toBe(updated.updatedAt);
  });

  it("workspace:updated を emit する", () => {
    const ws = store.create({ instruction: "x", workspacePath: "/p" });
    const listener = vi.fn();
    store.on("workspace:updated", listener);
    store.update(ws.id, (w) => {
      w.status = "failed";
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({ id: ws.id, status: "failed" });
  });

  it("存在しない ID はエラー", () => {
    expect(() => store.update("ws-0-0000", () => {})).toThrow(/見つかりません/);
  });

  it("mutator が例外を投げたらキャッシュもディスクも変えない", () => {
    const ws = store.create({ instruction: "x", workspacePath: "/p" });
    const diskBefore = readFileSync(fileOf(ws.id), "utf-8");
    const listener = vi.fn();
    store.on("workspace:updated", listener);

    expect(() =>
      store.update(ws.id, (w) => {
        w.status = "running";
        w.revisions.push(makeAuthPlan());
        throw new Error("途中で失敗");
      }),
    ).toThrow("途中で失敗");

    const current = store.get(ws.id)!;
    expect(current.status).toBe("planning");
    expect(current.revisions).toEqual([]);
    expect(current.updatedAt).toBe(ws.updatedAt);
    expect(readFileSync(fileOf(ws.id), "utf-8")).toBe(diskBefore);
    expect(listener).not.toHaveBeenCalled();
  });

  it("emit するのは複製で、リスナーが書き換えてもキャッシュに影響しない", () => {
    const ws = store.create({ instruction: "x", workspacePath: "/p" });
    store.on("workspace:updated", (w: Workspace) => {
      w.instruction = "リスナーが改変";
      w.revisions.push(makeAuthPlan());
    });
    const updated = store.update(ws.id, (w) => {
      w.status = "review";
    });
    expect(updated.instruction).toBe("x");
    expect(store.get(ws.id)!.revisions).toEqual([]);
    expect(readJson(ws.id).instruction).toBe("x");
  });

  it("update 後の get / 戻り値は更新後の状態", () => {
    const ws = store.create({ instruction: "x", workspacePath: "/p" });
    const updated = store.update(ws.id, (w) => {
      w.status = "review";
    });
    expect(store.get(ws.id)).toBe(updated);
    expect(updated.status).toBe("review");
  });
});

describe("WorkspaceStore.save", () => {
  it("Workspace を保存する（emit はしない）", () => {
    const ws = store.create({ instruction: "x", workspacePath: "/p" });
    const listener = vi.fn();
    store.on("workspace:updated", listener);
    ws.statusReason = { code: "plan_failed", message: "m" };
    store.save(ws);
    expect(readJson(ws.id).statusReason?.code).toBe("plan_failed");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("ディレクトリ", () => {
  it("workspaceDir は <root>/workspaces/<id>", () => {
    expect(store.workspaceDir("ws-1-abcd")).toBe(join(root, "workspaces", "ws-1-abcd"));
  });

  it("reviewsDir は必要なら作成する", () => {
    const ws = store.create({ instruction: "x", workspacePath: "/p" });
    const dir = store.reviewsDir(ws.id);
    expect(dir).toBe(join(root, "workspaces", ws.id, "reviews"));
    expect(existsSync(dir)).toBe(true);
    expect(store.reviewsDir(ws.id)).toBe(dir); // 2 回目も問題ない
  });
});

describe("WorkspaceStore.loadAll（再起動時の復元。§13.12）", () => {
  function seed(status: Workspace["status"], opts: { revisions?: number; reason?: Workspace["statusReason"] } = {}): string {
    const ws = store.create({ instruction: `i-${status}`, workspacePath: "/p" });
    store.update(ws.id, (w) => {
      w.status = status;
      if (opts.reason) w.statusReason = opts.reason;
      for (let i = 0; i < (opts.revisions ?? 0); i++) w.revisions.push({ ...makeAuthPlan(), revision: i + 1 });
    });
    return ws.id;
  }

  const reload = () => {
    const fresh = new WorkspaceStore(root);
    return { fresh, all: fresh.loadAll() };
  };

  it("running / waiting_human は failed（server_restart）になる", () => {
    const r = seed("running", { revisions: 1 });
    const w = seed("waiting_human", {
      revisions: 1,
      reason: { code: "human_review", gateId: "gate-P1", message: "x" },
    });
    const { fresh } = reload();
    for (const id of [r, w]) {
      const ws = fresh.get(id)!;
      expect(ws.status).toBe("failed");
      expect(ws.statusReason).toEqual({ code: "server_restart", message: "サーバー再起動" });
      expect(readJson(id).status).toBe("failed"); // 保存し直される
    }
  });

  it("planning は revisions があれば review に戻る", () => {
    const id = seed("planning", { revisions: 2 });
    const { fresh } = reload();
    const ws = fresh.get(id)!;
    expect(ws.status).toBe("review");
    expect(ws.statusReason).toBeUndefined();
    expect(ws.revisions).toHaveLength(2);
    expect(readJson(id).status).toBe("review");
  });

  it("planning は revisions がなければ failed（server_restart）", () => {
    const id = seed("planning");
    const { fresh } = reload();
    expect(fresh.get(id)!.status).toBe("failed");
    expect(fresh.get(id)!.statusReason?.code).toBe("server_restart");
  });

  it("review / done / failed / aborted はそのまま", () => {
    const reason = { code: "plan_failed" as const, message: "元の理由" };
    const ids = {
      review: seed("review", { revisions: 1 }),
      done: seed("done", { revisions: 1 }),
      failed: seed("failed", { reason }),
      aborted: seed("aborted", { reason: { code: "user_abort", message: "中断" } }),
    };
    const before = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, readJson(id)]));
    const { fresh } = reload();
    for (const [k, id] of Object.entries(ids)) {
      expect(fresh.get(id)).toEqual(before[k]);
    }
    expect(fresh.get(ids.failed)!.statusReason).toEqual(reason);
  });

  it("変更のないものは書き直さない（updatedAt 不変）", () => {
    const id = seed("done", { revisions: 1 });
    const before = readJson(id).updatedAt;
    const { fresh } = reload();
    expect(fresh.get(id)!.updatedAt).toBe(before);
  });

  it("変更したものは updatedAt が更新される", () => {
    const id = seed("running", { revisions: 1 });
    const before = readJson(id).updatedAt;
    const { fresh } = reload();
    expect(fresh.get(id)!.updatedAt >= before).toBe(true);
  });

  it("createdAt の降順で返す", () => {
    const a = seed("done");
    const b = seed("done");
    store.get(a)!.createdAt = "2026-01-01T00:00:00.000Z";
    store.save(store.get(a)!);
    store.get(b)!.createdAt = "2026-02-01T00:00:00.000Z";
    store.save(store.get(b)!);
    const { all } = reload();
    expect(all.map((w) => w.id)).toEqual([b, a]);
  });

  it("読み込み後は get / list から参照できる", () => {
    const id = seed("done");
    const { fresh } = reload();
    expect(fresh.list().map((w) => w.id)).toEqual([id]);
  });

  it("壊れた workspace.json は警告してスキップする", () => {
    const ok = seed("done");
    const brokenDir = join(root, "workspaces", "ws-1-dead");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "workspace.json"), "{ not json", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { all } = reload();
    expect(all.map((w) => w.id)).toEqual([ok]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  describe("不正な workspace.json の検証", () => {
    const warnSpy = () => vi.spyOn(console, "warn").mockImplementation(() => {});
    const put = (dirName: string, content: unknown) => {
      const dir = join(root, "workspaces", dirName);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "workspace.json"),
        typeof content === "string" ? content : JSON.stringify(content),
        "utf-8",
      );
    };
    const valid = (id: string, over: Partial<Workspace> = {}): Workspace => ({
      id,
      instruction: "x",
      workspacePath: "/p",
      status: "done",
      revisions: [],
      gateResults: [],
      humanReviews: [],
      gateChanges: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...over,
    });

    it.each([
      ["null の JSON", "null"],
      ["配列の JSON", "[]"],
      ["文字列の JSON", '"x"'],
    ])("%s はスキップし、他は読み込む", (_n, content) => {
      const ok = seed("done");
      put("ws-1-bad0", content);
      const warn = warnSpy();
      const { all } = reload();
      expect(all.map((w) => w.id)).toEqual([ok]);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it("revisions が欠落した planning はスキップする（復旧処理で落ちない）", () => {
      const ok = seed("done");
      const { revisions: _r, ...noRevisions } = valid("ws-1-bad1", { status: "planning" });
      put("ws-1-bad1", noRevisions);
      const warn = warnSpy();
      expect(reload().all.map((w) => w.id)).toEqual([ok]);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it("id がパス区切りを含む（../../escape）ものはスキップし、外には書き込まない", () => {
      put("ws-1-bad2", valid("../../escape", { status: "running" }));
      const warn = warnSpy();
      const { all } = reload();
      expect(all).toEqual([]);
      expect(existsSync(join(root, "escape"))).toBe(false);
      expect(existsSync(join(root, "..", "escape"))).toBe(false);
      warn.mockRestore();
    });

    it("ディレクトリ名と id が一致しないものはスキップする", () => {
      put("ws-1-bad3", valid("ws-9-9999"));
      const warn = warnSpy();
      expect(reload().all).toEqual([]);
      warn.mockRestore();
    });

    it("未知の status はスキップする", () => {
      put("ws-1-bad4", valid("ws-1-bad4", { status: "weird" as Workspace["status"] }));
      const warn = warnSpy();
      expect(reload().all).toEqual([]);
      warn.mockRestore();
    });

    it("正しい形の workspace.json は読み込める", () => {
      put("ws-1-good", valid("ws-1-good"));
      expect(reload().all.map((w) => w.id)).toEqual(["ws-1-good"]);
    });

    it("復旧後の保存に失敗しても全体は例外にならない（メモリ上は補正済み）", () => {
      put("ws-1-ro", valid("ws-1-ro", { status: "running" }));
      const fresh = new WorkspaceStore(root);
      const saveSpy = vi.spyOn(fresh, "save").mockImplementation(() => {
        throw new Error("disk full");
      });
      const warn = warnSpy();
      const all = fresh.loadAll();
      expect(all.map((w) => w.id)).toEqual(["ws-1-ro"]);
      expect(fresh.get("ws-1-ro")!.status).toBe("failed");
      expect(warn).toHaveBeenCalled();
      saveSpy.mockRestore();
      warn.mockRestore();
    });
  });

  it("workspace.json のないディレクトリや保存先がない場合も空で返す", () => {
    mkdirSync(join(root, "workspaces", "empty-dir"), { recursive: true });
    expect(new WorkspaceStore(root).loadAll()).toEqual([]);
    expect(new WorkspaceStore(join(root, "nonexistent")).loadAll()).toEqual([]);
  });
});
