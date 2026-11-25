import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const jobSchema = z.object({
  id: z.string(),
  sourceThreadId: z.string(),
  projectId: z.string(),
  sourceSeq: z.number().int(),
  trigger: z.enum(["idle", "archive", "manual"]),
  status: z.enum([
    "queued",
    "running",
    "retryable_failed",
    "review_pending",
    "no_lessons",
    "succeeded",
    "terminal_failed",
    "cancelled",
  ]),
  attempts: z.number().int(),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const candidateSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  sourceThreadId: z.string(),
  kind: z.enum(["fact", "preference", "decision", "procedure", "episode", "reference"]),
  name: z.string(),
  summary: z.string(),
  details: z.string(),
  reason: z.string(),
  tags: z.array(z.string()),
  importance: z.number().int(),
  confidence: z.number(),
  evidenceRefs: z.array(z.string()),
  explicitRemember: z.boolean(),
  status: z.enum(["pending_review", "saving", "saved", "rejected", "conflict", "blocked"]),
  statusMessage: z.string().nullable(),
  memoryId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const rpcContract = defineRpcContract({
  overview: {
    input: z.null(),
    output: z.object({
      enabled: z.boolean(),
      autoSaveExplicit: z.boolean(),
      autoSaveHighConfidence: z.boolean(),
      autoSaveConfidenceThreshold: z.number(),
      jobs: z.array(jobSchema),
      candidates: z.array(candidateSchema),
    }),
  },
  reflect: {
    input: z.object({ threadId: z.string().min(1).max(200) }).strict(),
    output: z.object({ job: jobSchema, alreadyQueued: z.boolean() }),
  },
  candidate_action: {
    input: z.object({
      candidateId: z.string().min(1).max(200),
      action: z.enum(["save", "reject"]),
      scope: z.enum(["project", "global"]).optional(),
    }).strict(),
    output: z.object({ status: candidateSchema.shape.status, message: z.string() }),
  },
});

export type ReflectionJob = z.infer<typeof jobSchema>;
export type ReflectionCandidate = z.infer<typeof candidateSchema>;
