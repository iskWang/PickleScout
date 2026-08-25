import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import JobDetailPage from './JobDetailPage';

const streamState = {
  status: null,
  steps: [],
  screenshots: [],
  llmLogs: [],
  tokenUsage: null,
  summary: null,
  resultUrl: null,
  verificationPassed: null,
  verificationErrors: [],
  error: null,
  connected: false,
};

vi.mock('../hooks/useJobStream', () => ({
  TERMINAL_STATUSES: new Set(['completed', 'failed']),
  useJobStream: () => streamState,
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/jobs/job-1']}>
      <Routes>
        <Route path="/jobs/:hash" element={<JobDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('JobDetailPage status fallback', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.assign(streamState, {
      status: null,
      error: null,
      steps: [],
      screenshots: [],
      llmLogs: [],
      summary: null,
      verificationErrors: [],
    });
  });

  it('uses failed status and error from GET when SSE has not delivered a status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'failed', error: 'worker exploded', url: 'https://example.com' }), { status: 200 }));

    renderPage();

    await waitFor(() => expect(screen.getByText('Generation Failed')).toBeInTheDocument());
    expect(screen.getByText('worker exploded')).toBeInTheDocument();
  });

  it('shows an expired not-found state for a missing job instead of empty progress', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));

    renderPage();

    await waitFor(() => expect(screen.getByText(/not found|expired/i)).toBeInTheDocument());
    expect(screen.queryByText('No activity yet')).not.toBeInTheDocument();
  });

  it('keeps a newer SSE active status over an older polling status', async () => {
    Object.assign(streamState, { status: 'generating' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'queued', url: 'https://example.com' }), { status: 200 }));

    renderPage();

    await waitFor(() => expect(screen.getByText('Generating')).toBeInTheDocument());
    expect(screen.queryByText('Queued')).not.toBeInTheDocument();
  });

  it('does not let an older polling terminal status replace a newer SSE terminal status', async () => {
    Object.assign(streamState, {
      status: 'completed',
      summary: {
        scenarioCount: 3,
        unhealedScenarios: 0,
        featureFiles: [],
        verificationPassed: true,
        totalTokens: 0,
        estimatedCostUSD: 0,
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'generating', url: 'https://example.com' }), { status: 200 }));

    renderPage();

    await waitFor(() => expect(screen.getByText('Generation Complete')).toBeInTheDocument());
    expect(screen.queryByText('Generation Failed')).not.toBeInTheDocument();
  });
});
