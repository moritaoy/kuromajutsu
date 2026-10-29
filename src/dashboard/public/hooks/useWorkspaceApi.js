// ============================================================
// useWorkspaceApi — Workspace HTTP API の薄い fetch ラッパー
// ============================================================
// docs/spec.md §13.9.1。POST は Content-Type: application/json 必須。
// エラーは { status, error, message, issues? } を throw する。

const BASE = "/api/workspaces";

async function request(method, path, body) {
  const init = { method, headers: {} };
  if (method !== "GET") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }

  let res;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch (e) {
    throw { status: 0, error: "NETWORK_ERROR", message: "サーバーに接続できません" };
  }

  let json = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    const err = {
      status: res.status,
      error: (json && json.error) || `HTTP_${res.status}`,
      message: (json && json.message) || `リクエストに失敗しました（HTTP ${res.status}）`,
    };
    if (json && json.issues) err.issues = json.issues;
    throw err;
  }
  return json;
}

const enc = encodeURIComponent;

/** `docFile`（reviews/<file> の相対パス）から `reviews/` を除いた `:file` 部分を返す */
export function reviewFileOf(docFile) {
  return String(docFile || "").replace(/^reviews\//, "");
}

export const workspaceApi = {
  list: () => request("GET", ""),
  get: (id) => request("GET", `/${enc(id)}`),
  create: ({ instruction, workspacePath }) => {
    const body = { instruction };
    if (workspacePath && workspacePath.trim()) body.workspacePath = workspacePath.trim();
    return request("POST", "", body);
  },
  replan: (id, { instruction, targets }) => {
    const body = { instruction };
    if (targets && targets.length > 0) body.targets = targets;
    return request("POST", `/${enc(id)}/replan`, body);
  },
  approve: (id, { maxIterations } = {}) => {
    const body = {};
    if (Number.isFinite(maxIterations)) body.maxIterations = maxIterations;
    return request("POST", `/${enc(id)}/approve`, body);
  },
  review: (id, gateId, { decision, comment, comments }) => {
    const body = { decision };
    if (comment) body.comment = comment;
    if (comments && comments.length > 0) body.comments = comments;
    return request("POST", `/${enc(id)}/gates/${enc(gateId)}/review`, body);
  },
  retry: (id, { instruction } = {}) => {
    const body = {};
    if (instruction && instruction.trim()) body.instruction = instruction;
    return request("POST", `/${enc(id)}/retry`, body);
  },
  ack: (id, gateChangeId) => request("POST", `/${enc(id)}/irregulars/${enc(gateChangeId)}/ack`, {}),
  abort: (id) => request("POST", `/${enc(id)}/abort`, {}),
  /** レビュー資料の URL。`file` は `reviews/` を除いた相対パス（`..` は不可） */
  reviewUrl: (id, file) =>
    `${BASE}/${enc(id)}/reviews/${String(file).split("/").map(enc).join("/")}`,
};

/** コンポーネントから使う入口（モジュール定数なので参照は安定） */
export function useWorkspaceApi() {
  return workspaceApi;
}
