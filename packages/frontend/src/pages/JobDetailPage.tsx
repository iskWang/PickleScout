import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useJobStream, TERMINAL_STATUSES } from '../hooks/useJobStream';
import JobStatusBar from '../components/JobStatusBar';
import ActionLogPanel from '../components/ActionLogPanel';
import ScreenshotGallery from '../components/ScreenshotGallery';
import FeaturePreview from '../components/FeaturePreview';
import UnverifiedDownloadModal from '../components/UnverifiedDownloadModal';
import { saveRecentJob, removeRecentJob } from '../components/RecentJobs';
import { API_BASE } from '../lib/api';
import type { JobStatus } from '../types';
import './JobDetailPage.css';

interface HallucinationState {
  risk: boolean;
  reason: string;
}

export default function JobDetailPage() {
  const { hash } = useParams<{ hash: string }>();
  const navigate = useNavigate();
  const stream = useJobStream(hash ?? '');
  const [url, setUrl] = useState<string>('');
  const [fetchedStatus, setFetchedStatus] = useState<JobStatus | null>(null);
  const [fetchedError, setFetchedError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [showUnverifiedModal, setShowUnverifiedModal] = useState(false);
  const [hallucination, setHallucination] = useState<HallucinationState>({ risk: false, reason: '' });
  const terminalFetchedRef = useRef(false);

  const applyJobData = useCallback((data: {
    url?: string;
    status?: JobStatus;
    error?: string;
    hallucinationRisk?: boolean;
    hallucinationReason?: string;
  }) => {
    if (data.url) setUrl(data.url);
    if (data.status) setFetchedStatus(data.status);
    if (data.error) setFetchedError(data.error);
    if (data.hallucinationRisk || data.hallucinationReason) {
      setHallucination({ risk: !!data.hallucinationRisk, reason: data.hallucinationReason ?? '' });
    }
  }, []);

  const fetchJobData = useCallback((jobHash: string) => {
    fetch(`${API_BASE}/api/jobs/${jobHash}`)
      .then(async (r) => {
        if (r.status === 404) {
          setNotFound(true);
          return null;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (data) applyJobData(data);
      })
      .catch(() => {});
  }, [applyJobData]);

  useEffect(() => {
    if (!hash) return;
    setNotFound(false);
    fetchJobData(hash);
  }, [fetchJobData, hash]);

  useEffect(() => {
    if (!hash || !stream.status || !TERMINAL_STATUSES.has(stream.status)) return;
    if (terminalFetchedRef.current) return;
    terminalFetchedRef.current = true;
    fetchJobData(hash);
  }, [fetchJobData, hash, stream.status]);

  useEffect(() => {
    if (!hash || !url || !stream.status) return;
    saveRecentJob({
      hash,
      url,
      createdAt: Date.now(),
      status: stream.status,
      scenarioCount: stream.summary?.scenarioCount,
    });
  }, [hash, url, stream.status, stream.summary?.scenarioCount]);

  const handleCancel = async () => {
    if (!hash) return;
    if (!confirm('Cancel this job?')) return;
    await fetch(`${API_BASE}/api/jobs/${hash}`, { method: 'DELETE' });
    removeRecentJob(hash);
    navigate('/');
  };

  const handleDownload = () => {
    window.location.href = `${API_BASE}/api/jobs/${hash}/result`;
  };

  const handleUnverifiedDownload = () => {
    window.location.href = `${API_BASE}/api/jobs/${hash}/result?unverified=true`;
    setShowUnverifiedModal(false);
  };

  const handleRetry = async () => {
    navigate('/');
  };

  const handleCopyUrl = () => {
    navigator.clipboard.writeText(window.location.href);
  };

  if (!hash) {
    return (
      <div className="page">
        <div className="container">
          <div className="notice notice-error">Invalid job ID</div>
          <Link to="/" className="btn btn-secondary mt-4">← Back</Link>
        </div>
      </div>
    );
  }
  if (notFound) {
    return (
      <div className="page">
        <div className="container">
          <div className="notice notice-error">Job not found or expired</div>
          <Link to="/" className="btn btn-secondary mt-4">← Back</Link>
        </div>
      </div>
    );
  }

  const status = stream.status && TERMINAL_STATUSES.has(stream.status)
    ? stream.status
    : (fetchedStatus && TERMINAL_STATUSES.has(fetchedStatus) ? fetchedStatus : (stream.status ?? fetchedStatus));
  const error = stream.error ?? fetchedError;
  const currentStep = stream.steps.length > 0 ? stream.steps[stream.steps.length - 1].stepNumber : 0;
  const isActive = status !== null && !TERMINAL_STATUSES.has(status);
  const isCompleted = status === 'completed';
  const isFailed = status === 'failed';


  return (
    <div className="page">
      <div className="container">
        <div className="jd-header">
          <Link to="/" className="brand" style={{ textDecoration: 'none', marginBottom: 0 }}>
            <img src="/logo.png" alt="PickleScout" className="brand-logo" />
            <span className="brand-title">PickleScout</span>
          </Link>
          <button className="btn btn-ghost btn-sm" onClick={handleCopyUrl} id="copy-job-url">
            🔗 Copy URL
          </button>
        </div>

        <JobStatusBar
          url={url || hash}
          status={status}
          currentStep={currentStep}
          maxSteps={30}
          tokenUsage={stream.tokenUsage}
          onCancel={isActive ? handleCancel : undefined}
        />

        {hallucination.risk && (
          <div className="notice notice-warning" style={{ marginBottom: 'var(--space-4)' }}>
            <span>⚠️</span>
            <div>
              <strong>Low-confidence tests</strong>
              {hallucination.reason ? ` — ${hallucination.reason}.` : '.'}
              {' '}Tests were generated from LLM training data, not observed page behavior.
            </div>
          </div>
        )}

        {(isActive || (!isCompleted && !isFailed)) && (
          <div className="jd-progress-grid">
            <ActionLogPanel steps={stream.steps} llmLogs={stream.llmLogs} />
            <ScreenshotGallery screenshots={stream.screenshots} />
          </div>
        )}

        {isCompleted && stream.summary && (
          <div className="jd-completed">
            <div className="card jd-success-card">
              <div className="jd-success-header">
                <span className="jd-success-icon">✅</span>
                <div>
                  <h2>Generation Complete</h2>
                  <p className="text-muted text-sm">
                    {stream.summary.scenarioCount} scenarios
                    {stream.summary.unhealedScenarios > 0 && (
                      <span style={{ color: 'var(--color-self-healing)' }}>
                        {' '}· {stream.summary.unhealedScenarios} unhealed
                      </span>
                    )}
                  </p>
                </div>
              </div>

              <div className="jd-download-actions">
                <button
                  id="download-zip"
                  className="btn btn-primary btn-lg"
                  onClick={handleDownload}
                >
                  ⬇ Download ZIP
                </button>
                <button className="btn btn-secondary" onClick={handleCopyUrl}>
                  🔗 Copy Job URL
                </button>
              </div>
            </div>

            <FeaturePreview summary={stream.summary} />
          </div>
        )}

        {isFailed && (
          <div className="card jd-failed-card">
            <div className="jd-failed-header">
              <span>❌</span>
              <div>
                <h2>Generation Failed</h2>
                {error && (
                  <p className="text-muted text-sm mt-2">{error}</p>
                )}
                {stream.verificationErrors.length > 0 && (
                  <div className="code-block mt-4" style={{ maxHeight: 160, overflowY: 'auto' }}>
                    {stream.verificationErrors.map((e, i) => (
                      <div key={i} style={{ color: 'var(--color-failed)', marginBottom: 4 }}>{e}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="jd-failed-actions">
              <button id="retry-job" className="btn btn-secondary" onClick={handleRetry}>
                ↻ New Job with Same Config
              </button>
              <Link to="/" className="btn btn-ghost">
                + New Job
              </Link>
            </div>

            <div className="divider" />

            <div>
              <p className="text-sm text-muted mb-4">
                Partial output may be available (unverified):
              </p>
              <button
                id="download-unverified"
                className="btn btn-danger"
                onClick={() => setShowUnverifiedModal(true)}
              >
                ⬇ Download Anyway
              </button>
            </div>
          </div>
        )}

        {showUnverifiedModal && (
          <UnverifiedDownloadModal
            hash={hash}
            onClose={() => setShowUnverifiedModal(false)}
            onConfirm={handleUnverifiedDownload}
          />
        )}
      </div>
    </div>
  );
}
