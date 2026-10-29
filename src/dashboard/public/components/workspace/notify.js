// ============================================================
// ブラウザ通知（Notification API）
// ============================================================
// 許可済みのときだけ通知する。未許可（default）なら、パネルに許可ボタンを出す。

import { createElement as h, useState } from "react";

const notified = new Set();

const supported = () => typeof window !== "undefined" && typeof Notification !== "undefined";

/** 同じ key では 1 回だけ通知する（画面遷移で再マウントされても重複しない） */
export function notifyOnce(key, title, body) {
  if (!supported() || Notification.permission !== "granted") return;
  if (notified.has(key)) return;
  notified.add(key);
  try {
    new Notification(title, { body });
  } catch {
    // 通知に失敗しても画面の操作には影響しない
  }
}

/** 通知が未許可のときだけ表示する許可ボタン */
export function NotifyPermission() {
  const [perm, setPerm] = useState(supported() ? Notification.permission : "unsupported");
  if (perm !== "default") return null;
  return h("button", {
    className: "wbtn sm",
    onClick: () => {
      Notification.requestPermission().then((p) => setPerm(p)).catch(() => setPerm("denied"));
    },
  }, "🔔 通知を許可");
}
