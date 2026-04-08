import React, { useState, useEffect } from 'react';
import Icon from './Icon';
import { ModelSelector } from './ModelSelector';
import { useStore } from '../store/useStore';
import { testApiConnection, fetchModels } from '../services/AIService';
import type { TieredModels } from '../services/AIService';
import { AI_PROVIDERS } from '../constants';

type ProviderKey = keyof typeof AI_PROVIDERS;

const PROVIDER_KEYS = Object.keys(AI_PROVIDERS) as ProviderKey[];

// Static fallback lists — used when live fetch hasn't run yet or provider is Azure/OpenRouter
const FALLBACK_MODELS: Record<ProviderKey, string[]> = {
  gemini:     ['gemini-2.0-flash', 'gemini-2.5-pro-preview', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  openai:     ['gpt-4o-mini', 'gpt-4o', 'o3-mini'],
  anthropic:  ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
  azure:      [],
  openrouter: ['openai/gpt-4o', 'anthropic/claude-sonnet-4-6', 'google/gemini-2.0-flash', 'meta-llama/llama-3.3-70b-instruct'],
};

const FETCHABLE = new Set(['gemini', 'openai', 'anthropic']);
const MODEL_CACHE_KEY = 'auditor_models_cache';
const TTL = 24 * 60 * 60 * 1000;

type TestStatus = null | 'testing' | 'ok' | 'error';

export default function SettingsScreen() {
  const { aiConfig, updateAIConfig } = useStore();

  const [localProvider,  setLocalProvider]  = useState<ProviderKey>(aiConfig.provider as ProviderKey);
  const [localKey,       setLocalKey]       = useState(aiConfig.apiKey);
  const [localModelId,   setLocalModelId]   = useState(aiConfig.modelId);
  const [localEndpoint,  setLocalEndpoint]  = useState('');

  const [testStatus,  setTestStatus]  = useState<TestStatus>(null);
  const [testMessage, setTestMessage] = useState('');

  const [liveModels,     setLiveModels]     = useState<Record<string, TieredModels>>(() => {
    try { return JSON.parse(localStorage.getItem(MODEL_CACHE_KEY) || '{}'); } catch { return {}; }
  });
  const [modelsFetching, setModelsFetching] = useState(false);

  // Auto-fetch live models when provider or key changes (respects 24h TTL)
  useEffect(() => {
    if (!FETCHABLE.has(localProvider)) return;
    if (!localKey || localKey.length < 10) return;
    const cached = liveModels[localProvider];
    if (cached && Date.now() - cached.fetchedAt < TTL) return;

    setModelsFetching(true);
    fetchModels(localProvider as 'gemini' | 'openai' | 'anthropic', localKey)
      .then(tiered => {
        setLiveModels(prev => {
          const next = { ...prev, [localProvider]: tiered };
          localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify(next));
          return next;
        });
      })
      .catch(e => console.warn('[ModelFetch]', e))
      .finally(() => setModelsFetching(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localProvider, localKey]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    updateAIConfig({ provider: localProvider, apiKey: localKey, modelId: localModelId });
    setTestStatus(null);
    setTestMessage('');

    if (localKey.trim()) {
      setTestStatus('testing');
      const result = await testApiConnection(localProvider, localKey, localModelId, localEndpoint);
      setTestStatus(result.ok ? 'ok' : 'error');
      setTestMessage(result.message);
    }
  };

  const providerInfo = AI_PROVIDERS[localProvider];
  const cachedAt     = liveModels[localProvider]?.fetchedAt;

  return (
    <div className="max-w-7xl mx-auto p-10 animate-enter">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-slate-900">Settings</h1>
        <p className="text-sm text-slate-700 mt-2">Configure your AI provider and application preferences.</p>
      </div>

      <div className="bg-white p-6 rounded border max-w-xl">
        <div className="border-b pb-4 mb-6 flex items-center gap-3">
          <div className="bg-brand-600 p-2 rounded text-white flex items-center justify-center">
            <Icon name="wand" className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold mb-1">AI Provider Configuration</h2>
            <p className="text-xs text-slate-400">Select a provider, pick a model, then enter your API key.</p>
          </div>
        </div>

        <form onSubmit={handleSave} className="space-y-5">

          {/* Provider selector */}
          <div>
            <label className="text-xs font-semibold text-slate-500 mb-2 block">AI Provider</label>
            <div className="grid grid-cols-3 gap-2">
              {PROVIDER_KEYS.map(p => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setLocalProvider(p);
                    setLocalModelId(AI_PROVIDERS[p].defaultModel);
                    setTestStatus(null);
                  }}
                  className={`px-3 py-2 rounded text-sm transition-all text-left ${
                    localProvider === p
                      ? 'border border-brand-600 bg-brand-600/10 text-brand-700 font-bold ring-1 ring-brand-600'
                      : 'border border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                  }`}
                >
                  {AI_PROVIDERS[p].name}
                </button>
              ))}
            </div>
          </div>

          {/* Model selector */}
          {localProvider !== 'azure' && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-slate-500">
                  Model
                  {localProvider === 'openrouter' && <span className="text-red-500 ml-1">*</span>}
                </label>
                {FETCHABLE.has(localProvider) && (
                  <span className="text-[10px] text-slate-400">
                    {modelsFetching
                      ? 'Fetching live models…'
                      : cachedAt
                        ? `Updated ${new Date(cachedAt).toLocaleDateString()}`
                        : 'Enter API key to load live models'
                    }
                  </span>
                )}
              </div>
              <ModelSelector
                value={localModelId}
                onChange={m => { setLocalModelId(m); setTestStatus(null); }}
                liveModels={liveModels[localProvider] ?? null}
                fallbackModels={FALLBACK_MODELS[localProvider]}
                provider={localProvider}
              />
              {localProvider === 'openrouter' && (
                <div className="mt-2 p-3 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-800 leading-relaxed">
                  <strong>OpenRouter</strong> gives you access to 300+ models from OpenAI, Anthropic, Google, Meta,
                  Mistral, DeepSeek, and more — all through a single API key.
                </div>
              )}
            </div>
          )}

          {/* Azure — deployment name + endpoint */}
          {localProvider === 'azure' && (
            <div className="animate-enter space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-500 mb-1 block">Model / Deployment Name</label>
                <input
                  type="text"
                  autoComplete="off"
                  value={localModelId}
                  onChange={e => { setLocalModelId(e.target.value); setTestStatus(null); }}
                  placeholder="my-gpt4o-deployment"
                  className="w-full border border-slate-200 rounded px-3 py-2 text-sm outline-none focus:border-brand-500 transition shadow-sm font-mono"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 mb-1 block">Azure Endpoint</label>
                <input
                  type="url"
                  value={localEndpoint}
                  onChange={e => setLocalEndpoint(e.target.value)}
                  placeholder="https://your-resource.openai.azure.com/"
                  className="w-full border border-slate-200 rounded px-3 py-2 text-sm outline-none focus:border-brand-500 transition shadow-sm font-mono"
                />
              </div>
            </div>
          )}

          {/* API Key */}
          <div>
            <label className="text-xs font-semibold text-slate-500 mb-1 block">API Key</label>
            <input
              type="password"
              autoComplete="new-password"
              value={localKey}
              onChange={e => { setLocalKey(e.target.value); setTestStatus(null); }}
              placeholder={`Enter your ${providerInfo.name} API key…`}
              className="w-full border border-slate-200 rounded px-3 py-2 text-sm outline-none focus:border-brand-500 transition shadow-sm font-mono"
            />
            <p className="mt-1 text-xs text-slate-400 italic">Stored in your browser's local storage only.</p>
          </div>

          {/* Test result */}
          {testStatus && (
            <div className={`flex items-start gap-2.5 p-3 rounded border text-sm animate-enter ${
              testStatus === 'testing' ? 'bg-slate-50 border-slate-200 text-slate-600'
              : testStatus === 'ok'    ? 'bg-green-50 border-green-200 text-green-800'
              :                          'bg-red-50 border-red-200 text-red-800'
            }`}>
              {testStatus === 'testing' && <Icon name="loader" className="w-4 h-4 mt-0.5 animate-spin shrink-0" />}
              {testStatus === 'ok'      && <Icon name="checkCircle" className="w-4 h-4 mt-0.5 shrink-0 text-green-600" />}
              {testStatus === 'error'   && <Icon name="xCircle"     className="w-4 h-4 mt-0.5 shrink-0 text-red-600" />}
              <div>
                <p className="font-bold">
                  {testStatus === 'testing' ? 'Testing connection…'
                  : testStatus === 'ok'     ? 'API connection successful'
                  :                           'API connection failed'}
                </p>
                {testMessage && testStatus !== 'testing' && (
                  <p className="text-xs mt-0.5 opacity-80">{testMessage}</p>
                )}
              </div>
            </div>
          )}

          <div className="pt-4 border-t border-slate-200 flex items-center justify-end">
            <button
              type="submit"
              disabled={testStatus === 'testing'}
              className="bg-brand-600 text-white px-4 py-2 rounded font-bold flex items-center gap-2 hover:bg-brand-700 transition disabled:opacity-60"
            >
              {testStatus === 'testing'
                ? <><Icon name="loader" className="w-4 h-4 animate-spin" /> Testing…</>
                : <><Icon name="save" className="w-4 h-4" /> Save & Test</>
              }
            </button>
          </div>
        </form>
      </div>

      {/* Privacy note */}
      <div className="mt-6 max-w-xl bg-slate-50 border border-slate-200 rounded p-4 text-xs text-slate-500 leading-relaxed">
        <span className="font-bold text-slate-700">Privacy note:</span>{' '}
        All SQL analysis runs locally in your browser via DuckDB WASM.
        AI only receives aggregated summaries (counts, rates, anomaly descriptions) — never raw rows or individual records.
        If no API key is configured, all DuckDB analysis still works fully in demo mode.
      </div>
    </div>
  );
}
