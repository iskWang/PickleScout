/**
 * useJobStream — SSE hook for real-time job progress.
 *
 * Manages EventSource lifecycle with Last-Event-ID reconnection.
 * PRD §4.4, §8.2
 */

import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../lib/api';
import type { JobStatus, JobSummary, StreamEvent, TokenUsage } from '../types';

const toAbsoluteUrl = (url: string) =>
  url.startsWith('http') ? url : `${API_BASE}${url}`;

export interface StepEntry {
  stepNumber: number;
  action: string;
  selector?: string;
  done: boolean;
}

export interface JobStreamState {
  status: JobStatus | null;
  steps: StepEntry[];
  screenshots: string[];
  llmLogs: string[];
  tokenUsage: TokenUsage | null;
  summary: JobSummary | null;
  resultUrl: string | null;
  verificationPassed: boolean | null;
  verificationErrors: string[];
  error: string | null;
  connected: boolean;
}

export const TERMINAL_STATUSES = new Set<JobStatus>(['completed', 'failed']);

export function useJobStream(hash: string): JobStreamState {
  const [state, setState] = useState<JobStreamState>({
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
  });

  const lastEventIdRef = useRef<number | undefined>(undefined);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!hash) return;

    let active = true;

    const connect = () => {
      if (!active) return;

      const url = `${API_BASE}/api/jobs/${hash}/stream`;
      const es = new EventSource(url);
      esRef.current = es;

      setState((prev) => ({ ...prev, connected: false }));

      es.onopen = () => {
        if (active) setState((prev) => ({ ...prev, connected: true }));
      };

      es.onerror = () => {
        setState((prev) => ({ ...prev, connected: false }));
        // EventSource auto-reconnects
      };

      es.onmessage = (msgEvent) => {
        if (!active) return;

        let event: StreamEvent;
        try {
          event = JSON.parse(msgEvent.data as string) as StreamEvent;
        } catch {
          return;
        }

        lastEventIdRef.current = event.id;

        setState((prev) => {
          switch (event.type) {
            case 'status':
              return { ...prev, status: event.status };

            case 'step': {
              const steps = prev.steps.map((s) =>
                s.stepNumber === event.stepNumber - 1 ? { ...s, done: true } : s
              );
              return {
                ...prev,
                steps: [
                  ...steps,
                  { stepNumber: event.stepNumber, action: event.action, selector: event.selector, done: false },
                ],
              };
            }

            case 'screenshot':
              return { ...prev, screenshots: [...prev.screenshots, toAbsoluteUrl(event.url)] };

            case 'llm_log':
              return { ...prev, llmLogs: [...prev.llmLogs, event.message] };

            case 'token_usage':
              return { ...prev, tokenUsage: event.cumulative };

            case 'verification':
              return {
                ...prev,
                verificationPassed: event.passed,
                verificationErrors: event.errors ?? [],
              };

            case 'complete':
              // Carry the summary + resultUrl, but DON'T mark the job completed here.
              // Status is owned by `status` events — flipping to 'completed' on `complete`
              // races the backend, which still writes `status: failed` afterward when
              // verification failed or hallucinationRisk is set.
              return {
                ...prev,
                summary: event.summary,
                resultUrl: event.resultUrl,
              };

            case 'error':
              return { ...prev, error: event.message, status: 'failed' };

            default:
              return prev;
          }
        });

        // Close only on a terminal `status` event or non-retryable error.
        // `complete` is NOT a terminator — the backend still emits `status` afterward,
        // and on failed/hallucinated runs that final status decides UI state.
        if (
          (event.type === 'status' && TERMINAL_STATUSES.has(event.status)) ||
          (event.type === 'error' && !event.retryable)
        ) {
          es.close();
        }
      };
    };

    connect();

    return () => {
      active = false;
      esRef.current?.close();
    };
  }, [hash]);

  return state;
}
