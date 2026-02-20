/**
 * MCP ツール共通のエラーレスポンスを生成する。
 * 全ツールで統一された形式 { error: true, code, message } を返す。
 */
export function errorResponse(code: string, message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: true, code, message }),
      },
    ],
    isError: true as const,
  };
}
