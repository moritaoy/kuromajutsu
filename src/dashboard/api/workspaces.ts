// ============================================================
// Workspace HTTP API（docs/spec.md §13.9.1）
// ============================================================

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import type { PlanTarget, ReviewComment, Workspace } from "../../types/index.js";
import { WorkspaceError, type WorkspaceService } from "../../workspace/service.js";

/** リクエスト body の上限 */
const MAX_BODY_BYTES = 1024 * 1024;

const BASE_PATH = "/api/workspaces";

/** レビュー資料の配信（`GET /:id/reviews/<reviews/ 配下の相対パス>`）。パスは `/` を含みうる */
const REVIEW_FILE_ROUTE = /^\/([^/]+)\/reviews\/(.+)$/;

/**
 * レビュー資料に付ける Content-Security-Policy（§13.6.3）。
 * 資料はダッシュボードの sandbox 付き iframe で表示される。直接開かれても、`sandbox allow-scripts` で
 * 一意のオリジン（ダッシュボードと別オリジン）になり、通信（fetch / フォーム）もできない。
 */
const REVIEW_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src 'self'; form-action 'none'";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// --------------------------------------------------
// レスポンス
// --------------------------------------------------

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: code, message });
}

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_INSTRUCTION: 400,
  INVALID_WORKSPACE_PATH: 400,
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  VALIDATION_FAILED: 422,
  PLANNER_UNAVAILABLE: 503,
  ORCHESTRATOR_UNAVAILABLE: 503,
};

// --------------------------------------------------
// cross-origin 対策
//
// この API は Agent（bypassPermissions）を起動できるため、他サイトのページからの
// リクエストを拒否する。CORS ヘッダーは返さない。
// --------------------------------------------------

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function portOf(hostHeader: string, protocol: string): string {
  const m = /:(\d+)$/.exec(hostHeader);
  return m?.[1] ?? (protocol === "https:" ? "443" : "80");
}

/** `Origin` が `Host` と一致する、または loopback の同ポートのときだけ許可する */
function isAllowedOrigin(origin: string, hostHeader: string | undefined): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = (hostHeader ?? "").trim().toLowerCase();
  if (host !== "" && url.host.toLowerCase() === host) return true;

  if (host !== "" && LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase())) {
    const originPort = url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
    return originPort === portOf(host, url.protocol);
  }
  return false;
}

/** body を読む前に Content-Type が JSON であることを確認する（単純リクエストによる CSRF 対策） */
function requireJsonContentType(req: IncomingMessage): void {
  const contentType = String(req.headers["content-type"] ?? "").trim().toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type は application/json にしてください",
    );
  }
}

// --------------------------------------------------
// body
// --------------------------------------------------

/** リクエストに body があるか（Content-Length が 0 でない、または Transfer-Encoding がある） */
function hasRequestBody(req: IncomingMessage): boolean {
  if (req.headers["transfer-encoding"] !== undefined) return true;
  const length = Number(req.headers["content-length"] ?? 0);
  return Number.isFinite(length) && length > 0;
}

/** JSON オブジェクトの body を読む（空 body は {}）。上限超過は 413、不正は 400 */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    try {
      requireJsonContentType(req);
    } catch (e) {
      req.resume();
      reject(e);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // 保持はやめるが、クライアントがレスポンスを受け取れるよう最後まで読み捨てる
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (tooLarge) {
        reject(new HttpError(413, "PAYLOAD_TOO_LARGE", "リクエスト body が大きすぎます（上限 1 MiB）"));
        return;
      }
      const text = Buffer.concat(chunks).toString("utf-8");
      if (text.trim() === "") {
        resolve({});
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        reject(new HttpError(400, "INVALID_JSON", "リクエスト body が JSON として不正です"));
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        reject(new HttpError(400, "INVALID_REQUEST", "リクエスト body は JSON オブジェクトにしてください"));
        return;
      }
      resolve(parsed as Record<string, unknown>);
    });
  });
}

