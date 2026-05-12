import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RecentJob, JobStatus } from '../../types';
import './RecentJobs.css';

const STORAGE_KEY = 'recent_jobs';
const MAX_RECENT = 20;

export function saveRecentJob(job: RecentJob): void {
  const existing = loadRecentJobs();
  const filtered = existing.filter((j) => j.hash !== job.hash);
  const updated = [job, ...filtered].slice(0, MAX_RECENT);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export function loadRecentJobs(): RecentJob[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as RecentJob[];
  } catch {
    return [];
  }
}

function statusEmoji(status: JobStatus): string {
  const map: Record<JobStatus, string> = {
    queued: '⏳',
    exploring: '🔍',
    generating: '✨',
    verifying: '🧪',
    self_healing: '🩹',
    completed: '✅',
    failed: '❌',
  };
  return map[status] ?? '•';
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url;
  }
}

export default function RecentJobs() {
  const [jobs, setJobs] = useState<RecentJob[]>([]);

  useEffect(() => {
    setJobs(loadRecentJobs());
  }, []);

  if (jobs.length === 0) return null;

  return (
    <div className="recent-jobs">
      <div className="recent-jobs-header">
        <span className="text-muted text-sm">Recent Jobs</span>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            localStorage.removeItem(STORAGE_KEY);
            setJobs([]);
          }}
        >
          Clear
        </button>
      </div>
      <div className="recent-jobs-list">
        {jobs.map((job) => (
          <Link key={job.hash} to={`/jobs/${job.hash}`} className="recent-job-item">
            <span className="recent-job-status">{statusEmoji(job.status)}</span>
            <span className="recent-job-url truncate">{shortenUrl(job.url)}</span>
            <span className="recent-job-meta text-faint text-xs">
              {timeAgo(job.createdAt)}
              {job.scenarioCount !== undefined && ` · ${job.scenarioCount} scenarios`}
            </span>
            <span className="recent-job-hash font-mono text-xs text-faint">
              #{job.hash.slice(0, 7)}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
