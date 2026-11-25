import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { candidateFingerprint, type GeneratedLesson } from "./reflection.js";

export type JobTrigger = "idle" | "archive" | "manual";
export type JobStatus =
  | "queued"
  | "running"
  | "retryable_failed"
  | "review_pending"
  | "no_lessons"
  | "succeeded"
  | "terminal_failed"
  | "cancelled";
export type CandidateStatus = "pending_review" | "saving" | "saved" | "rejected" | "conflict" | "blocked";

export interface JobRow {
  id: string;
  dedupe_key: string;
  source_thread_id: string;
  project_id: string;
  source_seq: number;
  trigger: JobTrigger;
  status: JobStatus;
  attempts: number;
  next_attempt_at: number;
  lease_token: string | null;
  lease_until: number | null;
  worker_thread_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

export interface CandidateRow {
  id: string;
  job_id: string;
  fingerprint: string;
  kind: GeneratedLesson["kind"];
  name: string;
  summary: string;
  details: string;
  reason: string;
  tags_json: string;
  importance: number;
  confidence: number;
  evidence_refs_json: string;
  explicit_remember: number;
  status: CandidateStatus;
  status_message: string | null;
  memory_id: string | null;
  created_at: number;
  updated_at: number;
}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS reflection_jobs (
    id TEXT PRIMARY KEY,
    dedupe_key TEXT NOT NULL UNIQUE,
    source_thread_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    source_seq INTEGER NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    lease_token TEXT,
    lease_until INTEGER,
    worker_thread_id TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS reflection_jobs_due
    ON reflection_jobs(status, next_attempt_at, lease_until, created_at)`,
  `CREATE TABLE IF NOT EXISTS reflection_candidates (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES reflection_jobs(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    summary TEXT NOT NULL,
    details TEXT NOT NULL,
    reason TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    importance INTEGER NOT NULL,
    confidence REAL NOT NULL,
    evidence_refs_json TEXT NOT NULL,
    explicit_remember INTEGER NOT NULL,
    status TEXT NOT NULL,
    status_message TEXT,
    memory_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(job_id, fingerprint)
  )`,
  `CREATE INDEX IF NOT EXISTS reflection_candidates_review
    ON reflection_candidates(status, created_at)`,
];

export class ReflectionStore {
  constructor(private readonly db: Database.Database, migrate: (db: Database.Database, statements: string[]) => void) {
    this.db.pragma("foreign_keys = ON");
    migrate(this.db, MIGRATIONS);
  }

  recoverInterruptedSaves(): void {
    const recover = this.db.transaction(() => {
      const jobs = this.db.prepare("SELECT DISTINCT job_id FROM reflection_candidates WHERE status = 'saving'")
        .all() as Array<{ job_id: string }>;
      if (jobs.length === 0) return;

      this.db.prepare(`UPDATE reflection_candidates
        SET status = 'blocked', status_message = ?, updated_at = ?
        WHERE status = 'saving'`)
        .run("Сохранение прервалось. Проверь BB Memory перед повторной записью.", Date.now());
      for (const job of jobs) this.refreshJobStatus(job.job_id);
    });
    recover();
  }

  enqueue(input: {
    sourceThreadId: string;
    projectId: string;
    sourceSeq: number;
    trigger: JobTrigger;
  }): { job: JobRow; alreadyQueued: boolean } {
    const dedupeKey = `${input.projectId}:${input.sourceThreadId}:${input.sourceSeq}:v1`;
    const id = randomUUID();
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO reflection_jobs
        (id, dedupe_key, source_thread_id, project_id, source_seq, trigger, status,
         attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
    `).run(id, dedupeKey, input.sourceThreadId, input.projectId, input.sourceSeq, input.trigger, now, now, now);
    const job = this.db.prepare("SELECT * FROM reflection_jobs WHERE dedupe_key = ?").get(dedupeKey) as JobRow;
    return { job, alreadyQueued: result.changes === 0 };
  }