/**
 * body が省略できる API 用。body が無ければ `{}`、あれば `readJsonBody`（Content-Type を検査する）。
 * body の無い POST で Content-Type を要求しない（Origin の検査は別途行う）。
 */
async function readOptionalJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!hasRequestBody(req)) {
    req.resume();
    return {};
  }
  return readJsonBody(req);
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new HttpError(400, "INVALID_REQUEST", `${key} は必須の文字列です`);
  }
  return v;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    throw new HttpError(400, "INVALID_REQUEST", `${key} は文字列にしてください`);
  }
  return v;
}

/** 正の整数（省略可） */
function optionalPositiveInt(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new HttpError(400, "INVALID_REQUEST", `${key} は 1 以上の整数にしてください`);
  }
  return v;
}

/** `{ sectionId?: string, text: string }[]`（省略可） */
function optionalComments(body: Record<string, unknown>): ReviewComment[] | undefined {
  const v = body["comments"];
  if (v === undefined) return undefined;
  const invalid = () =>
    new HttpError(400, "INVALID_REQUEST", "comments は { sectionId?: string, text: string } の配列にしてください");
  if (!Array.isArray(v)) throw invalid();
  return v.map((c: unknown) => {
    if (typeof c !== "object" || c === null || Array.isArray(c)) throw invalid();
    const { sectionId, text } = c as Record<string, unknown>;
    if (typeof text !== "string" || (sectionId !== undefined && typeof sectionId !== "string")) throw invalid();
    return sectionId !== undefined ? { sectionId, text } : { text };
  });
}

function optionalTargets(body: Record<string, unknown>): PlanTarget[] | undefined {
  const v = body["targets"];
  if (v === undefined) return undefined;
  const invalid = () =>
    new HttpError(
      400,
      "INVALID_REQUEST",
      'targets は { kind: "phase" | "step" | "gate", id: string } の配列にしてください',
    );
  if (!Array.isArray(v)) throw invalid();
  return v.map((t: unknown) => {
    if (typeof t !== "object" || t === null) throw invalid();
    const { kind, id } = t as Record<string, unknown>;
    if ((kind !== "phase" && kind !== "step" && kind !== "gate") || typeof id !== "string" || id === "") {
      throw invalid();
    }
    return { kind, id };
  });
}

// --------------------------------------------------
// ハンドラー
// --------------------------------------------------

/** 一覧用の項目（§13.9.1） */
function summarize(ws: Workspace) {
  return {
    id: ws.id,
    instruction: ws.instruction,
    status: ws.status,
    statusReason: ws.statusReason,
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt,
  };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "INVALID_REQUEST", "パスが不正です");
  }
}

