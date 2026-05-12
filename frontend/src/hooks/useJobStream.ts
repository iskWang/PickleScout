/**
 * useJobStream — SSE hook for real-time job progress.
 *
 * Manages EventSource lifecycle with Last-Event-ID reconnection.
 * PRD §4.4, §8.2
 */

import { useEffect, useRef, useState } from 'react';
import type { JobStatus, JobSummary, StreamEvent, TokenUsage } from '../types';

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

const TERMINAL_STATUSES = new Set<JobStatus>(['completed', 'failed']);

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

      const url = `/api/jobs/${hash}/stream`;
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
              return { ...prev, screenshots: [...prev.screenshots, event.url] };

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
              return {
                ...prev,
                status: 'completed',
                summary: event.summary,
                resultUrl: event.resultUrl,
              };

            case 'error':
              return { ...prev, error: event.message };

            default:
              return prev;
          }
        });

        // Close if terminal
        if (
          event.type === 'complete' ||
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
