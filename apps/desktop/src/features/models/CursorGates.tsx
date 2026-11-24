import { createContext, useContext, type ReactNode } from "react";
import { useAppStore } from "../../shared/store/appStore";
import controls from "../../shared/ui/Controls.module.scss";
import styles from "./CursorSettings.module.scss";

const CaReady = createContext(false);

export function CursorCaProvider({ children }: { children: ReactNode }) {
  const { cursorHarness } = useAppStore();
  return <CaReady.Provider value={cursorHarness?.ca === "ready"}>{children}</CaReady.Provider>;
}

export function CursorCaGate({ busy, waitingForRefresh, onInitialize, onRefresh, children }: { busy: boolean; waitingForRefresh: boolean; onInitialize: () => void; onRefresh: () => void; children: ReactNode }) {
  const ready = useContext(CaReady);
  const { cursorHarness } = useAppStore();
  if (ready) return children;
  const installedLocally = cursorHarness?.ca === "untrusted";
  return <div className={styles.gate}>
    <strong>{installedLocally ? t("需要在系统中信任本地 CA") : t("需要先初始化本地 CA")}</strong>
    <span>{installedLocally ? t("请在终端中粘贴授权命令并输入密码，完成后点击下方按钮") : t("CA 仅保存在本机，用于安全解析 Cursor 的 HTTPS 请求。")}</span>
    <button className={controls.primary} disabled={busy} onClick={waitingForRefresh ? onRefresh : onInitialize}>{busy ? t("刷新中…") : waitingForRefresh ? t("我已初始化，刷新") : installedLocally ? t("打开终端安装 CA") : t("初始化 CA")}</button>
  </div>;
}
