import React, { useState, useEffect, useRef } from 'react';
import Icon from './Icon';
import { ModelSelector } from './ModelSelector';
import { useStore } from '../store/useStore';
import { testApiConnection, fetchModels } from '../services/AIService';
import type { TieredModels } from '../services/AIService';
import {
  parseCatalogXlsx, setUserCatalog, resetToBundled, getActiveCatalog,
} from '../services/FailureCatalogService';
import { AI_PROVIDERS } from '../constants';
import type { FailureCatalog } from '../types';

type ProviderKey = keyof typeof AI_PROVIDERS;

const PROVIDER_KEYS = Object.keys(AI_PROVIDERS) as ProviderKey[];

// Static fallback lists — used when live fetch hasn't run yet or provider is Azure/OpenRouter/Copilot
const FALLBACK_MODELS: Record<ProviderKey, string[]> = {
  gemini:     ['gemini-2.0-flash', 'gemini-2.5-pro-preview', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  openai:     ['gpt-4o-mini', 'gpt-4o', 'o3-mini'],
  anthropic:  ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
  azure:      [],
  openrouter: ['openai/gpt-4o', 'anthropic/claude-sonnet-4-6', 'google/gemini-2.0-flash', 'meta-llama/llama-3.3-70b-instruct'],
  copilot:    [],
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
  const [localEndpoint,          setLocalEndpoint]          = useState('');
  const [localPowerAutomateUrl,  setLocalPowerAutomateUrl]  = useState(aiConfig.powerAutomateUrl ?? '');

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
    updateAIConfig({ provider: localProvider, apiKey: localKey, modelId: localModelId, powerAutomateUrl: localPowerAutomateUrl });
    setTestStatus(null);
    setTestMessage('');

    if (localProvider === 'copilot') {
      if (localPowerAutomateUrl.trim()) {
        setTestStatus('ok');
        setTestMessage('Copilot configuration saved.');
      }
      return;
    }

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
          {localProvider !== 'azure' && localProvider !== 'copilot' && (
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
                allowCustomList={localProvider === 'openrouter'}
              />
              {localProvider === 'openrouter' && (
                <p className="text-xs text-slate-400 mt-1">
                  Add any OpenRouter model ID (e.g. anthropic/claude-sonnet-4-6, meta-llama/llama-3-70b-instruct)
                </p>
              )}
            </div>
          )}

          {/* Copilot — info text instead of model selector */}
          {localProvider === 'copilot' && (
            <p className="text-xs text-slate-400">
              Model selection is managed by Copilot Studio. No model ID is required here.
            </p>
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

          {/* Copilot — Power Automate URL */}
          {localProvider === 'copilot' && (
            <div className="animate-enter">
              <label className="text-xs font-semibold text-slate-500 mb-1 block">Power Automate URL</label>
              <input
                type="url"
                value={localPowerAutomateUrl}
                onChange={e => { setLocalPowerAutomateUrl(e.target.value); setTestStatus(null); }}
                placeholder="https://prod-xx.westus.logic.azure.com/workflows/..."
                className="w-full border border-slate-200 rounded px-3 py-2 text-sm outline-none focus:border-brand-500 transition shadow-sm font-mono"
              />
              <p className="mt-1 text-xs text-slate-400 italic">HTTP trigger URL from your Power Automate flow. Stored in your browser's local storage only.</p>
            </div>
          )}

          {/* API Key — hidden for Copilot */}
          {localProvider !== 'copilot' && (
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
          )}

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

      <FailureCatalogSection />

      {/* Privacy note */}
      <div className="mt-6 max-w-xl bg-slate-50 border border-slate-200 rounded p-4 text-xs text-slate-500 leading-relaxed">
        <span className="font-bold text-slate-700">Privacy note:</span>{' '}
        All SQL analysis runs locally in your browser.
        AI only receives aggregated summaries (counts, rates, flagged-record snapshots) — never raw exports.
        If no API key is configured, the rule-based pre-checks still run fully offline.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure Catalog section
// ─────────────────────────────────────────────────────────────────────────────

function FailureCatalogSection() {
  const [catalog, setCatalog] = useState<FailureCatalog>(() => getActiveCatalog());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | null; text: string }>({ kind: null, text: '' });
  const inputRef = useRef<HTMLInputElement>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setMsg({ kind: null, text: '' });
    try {
      const next = await parseCatalogXlsx(file);
      await setUserCatalog(next);
      setCatalog(next);
      setMsg({ kind: 'ok', text: `Loaded ${next.rowCount.toLocaleString()} catalog rows.` });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };

  const onReset = async () => {
    setBusy(true);
    setMsg({ kind: null, text: '' });
    try {
      const next = await resetToBundled();
      setCatalog(next);
      setMsg({ kind: 'ok', text: 'Reverted to the bundled default catalog.' });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white p-6 rounded border max-w-xl mt-6">
      <div className="border-b pb-4 mb-5 flex items-center gap-3">
        <div className="bg-violet-600 p-2 rounded text-white flex items-center justify-center">
          <Icon name="layers" className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold mb-1">Failure Catalog</h2>
          <p className="text-xs text-slate-400">
            Used by the catalog hierarchy validator and the AI "False Not Listed" detector.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <Stat label="Source" value={catalog.source === 'user' ? 'Custom upload' : 'Bundled default'} />
        <Stat label="Rows" value={catalog.rowCount.toLocaleString()} />
        <Stat label="Updated" value={new Date(catalog.generatedAt).toLocaleDateString()} />
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls"
        onChange={onFile}
        className="hidden"
      />
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="px-4 py-2 text-sm bg-slate-900 text-white rounded font-bold flex items-center gap-2 hover:bg-slate-800 transition disabled:opacity-50"
        >
          <Icon name="upload" className="w-4 h-4" />
          Upload new catalog (.xlsx)
        </button>
        {catalog.source === 'user' && (
          <button
            onClick={onReset}
            disabled={busy}
            className="px-4 py-2 text-sm border border-slate-200 rounded font-bold flex items-center gap-2 hover:bg-slate-50 transition disabled:opacity-50"
          >
            <Icon name="refresh" className="w-4 h-4" />
            Reset to bundled default
          </button>
        )}
      </div>
      {msg.kind && (
        <div
          className={`mt-3 p-2 text-xs rounded border ${
            msg.kind === 'ok'
              ? 'bg-green-50 border-green-200 text-green-700'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          {msg.text}
        </div>
      )}
      <p className="mt-3 text-xs text-slate-400 leading-relaxed">
        Upload an Excel file with columns: <code className="font-mono">Failure_Catalog_Desc</code>,{' '}
        <code className="font-mono">Object_Part_Code_Description</code>,{' '}
        <code className="font-mono">Damage_Code_Description</code>,{' '}
        <code className="font-mono">Cause_Code_Description</code>. Stored locally in your browser.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-50 border border-slate-100 rounded px-3 py-2">
      <div className="text-[10px] font-bold uppercase text-slate-400">{label}</div>
      <div className="text-sm font-semibold text-slate-700 truncate">{value}</div>
    </div>
  );
}
