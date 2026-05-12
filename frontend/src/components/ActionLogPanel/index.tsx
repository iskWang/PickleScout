import type { StepEntry } from '../../hooks/useJobStream';
import './ActionLogPanel.css';

interface Props {
  steps: StepEntry[];
  llmLogs: string[];
}

export default function ActionLogPanel({ steps, llmLogs }: Props) {
  return (
    <div className="action-log-panel card">
      <div className="card-header">
        <h3 className="text-sm font-semibold text-muted">Action Log</h3>
        <span className="text-xs text-faint">{steps.length} steps</span>
      </div>
      <div className="action-log-scroll">
        {steps.length === 0 && llmLogs.length === 0 && (
          <p className="text-sm text-faint" style={{ textAlign: 'center', padding: 'var(--space-6)' }}>
            Waiting for agent to start…
          </p>
        )}

        {steps.map((step) => (
          <div key={step.stepNumber} className={`action-entry ${step.done ? 'done' : 'active'}`}>
            <span className="action-icon">{step.done ? '✓' : '⟳'}</span>
            <div className="action-content">
              <span className="action-text">{step.action}</span>
              {step.selector && (
                <span className="action-selector font-mono text-xs text-faint">
                  {step.selector}
                </span>
              )}
            </div>
          </div>
        ))}

        {llmLogs.length > 0 && (
          <div className="llm-logs">
            {llmLogs.map((log, i) => (
              <div key={i} className="llm-log-entry text-xs text-muted">
                <span className="text-faint">›</span> {log}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
