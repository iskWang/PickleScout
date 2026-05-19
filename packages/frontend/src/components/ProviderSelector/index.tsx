import { useState } from 'react';
import type { LLMConfig, LLMProvider } from '../../types';
import './ProviderSelector.css';

interface Props {
  value: LLMConfig;
  onChange: (config: LLMConfig) => void;
}

const PROVIDERS: { id: LLMProvider; label: string; disabled?: boolean }[] = [
  // TODO: enable once openai e2e is validated (currently untested end-to-end)
  { id: 'openai', label: 'OpenAI (coming soon)', disabled: true },
  { id: 'openrouter', label: 'OpenRouter' },
  // TODO: enable once generator supports native Anthropic SDK (currently throws)
  { id: 'anthropic', label: 'Anthropic (coming soon)', disabled: true },
  // TODO: enable once gemini e2e is validated (explorer works; generator untested end-to-end)
  { id: 'gemini', label: 'Google Gemini (coming soon)', disabled: true },
  { id: 'custom', label: 'Custom (OpenAI-compatible)' },
];

type ModelEntry = { id: string; disabled?: boolean };

const PROVIDER_MODELS: Record<LLMProvider, ModelEntry[]> = {
  openai: [
    { id: 'gpt-4o', disabled: true },
    { id: 'gpt-4o-mini', disabled: true },
    { id: 'gpt-4-turbo', disabled: true },
    { id: 'gpt-3.5-turbo', disabled: true },
  ],
  openrouter: [
    { id: 'google/gemini-3.1-flash-lite-preview' },
    // TODO: validate end-to-end before enabling
    { id: 'anthropic/claude-haiku-4.5', disabled: true },
    { id: 'anthropic/claude-sonnet-4-5', disabled: true },
    { id: 'openai/gpt-4o', disabled: true },
    { id: 'openai/gpt-4o-mini', disabled: true },
    { id: 'google/gemini-2.5-flash', disabled: true },
  ],
  anthropic: [
    { id: 'claude-haiku-4-5', disabled: true },
    { id: 'claude-sonnet-4-5', disabled: true },
    { id: 'claude-opus-4-5', disabled: true },
  ],
  gemini: [
    { id: 'gemini-2.0-flash-lite', disabled: true },
    { id: 'gemini-2.5-flash', disabled: true },
    { id: 'gemini-2.5-pro', disabled: true },
  ],
  custom: [],
};

export default function ProviderSelector({ value, onChange }: Props) {
  const [showKey, setShowKey] = useState(false);

  const handleProvider = (provider: LLMProvider) => {
    const models = PROVIDER_MODELS[provider];
    const firstEnabled = models.find((m) => !m.disabled);
    onChange({
      ...value,
      provider,
      model: firstEnabled?.id ?? '',
      baseURL: provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : undefined,
    });
  };

  const models = PROVIDER_MODELS[value.provider];

  return (
    <div className="provider-selector">
      <div className="form-row">
        <div className="form-group">
          <label htmlFor="ps-provider">LLM Provider</label>
          <select
            id="ps-provider"
            value={value.provider}
            onChange={(e) => handleProvider(e.target.value as LLMProvider)}
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id} disabled={p.disabled}>{p.label}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="ps-model">Model</label>
          {value.provider === 'custom' ? (
            <input
              id="ps-model"
              type="text"
              placeholder="e.g. llama3-70b-8192"
              value={value.model}
              onChange={(e) => onChange({ ...value, model: e.target.value })}
            />
          ) : (
            <select
              id="ps-model"
              value={value.model}
              onChange={(e) => onChange({ ...value, model: e.target.value })}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id} disabled={m.disabled}>{m.id}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {value.provider === 'custom' && (
        <div className="form-group">
          <label htmlFor="ps-baseurl">Base URL</label>
          <input
            id="ps-baseurl"
            type="url"
            placeholder="https://api.yourprovider.com/v1"
            value={value.baseURL ?? ''}
            onChange={(e) => onChange({ ...value, baseURL: e.target.value })}
          />
          <p className="form-hint notice notice-warning mt-2">
            ⚠ Verify that this model supports structured output / function calling.
          </p>
        </div>
      )}

      <div className="form-group">
        <label htmlFor="ps-apikey">API Key</label>
        <div className="apikey-wrapper">
          <input
            id="ps-apikey"
            type={showKey ? 'text' : 'password'}
            placeholder="sk-..."
            value={value.apiKey}
            onChange={(e) => onChange({ ...value, apiKey: e.target.value })}
            autoComplete="off"
          />
          <button
            type="button"
            className="apikey-toggle"
            onClick={() => setShowKey((v) => !v)}
            aria-label={showKey ? 'Hide API key' : 'Show API key'}
          >
            {showKey ? '🙈' : '👁'}
          </button>
        </div>
        <p className="form-hint">
          🔒 Key is transmitted over HTTPS and stored server-side with a 7-day expiry. Never logged.
        </p>
      </div>
    </div>
  );
}
