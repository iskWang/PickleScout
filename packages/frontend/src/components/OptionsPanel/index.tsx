import { useState } from 'react';
import type { JobOptions, VerificationMode } from '../../types';

interface Props {
  value: JobOptions;
  onChange: (opts: JobOptions) => void;
}

export default function OptionsPanel({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);

  const update = (patch: Partial<JobOptions>) => onChange({ ...value, ...patch });

  const positiveCount = Math.round(value.maxScenarios * value.positiveRatio);
  const negativeCount = value.maxScenarios - positiveCount;

  return (
    <div className="card" style={{ padding: 'var(--space-4)' }}>
      <button
        type="button"
        className={`collapsible-trigger ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        id="options-panel-trigger"
      >
        <span className="chevron">▶</span>
        <span>⚙️ Advanced Options</span>
        <span className="text-faint text-sm" style={{ marginLeft: 'auto' }}>
          {value.maxScenarios} scenarios · {value.verificationMode}
        </span>
      </button>

      {open && (
        <div className="collapsible-body" style={{ marginTop: 'var(--space-4)' }}>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="opt-max-scenarios">
                Max Scenarios <span className="text-faint">(1–10)</span>
              </label>
              <input
                id="opt-max-scenarios"
                type="number"
                min={1}
                max={10}
                value={value.maxScenarios}
                onChange={(e) => update({ maxScenarios: Math.min(10, Math.max(1, +e.target.value)) })}
              />
            </div>
            <div className="form-group">
              <label htmlFor="opt-max-steps">
                Max Agent Steps <span className="text-faint">(1–50)</span>
              </label>
              <input
                id="opt-max-steps"
                type="number"
                min={1}
                max={50}
                value={value.maxSteps}
                onChange={(e) => update({ maxSteps: Math.min(50, Math.max(1, +e.target.value)) })}
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="opt-positive-ratio">
              Positive / Negative Split —{' '}
              <span className="text-brand">{positiveCount} positive</span>{' '}
              <span className="text-muted">/ {negativeCount} negative</span>
            </label>
            <input
              id="opt-positive-ratio"
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={value.positiveRatio}
              onChange={(e) => update({ positiveRatio: +e.target.value })}
              style={{ width: '100%' }}
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="opt-verification">Verification Mode</label>
              <select
                id="opt-verification"
                value={value.verificationMode}
                onChange={(e) => update({ verificationMode: e.target.value as VerificationMode })}
              >
                <option value="syntax-only">syntax-only — fast, no browser</option>
                <option value="smoke">smoke — run once (default)</option>
                <option value="full">full — retry on flake</option>
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="opt-max-retries">
                Self-Heal Retries <span className="text-faint">(0–5)</span>
              </label>
              <input
                id="opt-max-retries"
                type="number"
                min={0}
                max={5}
                value={value.maxRetries}
                onChange={(e) => update({ maxRetries: Math.min(5, Math.max(0, +e.target.value)) })}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
