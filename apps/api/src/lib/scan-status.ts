import type { Job, JobType, Queue } from "bullmq";
import type { ScanJobData } from "../plugins/queue";

export interface ScanProgress {
  phase: string;
  processed?: number;
  total?: number;
  added?: number;
  updated?: number;
  skipped?: number;
  matched?: number;
  message?: string;
}

export interface ActiveScan extends ScanProgress {
  jobId: string;
  state: string;
}

const ACTIVE_SCAN_TYPES: JobType[] = ["active", "waiting", "delayed", "prioritized", "waiting-children", "paused", "wait"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberField(progress: Record<string, unknown>, key: keyof ScanProgress): number | undefined {
  const value = progress[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function progressFromJob(job: Job<ScanJobData>, state: string): ScanProgress {
  if (isRecord(job.progress) && typeof job.progress.phase === "string") {
    return {
      phase: job.progress.phase,
      processed: numberField(job.progress, "processed"),
      total: numberField(job.progress, "total"),
      added: numberField(job.progress, "added"),
      updated: numberField(job.progress, "updated"),
      skipped: numberField(job.progress, "skipped"),
      matched: numberField(job.progress, "matched"),
      message: typeof job.progress.message === "string" ? job.progress.message : undefined,
    };
  }
  return { phase: state === "active" ? "scanning" : "queued" };
}

async function scanFromJob(job: Job<ScanJobData>): Promise<ActiveScan | null> {
  const jobId = job.data?.jobId;
  if (!jobId) return null;
  const state = await job.getState();
  return { jobId, state, ...progressFromJob(job, state) };
}

export async function activeScansByLibrary(
  queue: Queue<ScanJobData>,
  libraryIds: readonly string[],
): Promise<Map<string, ActiveScan>> {
  if (libraryIds.length === 0 || typeof queue.getJobs !== "function") return new Map();

  const wanted = new Set(libraryIds);
  const jobs = await queue.getJobs(ACTIVE_SCAN_TYPES, 0, 500, true);
  const newest = new Map<string, Job<ScanJobData>>();

  for (const job of jobs as Job<ScanJobData>[]) {
    const libraryId = job.data?.libraryId;
    if (!wanted.has(libraryId)) continue;
    const current = newest.get(libraryId);
    if (!current || job.timestamp > current.timestamp) newest.set(libraryId, job);
  }

  const scans = new Map<string, ActiveScan>();
  for (const [libraryId, job] of newest) {
    const scan = await scanFromJob(job);
    if (scan) scans.set(libraryId, scan);
  }
  return scans;
}

export async function findActiveScanForLibrary(
  queue: Queue<ScanJobData>,
  libraryId: string,
): Promise<ActiveScan | null> {
  return (await activeScansByLibrary(queue, [libraryId])).get(libraryId) ?? null;
}
