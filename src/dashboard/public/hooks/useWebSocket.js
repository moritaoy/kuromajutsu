// ============================================================
// useWebSocket — WebSocket 接続管理フック
// ============================================================
// 指数バックオフによる自動再接続付き

import { useState, useEffect, useRef, useCallback } from "react";

/**
 * @returns {{ connected: boolean, send: (event: object) => void, onMessage: (handler: function) => void }}
 */
export function useWebSocket() {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const handlersRef = useRef([]);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef(null);

  const connect = useCallback(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}`;

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        reconnectAttemptRef.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          for (const handler of handlersRef.current) {
            handler(data);
          }
        } catch {
          // JSON パース失敗は無視
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        scheduleReconnect();
      };

      ws.onerror = () => {
        // onclose で処理するため何もしない
      };
    } catch {
      scheduleReconnect();
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) return;

    const attempt = reconnectAttemptRef.current;
    // 指数バックオフ: 1s, 2s, 4s, 8s, max 30s
    const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
    reconnectAttemptRef.current = attempt + 1;

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connect();
    }, delay);
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
    };
  }, [connect]);

  const send = useCallback((event) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(event));
    }
  }, []);

  const onMessage = useCallback((handler) => {
    handlersRef.current.push(handler);
    // cleanup
    return () => {
      handlersRef.current = handlersRef.current.filter((h) => h !== handler);
    };
  }, []);

  return { connected, send, onMessage };
}