/** レビュー資料のファイルを配信する（HTML は text/html。CSP と nosniff を付ける） */
function sendReviewFile(res: ServerResponse, realPath: string): void {
  const body = readFileSync(realPath);
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(realPath).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Content-Security-Policy": REVIEW_CSP,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/**
 * `/api/workspaces` 配下のリクエストを処理する。
 * 対象外のパスなら何もせず false を返す（呼び出し側が従来の /api/ 応答にフォールバックする）。
 */
export async function handleWorkspaceApi(
  req: IncomingMessage,
  res: ServerResponse,
  service: WorkspaceService,
): Promise<boolean> {
  const rawUrl = req.url ?? "/";
  const path = rawUrl.split("?")[0] ?? "";
  if (path !== BASE_PATH && !path.startsWith(`${BASE_PATH}/`)) return false;

  const method = req.method ?? "GET";
  const rest = path.slice(BASE_PATH.length).replace(/\/+$/, ""); // "" | "/:id" | "/:id/replan" ...

  try {
    const origin = req.headers["origin"];
    if (origin !== undefined && !isAllowedOrigin(String(origin), req.headers["host"])) {
      req.resume();
      throw new HttpError(403, "FORBIDDEN_ORIGIN", "このオリジンからのリクエストは許可されていません");
    }

    // 一覧・作成
    if (rest === "") {
      if (method === "GET") {
        sendJson(res, 200, service.list().map(summarize));
      } else if (method === "POST") {
        const body = await readJsonBody(req);
        const instruction = requireString(body, "instruction");
        const workspacePath = optionalString(body, "workspacePath");
        sendJson(res, 201, service.create({ instruction, workspacePath }));
      } else {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", `${method} は使用できません`);
      }
      return true;
    }

    // レビュー資料の配信（パスに `/` を含むため、セグメント分割の前に処理する）
    const reviewFile = REVIEW_FILE_ROUTE.exec(rest);
    if (reviewFile) {
      if (method !== "GET") {
        req.resume();
        throw new HttpError(405, "METHOD_NOT_ALLOWED", `${method} は使用できません`);
      }
      const id = decodeSegment(reviewFile[1] ?? "");
      const file = decodeSegment(reviewFile[2] ?? "");
      sendReviewFile(res, service.resolveReviewFile(id, file));
      return true;
    }

    const segments = rest.split("/").slice(1).map(decodeSegment); // [":id", ...]
    const id = segments[0] ?? "";

    // 単体
    if (segments.length === 1) {
      if (method !== "GET") {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", `${method} は使用できません`);
      }
      const ws = service.get(id);
      if (!ws) throw new HttpError(404, "NOT_FOUND", `Workspace が見つかりません: ${id}`);
      sendJson(res, 200, { ...ws, validation: service.getValidation(id) });
      return true;
    }

    // 操作
    if (segments.length === 2 && segments[1] === "replan" && method === "POST") {
      const body = await readJsonBody(req);
      const instruction = requireString(body, "instruction");
      const targets = optionalTargets(body);
      sendJson(res, 202, service.replan(id, { instruction, targets }));
      return true;
    }
    if (segments.length === 2 && segments[1] === "abort" && method === "POST") {
      req.resume();
      sendJson(res, 200, service.abort(id));
      return true;
    }
    if (segments.length === 2 && segments[1] === "approve" && method === "POST") {
      const body = await readOptionalJsonBody(req);
      const maxIterations = optionalPositiveInt(body, "maxIterations");
      sendJson(res, 200, service.approve(id, { maxIterations }));
      return true;
    }
    if (segments.length === 4 && segments[1] === "gates" && segments[3] === "review" && method === "POST") {
      const body = await readJsonBody(req);
      const decision = body["decision"];
      if (decision !== "approve" && decision !== "request_changes") {
        throw new HttpError(400, "INVALID_REQUEST", 'decision は "approve" か "request_changes" にしてください');
      }
      const comment = optionalString(body, "comment");
      const comments = optionalComments(body);
      sendJson(res, 200, service.resolveHumanReview(id, segments[2] ?? "", { decision, comment, comments }));
      return true;
    }
    if (segments.length === 2 && segments[1] === "retry" && method === "POST") {
      const body = await readOptionalJsonBody(req);
      const instruction = optionalString(body, "instruction");
      sendJson(res, 200, service.retry(id, { instruction }));
      return true;
    }
    if (segments.length === 4 && segments[1] === "irregulars" && segments[3] === "ack" && method === "POST") {
      req.resume();
      sendJson(res, 200, service.ackIrregular(id, segments[2] ?? ""));
      return true;
    }

    throw new HttpError(404, "NOT_FOUND", "API が見つかりません");
  } catch (err) {
    if (err instanceof HttpError) {
      sendError(res, err.status, err.code, err.message);
    } else if (err instanceof WorkspaceError) {
      const status = STATUS_BY_CODE[err.code] ?? 500;
      if (err.issues) {
        sendJson(res, status, { error: err.code, message: err.message, issues: err.issues });
      } else {
        sendError(res, status, err.code, err.message);
      }
    } else {
      console.error("[dashboard] Workspace API エラー:", err);
      sendError(res, 500, "INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
    }
    return true;
  }
}
