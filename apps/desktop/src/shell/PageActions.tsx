//! Portals a page's title and page-level controls into the shared fixed header row.
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useKeepAliveContext } from "keepalive-for-react";

type PageActionsTargets = {
  title: HTMLElement | null;
  left: HTMLElement | null;
  right: HTMLElement | null;
};

export const PageActionsTarget = createContext<PageActionsTargets>({ title: null, left: null, right: null });

function usePageHeaderPortal(slot: keyof PageActionsTargets, children: ReactNode) {
  const targets = useContext(PageActionsTarget);
  const { active } = useKeepAliveContext();
  const target = targets[slot];
  return active && target ? createPortal(children, target) : null;
}

export function PageActions({ children, position = "right" }: { children: ReactNode; position?: "left" | "right" }) {
  return usePageHeaderPortal(position, children);
}

// The title shares one flex row with the actions, so a wide toolbar narrows the
// title instead of being drawn over it.
export function PageTitle({ children }: { children: ReactNode }) {
  return usePageHeaderPortal("title", children);
}