  claimNext(now = Date.now(), leaseMs = 180_000): JobRow | null {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM reflection_jobs
        WHERE (status IN ('queued', 'retryable_failed') AND next_attempt_at <= ?)
           OR (status = 'running' AND lease_until <= ?)
        ORDER BY created_at ASC LIMIT 1
      `).get(now, now) as JobRow | undefined;
      if (!row) return null;
      const token = randomUUID();
      const updated = this.db.prepare(`
        UPDATE reflection_jobs
        SET status = 'running', attempts = attempts + 1, lease_token = ?,
            lease_until = ?, error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ? AND ((status IN ('queued', 'retryable_failed') AND next_attempt_at <= ?)
          OR (status = 'running' AND lease_until <= ?))
      `).run(token, now + leaseMs, now, row.id, now, now);
      if (updated.changes !== 1) return null;
      return this.db.prepare("SELECT * FROM reflection_jobs WHERE id = ?").get(row.id) as JobRow;
    });
    return claim();
  }

  setWorkerThread(jobId: string, leaseToken: string, threadId: string): void {
    this.db.prepare(`UPDATE reflection_jobs SET worker_thread_id = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_token = ?`)
      .run(threadId, Date.now(), jobId, leaseToken);
  }

  clearWorkerThread(jobId: string, threadId: string): void {
    this.db.prepare(`UPDATE reflection_jobs SET worker_thread_id = NULL, updated_at = ?
      WHERE id = ? AND worker_thread_id = ?`)
      .run(Date.now(), jobId, threadId);
  }

  finishWithoutLessons(job: JobRow, leaseToken: string, message = ""): void {
    this.db.prepare(`UPDATE reflection_jobs
      SET status = 'no_lessons', lease_token = NULL, lease_until = NULL,
          error_code = NULL, error_message = ?, updated_at = ?
      WHERE id = ? AND lease_token = ?`)
      .run(message || null, Date.now(), job.id, leaseToken);
  }

  addCandidates(job: JobRow, leaseToken: string, lessons: Array<{
    lesson: GeneratedLesson;
    explicitRemember: boolean;
  }>): CandidateRow[] {
    const now = Date.now();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO reflection_candidates
        (id, job_id, fingerprint, kind, name, summary, details, reason, tags_json,
         importance, confidence, evidence_refs_json, explicit_remember, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?)
    `);
    const tx = this.db.transaction(() => {
      const current = this.db.prepare("SELECT id FROM reflection_jobs WHERE id = ? AND lease_token = ? AND status = 'running'")
        .get(job.id, leaseToken);
      if (!current) throw new Error("job_lease_lost");
      for (const item of lessons) {
        const { lesson } = item;
        const fingerprint = candidateFingerprint(lesson);
        const alreadyReflected = this.db.prepare(`SELECT 1 FROM reflection_candidates c
          JOIN reflection_jobs j ON j.id = c.job_id
          WHERE j.source_thread_id = ? AND c.fingerprint = ? LIMIT 1`)
          .get(job.source_thread_id, fingerprint);
        if (alreadyReflected) continue;
        insert.run(
          randomUUID(), job.id, fingerprint, lesson.kind, lesson.name,
          lesson.summary, lesson.details, lesson.reason, JSON.stringify(lesson.tags),
          lesson.importance, lesson.confidence, JSON.stringify(lesson.evidence_refs),
          item.explicitRemember ? 1 : 0, now, now,
        );
      }
      const pending = this.db.prepare(`SELECT COUNT(*) AS count FROM reflection_candidates
        WHERE job_id = ? AND status IN ('pending_review', 'saving', 'conflict', 'blocked')`)
        .get(job.id) as { count: number };
      this.db.prepare(`UPDATE reflection_jobs
        SET status = ?, lease_token = NULL, lease_until = NULL,
            error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ? AND lease_token = ?`).run(pending.count > 0 ? "review_pending" : "succeeded", now, job.id, leaseToken);
    });
    tx();
    return this.listCandidatesForJob(job.id);
  }

  finishCandidates(job: JobRow, leaseToken: string, lessons: Array<{
    lesson: GeneratedLesson;
    explicitRemember: boolean;
  }>): void {
    if (lessons.length === 0) {
      this.finishWithoutLessons(job, leaseToken);
      return;
    }
    this.addCandidates(job, leaseToken, lessons);
  }

  markCandidateSaving(candidateId: string): CandidateRow | null {
    const updated = this.db.prepare(`UPDATE reflection_candidates
      SET status = 'saving', status_message = NULL, updated_at = ?
      WHERE id = ? AND status IN ('pending_review', 'conflict', 'blocked')`).run(Date.now(), candidateId);
    return updated.changes ? this.getCandidate(candidateId) : null;
  }

  markCandidate(candidateId: string, status: CandidateStatus, message: string | null, memoryId: string | null = null): void {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare("SELECT job_id FROM reflection_candidates WHERE id = ?").get(candidateId) as { job_id: string } | undefined;
      if (!row) throw new Error("candidate_not_found");
      this.db.prepare(`UPDATE reflection_candidates
        SET status = ?, status_message = ?, memory_id = ?, updated_at = ? WHERE id = ?`)
        .run(status, message, memoryId, Date.now(), candidateId);
      this.refreshJobStatus(row.job_id);
    });
    tx();
  }

  rejectCandidate(candidateId: string, message: string): boolean {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare("SELECT job_id FROM reflection_candidates WHERE id = ?")
        .get(candidateId) as { job_id: string } | undefined;
      if (!row) return false;
      const updated = this.db.prepare(`UPDATE reflection_candidates
        SET status = 'rejected', status_message = ?, updated_at = ?
        WHERE id = ? AND status IN ('pending_review', 'conflict', 'blocked')`)
        .run(message, Date.now(), candidateId);
      if (updated.changes === 0) return false;
      this.refreshJobStatus(row.job_id);
      return true;
    });
    return tx();
  }

  failJob(job: JobRow, leaseToken: string, errorCode: string, errorMessage: string, retryable: boolean): void {
    const attempts = job.attempts;
    const delayMs = Math.min(15 * 60_000, 15_000 * 2 ** Math.max(0, attempts - 1));
    const status = retryable && attempts < 5 ? "retryable_failed" : "terminal_failed";
    this.db.prepare(`UPDATE reflection_jobs
      SET status = ?, next_attempt_at = ?, lease_token = NULL, lease_until = NULL,
          error_code = ?, error_message = ?, updated_at = ?
      WHERE id = ? AND lease_token = ?`)
      .run(status, Date.now() + delayMs, errorCode.slice(0, 80), errorMessage.slice(0, 500), Date.now(), job.id, leaseToken);
  }

  cancelJob(jobId: string, message = "Cancelled because reflection is disabled"): void {
    this.db.prepare(`UPDATE reflection_jobs
      SET status = 'cancelled', lease_token = NULL, lease_until = NULL,
          error_code = 'cancelled', error_message = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'retryable_failed', 'running')`)
      .run(message, Date.now(), jobId);
  }

  retryJob(jobId: string): JobRow | null {
    const updated = this.db.prepare(`UPDATE reflection_jobs
      SET status = 'queued', attempts = 0, next_attempt_at = ?, lease_token = NULL,
          lease_until = NULL, error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ? AND status IN ('retryable_failed', 'terminal_failed')`)
      .run(Date.now(), Date.now(), jobId);
    return updated.changes ? this.getJob(jobId) : null;
  }

  purgeThread(threadId: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM reflection_candidates WHERE job_id IN
        (SELECT id FROM reflection_jobs WHERE source_thread_id = ? AND status != 'succeeded')`).run(threadId);
      this.db.prepare(`UPDATE reflection_jobs SET status = 'cancelled', lease_token = NULL,
        lease_until = NULL, error_code = 'source_deleted', error_message = NULL, updated_at = ?
        WHERE source_thread_id = ? AND status IN ('queued', 'retryable_failed', 'running', 'review_pending')`)
        .run(Date.now(), threadId);
    })();
  }

  getJob(id: string): JobRow | null {
    return (this.db.prepare("SELECT * FROM reflection_jobs WHERE id = ?").get(id) as JobRow | undefined) ?? null;
  }

  getCandidate(id: string): CandidateRow | null {
    return (this.db.prepare("SELECT * FROM reflection_candidates WHERE id = ?").get(id) as CandidateRow | undefined) ?? null;
  }

  candidateContext(id: string): (CandidateRow & { project_id: string; source_thread_id: string }) | null {
    return (this.db.prepare(`SELECT c.*, j.project_id, j.source_thread_id
      FROM reflection_candidates c JOIN reflection_jobs j ON j.id = c.job_id WHERE c.id = ?`)
      .get(id) as (CandidateRow & { project_id: string; source_thread_id: string }) | undefined) ?? null;
  }

  getJobForWorker(threadId: string): JobRow | null {
    return (this.db.prepare("SELECT * FROM reflection_jobs WHERE worker_thread_id = ? LIMIT 1").get(threadId) as JobRow | undefined) ?? null;
  }

  listOverview(): { jobs: JobRow[]; candidates: Array<CandidateRow & { source_thread_id: string }> } {
    const jobs = this.db.prepare("SELECT * FROM reflection_jobs ORDER BY created_at DESC LIMIT 40").all() as JobRow[];
    const candidates = this.db.prepare(`SELECT c.*, j.source_thread_id
      FROM reflection_candidates c JOIN reflection_jobs j ON j.id = c.job_id
      WHERE c.status IN ('pending_review', 'conflict', 'blocked')
      ORDER BY c.created_at DESC LIMIT 100`).all() as Array<CandidateRow & { source_thread_id: string }>;
    return { jobs, candidates };
  }

  counts(): Array<{ status: string; count: number }> {
    return this.db.prepare("SELECT status, COUNT(*) AS count FROM reflection_jobs GROUP BY status")
      .all() as Array<{ status: string; count: number }>;
  }

  cleanup(retentionDays: number): void {
    const cutoff = Date.now() - Math.max(1, retentionDays) * 86_400_000;
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM reflection_candidates WHERE updated_at < ?
        AND status IN ('saved', 'rejected', 'blocked')`).run(cutoff);
      this.db.prepare(`DELETE FROM reflection_jobs WHERE updated_at < ?
        AND status IN ('no_lessons', 'succeeded', 'cancelled', 'terminal_failed')
        AND NOT EXISTS (SELECT 1 FROM reflection_candidates c WHERE c.job_id = reflection_jobs.id)`)
        .run(cutoff);
    })();
  }

  private listCandidatesForJob(jobId: string): CandidateRow[] {
    return this.db.prepare("SELECT * FROM reflection_candidates WHERE job_id = ? ORDER BY created_at, id")
      .all(jobId) as CandidateRow[];
  }

  private refreshJobStatus(jobId: string): void {
    const remaining = this.db.prepare(`SELECT COUNT(*) AS count FROM reflection_candidates
      WHERE job_id = ? AND status IN ('pending_review', 'saving', 'conflict', 'blocked')`)
      .get(jobId) as { count: number };
    this.db.prepare(`UPDATE reflection_jobs SET status = ?, updated_at = ?
      WHERE id = ? AND status IN ('review_pending', 'succeeded')`)
      .run(remaining.count > 0 ? "review_pending" : "succeeded", Date.now(), jobId);
  }
}
