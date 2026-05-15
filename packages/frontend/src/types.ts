export * from '@picklescout/shared';

// Frontend-only type — stored in localStorage, not sent to the server.
export interface RecentJob {
  hash: string;
  url: string;
  createdAt: number;
  status: import('@picklescout/shared').JobStatus;
  scenarioCount?: number;
}
