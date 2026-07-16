import { Platform } from "obsidian";

/** 当前是否运行在 iOS / iPadOS 上。 */
export const isIOS = (): boolean => Platform.isIosApp;

/** 当前是否运行在移动端（iOS + Android）。 */
export const isMobile = (): boolean => Platform.isMobile;

/** 当前是否运行在桌面端。 */
export const isDesktop = (): boolean => Platform.isDesktopApp;

/**
 * 推荐安全区 CSS。返回值可直接拼到 padding 中。
 */
export function safeAreaPadding(extra = 0): string {
  return `
    max(${extra}px, env(safe-area-inset-top))
    max(${extra}px, env(safe-area-inset-right))
    max(${extra}px, env(safe-area-inset-bottom))
    max(${extra}px, env(safe-area-inset-left))
  `;
}

/**
 * 检测用户代理是否偏移动端，给一些运行时分支用。
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
