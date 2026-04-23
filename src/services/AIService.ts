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
  anthropic:  'claude-sonnet-4-6',
  azure:      'gpt-4o-mini',
  openrouter: '',
  copilot:    '',
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
  powerAutomateUrl = '',
): Promise<{ ok: boolean; message: string }> {
  if (provider === 'copilot') {
    if (!powerAutomateUrl.trim()) return { ok: false, message: 'Power Automate URL is required.' };
    return { ok: true, message: 'Copilot configured via Power Automate.' };
  }

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
  powerAutomateUrl = '',
): Promise<string> {
  if (provider === 'copilot') {
    return _callPowerAutomate(powerAutomateUrl, messages, systemPrompt);
  }

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

// ─────────────────────────────────────────────────────────────────────────────
// Power Automate transport — used when provider === 'copilot'
// ─────────────────────────────────────────────────────────────────────────────

async function _callPowerAutomate(
  url: string,
  messages: AIMessage[],
  systemPrompt?: string,
): Promise<string> {
  if (!url) throw new Error('Power Automate URL is required for Copilot provider.');
  const parts: string[] = [];
  if (systemPrompt) parts.push(systemPrompt);
  for (const m of messages.filter(msg => msg.role !== 'system')) parts.push(m.content);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: crypto.randomUUID(),
      prompt: parts.join('\n\n'),
      responseFormat: 'text',
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Power Automate Error: ${res.statusText}${errText ? ` — ${errText}` : ''}`);
  }
  return res.text();
}

// ─────────────────────────────────────────────────────────────────────────────
// Live model fetching — calls provider API, filters to chat-only models,
// classifies into Pro / Balanced / Efficient tiers.
// ─────────────────────────────────────────────────────────────────────────────

export interface TieredModels {
  pro: string[];
  balanced: string[];
  efficient: string[];
  fetchedAt: number;
}

type FetchableProvider = 'gemini' | 'openai' | 'anthropic';

export async function fetchModels(provider: FetchableProvider, apiKey: string): Promise<TieredModels> {
  let all: string[] = [];

  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`OpenAI models fetch failed: ${res.status}`);
    const data = await res.json();
    const ids: string[] = (data.data || []).map((m: any) => m.id as string);
    const CHAT_PREFIX  = /^(gpt-|o[0-9]|chatgpt-)/i;
    const EXCLUDE      = /^ft:|sora|dall-e|whisper|^tts|text-embedding|text-moderation|babbage|davinci|curie|^ada|omni-mini/i;
    const OLD_SNAPSHOT = /-(03|06|09|12)(01|14|13|28|30)\b/;
    all = ids.filter(id => CHAT_PREFIX.test(id) && !EXCLUDE.test(id) && !OLD_SNAPSHOT.test(id));

  } else if (provider === 'gemini') {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`);
    if (!res.ok) throw new Error(`Gemini models fetch failed: ${res.status}`);
    const data = await res.json();
    const GEMINI_CHAT    = /^gemini-/i;
    const GEMINI_EXCLUDE = /embed|aqa|retrieval|vision(?!.*gemini)|imagen|veo|bison|gecko|^text-|legacy/i;
    all = (data.models || [])
      .filter((m: any) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map((m: any) => (m.name as string).replace('models/', ''))
      .filter((id: string) => GEMINI_CHAT.test(id) && !GEMINI_EXCLUDE.test(id));

  } else if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    });
    if (!res.ok) throw new Error(`Anthropic models fetch failed: ${res.status}`);
    const data = await res.json();
    all = (data.data || []).map((m: any) => m.id as string);
  }

  return _classifyModels(all);
}

function _getTier(id: string): 'pro' | 'balanced' | 'efficient' {
  const s = id.toLowerCase();
  if (s.includes('deep-research') || s.includes('deepresearch')) return 'pro';
  if (/\b(mini|flash|haiku|lite|small|nano|micro|basic|instant|speed)\b/.test(s)) return 'efficient';
  if (/\b(pro|opus|plus|ultra|large|advanced|max|heavy|premium|turbo)\b/.test(s)) return 'pro';
  if (/^o[3-9](-\d{4}-\d{2}-\d{2})?$/.test(s)) return 'pro';
  return 'balanced';
}

function _classifyModels(ids: string[]): TieredModels {
  const buckets: Record<'pro' | 'balanced' | 'efficient', string[]> = { pro: [], balanced: [], efficient: [] };
  for (const id of ids) buckets[_getTier(id)].push(id);
  const sortDesc = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true });
  return {
    pro:       buckets.pro.sort(sortDesc),
    balanced:  buckets.balanced.sort(sortDesc),
    efficient: buckets.efficient.sort(sortDesc),
    fetchedAt: Date.now(),
  };
}
