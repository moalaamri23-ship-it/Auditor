/**
 * AI Service
 *
 * Provider-agnostic AI layer. Supports Gemini, OpenAI, Anthropic, Azure OpenAI,
 * and OpenRouter. AI only ever receives pre-aggregated summaries from DuckDB —
 * never raw rows or individual records.
 */

import type { AIProvider } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Model resolution
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULTS: Record<AIProvider, string> = {
  gemini:     'gemini-2.0-flash',
  openai:     'gpt-4o-mini',
  anthropic:  'claude-sonnet-4-20250514',
  azure:      'gpt-4o-mini',
  openrouter: '',
};

function resolveModel(provider: AIProvider, modelId: string): string {
  return modelId.trim() || DEFAULTS[provider] || '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection test — sends a minimal "Hi" message to verify credentials
// ─────────────────────────────────────────────────────────────────────────────

export async function testApiConnection(
  provider: AIProvider,
  apiKey: string,
  modelId: string,
  azureEndpoint = '',
): Promise<{ ok: boolean; message: string }> {
  if (!apiKey.trim()) return { ok: false, message: 'No API key provided.' };

  const model = resolveModel(provider, modelId);

  try {
    // ── Google Gemini ────────────────────────────────────────────────────────
    if (provider === 'gemini') {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'Hi' }] }] }),
        }
      );
      if (res.status === 400) {
        const d = await res.json().catch(() => ({}));
        const msg = (d as any).error?.message || '';
        return { ok: false, message: msg.includes('API_KEY') ? 'Invalid API key.' : `Error 400: ${msg}` };
      }
      if (res.status === 429) return { ok: false, message: 'Quota exceeded or rate limited.' };
      if (!res.ok) return { ok: false, message: `API error ${res.status}.` };
      return { ok: true, message: `Connected to ${model}` };
    }

    // ── Anthropic Claude ─────────────────────────────────────────────────────
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'Hi' }] }),
      });
      if (res.status === 401) return { ok: false, message: 'Invalid API key.' };
      if (res.status === 403) return { ok: false, message: 'Insufficient credit or access denied.' };
      if (res.status === 429) return { ok: false, message: 'Rate limit exceeded.' };
      if (!res.ok) return { ok: false, message: `API error ${res.status}.` };
      return { ok: true, message: `Connected to ${model}` };
    }

    // ── OpenAI / Azure OpenAI / OpenRouter ───────────────────────────────────
    if (provider === 'openai' || provider === 'azure' || provider === 'openrouter') {
      if (provider === 'openrouter' && !model) {
        return { ok: false, message: 'Model ID is required for OpenRouter.' };
      }

      let url = 'https://api.openai.com/v1/chat/completions';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      if (provider === 'openai') {
        headers['Authorization'] = `Bearer ${apiKey}`;
      } else if (provider === 'azure') {
        if (!azureEndpoint) return { ok: false, message: 'Azure endpoint is required.' };
        if (!model)         return { ok: false, message: 'Model/deployment name is required.' };
        url = `${azureEndpoint.replace(/\/$/, '')}/openai/deployments/${model}/chat/completions?api-version=2024-02-01`;
        headers['api-key'] = apiKey;
      } else {
        url = 'https://openrouter.ai/api/v1/chat/completions';
        headers['Authorization']  = `Bearer ${apiKey}`;
        headers['HTTP-Referer']   = window.location.origin;
        headers['X-Title']        = 'SAP Auditor';
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5 }),
      });

      if (res.status === 401) return { ok: false, message: 'Invalid API key.' };
      if (res.status === 402) return { ok: false, message: 'Insufficient credits.' };
      if (res.status === 404) return { ok: false, message: 'Model or deployment not found. Check your Model ID.' };
      if (res.status === 429) return { ok: false, message: 'Rate limit or quota exceeded.' };
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        return { ok: false, message: `API error ${res.status}: ${(d as any).error?.message || ''}` };
      }
      return { ok: true, message: `Connected to ${model}` };
    }

    return { ok: false, message: 'Unknown provider.' };
  } catch (err) {
    return { ok: false, message: `Network error: ${(err as Error).message}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core AI call — returns text response
// ─────────────────────────────────────────────────────────────────────────────

export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export async function callAI(
  provider: AIProvider,
  apiKey: string,
  modelId: string,
  messages: AIMessage[],
  systemPrompt?: string,
  azureEndpoint = '',
): Promise<string> {
  const model = resolveModel(provider, modelId);

  // ── Google Gemini ──────────────────────────────────────────────────────────
  if (provider === 'gemini') {
    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const sys = systemPrompt || messages.find(m => m.role === 'system')?.content;

    const body: Record<string, unknown> = { contents };
    if (sys) body.systemInstruction = { parts: [{ text: sys }] };

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (!res.ok) throw new Error(`Gemini error ${res.status}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  // ── Anthropic ──────────────────────────────────────────────────────────────
  if (provider === 'anthropic') {
    const sys = systemPrompt || messages.find(m => m.role === 'system')?.content;
    const body: Record<string, unknown> = {
      model,
      max_tokens: 2048,
      messages: messages.filter(m => m.role !== 'system'),
    };
    if (sys) body.system = sys;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Anthropic error ${res.status}`);
    const data = await res.json();
    return data.content?.[0]?.text ?? '';
  }

  // ── OpenAI / Azure / OpenRouter ───────────────────────────────────────────
  let url = 'https://api.openai.com/v1/chat/completions';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (provider === 'openai') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (provider === 'azure') {
    url = `${azureEndpoint.replace(/\/$/, '')}/openai/deployments/${model}/chat/completions?api-version=2024-02-01`;
    headers['api-key'] = apiKey;
  } else {
    url = 'https://openrouter.ai/api/v1/chat/completions';
    headers['Authorization'] = `Bearer ${apiKey}`;
    headers['HTTP-Referer']  = window.location.origin;
    headers['X-Title']       = 'SAP Auditor';
  }

  const oaiMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages.filter(m => m.role !== 'system')]
    : messages;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages: oaiMessages, max_tokens: 2048 }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}
