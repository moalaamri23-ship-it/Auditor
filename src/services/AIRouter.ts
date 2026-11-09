/**
 * AI Router — single Power Automate entry point for every flow call.
 *
 * When Settings → "AI Router URL" is filled, a flow call is sent to the router
 * with `task` (and `target` for chat) added to its existing body. The router
 * strips those fields, forwards the body to the target flow and returns that
 * flow's status, content type and body unchanged. When the router URL is empty
 * the call goes to its own direct URL exactly as before.
 */

import { useStore } from '../store/useStore';

export type RouterTask = 'chat' | 'audit_report';

export interface RoutedRequest {
  url: string;
  body: Record<string, unknown>;
}

export function routeFlowCall(
  directUrl: string | undefined,
  task: RouterTask,
  body: Record<string, unknown>,
  target?: 'agent' | 'flow' | 'light',
): RoutedRequest {
  const routerUrl = useStore.getState().aiConfig.aiRouterUrl?.trim();
  if (routerUrl) {
    return { url: routerUrl, body: { ...body, task, ...(target ? { target } : {}) } };
  }
  return { url: directUrl ?? '', body };
}

export function isRouterConfigured(): boolean {
  return !!useStore.getState().aiConfig.aiRouterUrl?.trim();
}
