import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ProviderSelector from '../components/ProviderSelector';
import AuthPanel from '../components/AuthPanel';
import OptionsPanel from '../components/OptionsPanel';
import RecentJobs, { saveRecentJob } from '../components/RecentJobs';
import type { AuthConfig, CreateJobRequest, JobOptions, LLMConfig } from '../types';
import { API_BASE } from '../lib/api';
import './JobFormPage.css';

const LLM_CONFIG_KEY = 'llm_config';

const DEFAULT_LLM: LLMConfig = {
  provider: 'openrouter',
  apiKey: '',
  model: 'google/gemini-3.1-flash-lite-preview',
  baseURL: 'https://openrouter.ai/api/v1',
};

const DEFAULT_OPTIONS: JobOptions = {
  maxScenarios: 10,
  positiveRatio: 0.6,
  maxSteps: 30,
  verificationMode: 'smoke',
  maxRetries: 2,
};

type LLMPrefs = Pick<LLMConfig, 'provider' | 'model' | 'baseURL'>;

function loadSavedLlm(): LLMConfig {
  try {
    const raw = localStorage.getItem(LLM_CONFIG_KEY);
    if (!raw) return DEFAULT_LLM;
    const prefs = JSON.parse(raw) as Partial<LLMPrefs>;
    return { ...DEFAULT_LLM, ...prefs, apiKey: '' };
  } catch {
    return DEFAULT_LLM;
  }
}

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export default function JobFormPage() {
  const navigate = useNavigate();
  const [url, setUrl] = useState('https://demo.odoo.com/odoo/sales');
  const [hint, setHint] = useState('');
  const [llm, setLlm] = useState<LLMConfig>(loadSavedLlm);
  const [auth, setAuth] = useState<AuthConfig | undefined>(undefined);
  const [options, setOptions] = useState<JobOptions>(DEFAULT_OPTIONS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Persist non-secret LLM preferences (provider/model/baseURL) across sessions.
  // apiKey is intentionally excluded — it must be re-entered each visit.
  useEffect(() => {
    const prefs: LLMPrefs = { provider: llm.provider, model: llm.model, baseURL: llm.baseURL };
    localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify(prefs));
  }, [llm]);

  const urlValid = isValidUrl(url);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlValid || !llm.apiKey || !llm.model) return;

    setSubmitting(true);
    setError(null);

    const body: CreateJobRequest = {
      url,
      hint: hint.trim() || undefined,
      auth,
      llm,
      options,
    };

    try {
      const res = await fetch(`${API_BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      const data = await res.json() as { hash: string; createdAt: number };
      saveRecentJob({ hash: data.hash, url, createdAt: data.createdAt, status: 'queued' });
      navigate(`/jobs/${data.hash}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <div className="page">
      <div className="container">
        {/* Brand */}
        <div className="brand">
          <img src="/logo.png" alt="PickleScout" className="brand-logo" />
          <div>
            <div className="brand-title">PickleScout</div>
            <div className="brand-subtitle">Sends a pickle into the wild. Returns with Gherkin specs.</div>
          </div>
        </div>

        <form id="job-form" onSubmit={handleSubmit} noValidate>
          <div className="card form-card">
            {/* URL input */}
            <div className="form-group">
              <label htmlFor="target-url">Target URL</label>
              <input
                id="target-url"
                type="url"
                placeholder="https://demo.odoo.com/odoo/sales"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className={url && !urlValid ? 'input-error' : ''}
                required
                autoFocus
              />
              {url && !urlValid && (
                <p className="form-hint" style={{ color: 'var(--color-failed)' }}>
                  Enter a valid URL starting with http:// or https://
                </p>
              )}
            </div>

            {/* Hint */}
            <div className="form-group">
              <label htmlFor="hint">
                Hint <span className="text-faint">(optional)</span>
              </label>
              <input
                id="hint"
                type="text"
                placeholder="Focus on login and order creation"
                value={hint}
                onChange={(e) => setHint(e.target.value)}
              />
              <p className="form-hint">
                Guide the agent toward specific user journeys.
              </p>
            </div>

            <div className="divider" />

            {/* LLM Provider */}
            <ProviderSelector value={llm} onChange={setLlm} />

            <div className="divider" />

            {/* Collapsible sections */}
            <div className="panels-stack">
              <AuthPanel value={auth} onChange={setAuth} />
              <OptionsPanel value={options} onChange={setOptions} />
            </div>

            {/* Error */}
            {error && (
              <div className="notice notice-error mt-4">
                ❌ {error}
              </div>
            )}

            {/* Submit */}
            <button
              id="submit-job"
              type="submit"
              className="btn btn-primary btn-lg w-full mt-6"
              disabled={submitting || !urlValid || !llm.apiKey || !llm.model}
            >
              {submitting ? (
                <>
                  <span className="spinner" />
                  Submitting…
                </>
              ) : (
                <>🚀 Generate Tests</>
              )}
            </button>
          </div>
        </form>

        {/* Recent jobs */}
        <RecentJobs />
      </div>
    </div>
  );
}
