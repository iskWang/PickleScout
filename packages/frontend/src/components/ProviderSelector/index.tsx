import { useState } from 'react';
import type { LLMConfig, LLMProvider } from '../../types';
import './ProviderSelector.css';

interface Props {
  value: LLMConfig;
  onChange: (config: LLMConfig) => void;
}

const PROVIDERS: { id: LLMProvider; label: string; disabled?: boolean }[] = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'openrouter', label: 'OpenRouter' },
  // TODO: enable once generator supports native Anthropic SDK (currently throws)
  { id: 'anthropic', label: 'Anthropic (coming soon)', disabled: true },
  // TODO: enable once gemini e2e is validated (explorer works; generator untested end-to-end)
  { id: 'gemini', label: 'Google Gemini (coming soon)', disabled: true },
  { id: 'custom', label: 'Custom (OpenAI-compatible)' },
];

const PROVIDER_MODELS: Record<LLMProvider, string[]> = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  openrouter: [
    'google/gemini-3.1-flash-lite-preview',
    'anthropic/claude-haiku-4.5',
    'anthropic/claude-sonnet-4-5',
    'openai/gpt-4o',
    'openai/gpt-4o-mini',
    'google/gemini-2.5-flash',
  ],
  anthropic: ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5'],
  gemini: ['gemini-2.0-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  custom: [],
};

export default function ProviderSelector({ value, onChange }: Props) {
  const [showKey, setShowKey] = useState(false);

  const handleProvider = (provider: LLMProvider) => {
    const models = PROVIDER_MODELS[provider];
    onChange({
      ...value,
      provider,
      model: models[0] ?? '',
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
                <option key={m} value={m}>{m}</option>
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
