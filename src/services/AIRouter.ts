/**
 * OXY Connection Flow (AI Router) — the single Power Automate entry point for
 * every flow call.
 *
 * Settings → "OXY Connection Flow URL" (stored as aiRouterUrl) is the only flow
 * URL. Each call adds `task` (and `target` for chat) to its existing body; the
 * router strips those fields, forwards the body to the target flow and returns
 * that flow's status, content type and body unchanged.
 */

import { useStore } from '../store/useStore';

export type RouterTask = 'chat' | 'audit_report';

export interface RoutedRequest {
  /** Empty string when the OXY Connection Flow URL is not configured. */
  url: string;
  body: Record<string, unknown>;
}

export function routeFlowCall(
  task: RouterTask,
  body: Record<string, unknown>,
  target?: 'agent' | 'flow' | 'light',
): RoutedRequest {
  const routerUrl = useStore.getState().aiConfig.aiRouterUrl?.trim() ?? '';
  return { url: routerUrl, body: { ...body, task, ...(target ? { target } : {}) } };
}

export function isRouterConfigured(): boolean {
  return !!useStore.getState().aiConfig.aiRouterUrl?.trim();
}
