import type { JobStatus, TokenUsage } from '../../types';
import './JobStatusBar.css';

interface Props {
  url: string;
  status: JobStatus | null;
  currentStep?: number;
  maxSteps?: number;
  tokenUsage?: TokenUsage | null;
  onCancel?: () => void;
}

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Queued',
  exploring: 'Exploring',
  generating: 'Generating',
  verifying: 'Verifying',
  self_healing: 'Self-Healing',
  completed: 'Completed',
  failed: 'Failed',
};

function formatCost(usd: number): string {
  if (usd < 0.001) return '< $0.001';
  return `~$${usd.toFixed(3)}`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const ACTIVE_STATUSES = new Set<JobStatus>(['exploring', 'generating', 'verifying', 'self_healing']);

export default function JobStatusBar({ url, status, currentStep, maxSteps, tokenUsage, onCancel }: Props) {
  const isActive = status ? ACTIVE_STATUSES.has(status) : false;
  const progress = currentStep && maxSteps ? Math.min(currentStep / maxSteps, 1) : 0;

  return (
    <div className="job-status-bar card">
      <div className="jsb-top">
        <div className="jsb-url truncate">{url}</div>
        <div className="jsb-right">
          {status && (
            <span className={`badge badge-${status}`}>{STATUS_LABELS[status]}</span>
          )}
          {isActive && onCancel && (
            <button id="cancel-job" className="btn btn-ghost btn-sm" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </div>

      {isActive && (
        <>
          {currentStep !== undefined && maxSteps !== undefined && (
            <div className="jsb-step-info text-sm text-muted mt-2">
              Step {currentStep} / ~{maxSteps}
            </div>
          )}
          <div className="progress-bar mt-2">
            <div className="progress-bar-fill" style={{ width: `${progress * 100}%` }} />
          </div>
        </>
      )}

      {tokenUsage && (tokenUsage.promptTokens > 0) && (
        <div className="jsb-tokens text-xs text-faint mt-2">
          Tokens: {formatTokens(tokenUsage.promptTokens + tokenUsage.completionTokens)}
          {' · '}
          Est. cost: {formatCost(tokenUsage.estimatedCostUSD)}
        </div>
      )}
    </div>
  );
}
