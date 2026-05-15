import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useJobStream } from '../hooks/useJobStream';
import JobStatusBar from '../components/JobStatusBar';
import ActionLogPanel from '../components/ActionLogPanel';
import ScreenshotGallery from '../components/ScreenshotGallery';
import FeaturePreview from '../components/FeaturePreview';
import UnverifiedDownloadModal from '../components/UnverifiedDownloadModal';
import { saveRecentJob, removeRecentJob } from '../components/RecentJobs';
import { API_BASE } from '../lib/api';
import './JobDetailPage.css';

export default function JobDetailPage() {
  const { hash } = useParams<{ hash: string }>();
  const navigate = useNavigate();
  const stream = useJobStream(hash ?? '');
  const [url, setUrl] = useState<string>('');
  const [showUnverifiedModal, setShowUnverifiedModal] = useState(false);

  // Fetch initial job state (for URL display and initial status)
  useEffect(() => {
    if (!hash) return;
    fetch(`${API_BASE}/api/jobs/${hash}`)
      .then((r) => r.json())
      .then((data: { url?: string; status?: string }) => {
        if (data.url) setUrl(data.url);
      })
      .catch(() => {/* 404 handled below */});
  }, [hash]);

  // Sync recent jobs when status changes
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
    // Navigate back to form — user will re-submit
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

  const currentStep = stream.steps.length > 0 ? stream.steps[stream.steps.length - 1].stepNumber : 0;
  const isActive = stream.status && ['queued', 'exploring', 'generating', 'verifying', 'self_healing'].includes(stream.status);
  const isCompleted = stream.status === 'completed';
  const isFailed = stream.status === 'failed';

  return (
    <div className="page">
      <div className="container">
        {/* Brand header */}
        <div className="jd-header">
          <Link to="/" className="brand" style={{ textDecoration: 'none', marginBottom: 0 }}>
            <span className="brand-logo">🥒</span>
            <span className="brand-title">PickleScout</span>
          </Link>
          <button className="btn btn-ghost btn-sm" onClick={handleCopyUrl} id="copy-job-url">
            🔗 Copy URL
          </button>
        </div>

        {/* Status bar */}
        <JobStatusBar
          url={url || hash}
          status={stream.status}
          currentStep={currentStep}
          maxSteps={30}
          tokenUsage={stream.tokenUsage}
          onCancel={isActive ? handleCancel : undefined}
        />

        {/* In-progress view */}
        {(isActive || (!isCompleted && !isFailed)) && (
          <div className="jd-progress-grid">
            <ActionLogPanel steps={stream.steps} llmLogs={stream.llmLogs} />
            <ScreenshotGallery screenshots={stream.screenshots} />
          </div>
        )}

        {/* Completed view */}
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

        {/* Failed view */}
        {isFailed && (
          <div className="card jd-failed-card">
            <div className="jd-failed-header">
              <span>❌</span>
              <div>
                <h2>Generation Failed</h2>
                {stream.error && (
                  <p className="text-muted text-sm mt-2">{stream.error}</p>
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

        {/* Unverified download modal */}
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
