import { existsSync } from "node:fs";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { addMemoryCandidate, MemoryCliError } from "./lib/memory-cli.js";
import {
  buildReflectionPrompt,
  choosePermissionMode,
  filterSupportedLessons,
  parseReflectionResult,
  readReflectionMessages,
  selectCandidatesToAutoSave,
  type AutoSavePolicy,
  type ReflectionMessage,
} from "./lib/reflection.js";
import {
  ReflectionStore,
  type CandidateStatus,
  type CandidateRow,
  type JobRow,
  type JobTrigger,
} from "./lib/store.js";
import { rpcContract } from "./rpc.js";

const CHANGED = "memory-reflection-changed";
const WORKER_TITLE = "Memory Reflection · temporary worker";
const MAX_WORKER_WAIT_MS = 300_000;
type CandidateSaveStatus = Extract<CandidateStatus, "saved" | "conflict" | "blocked" | "pending_review">;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jobView(row: JobRow) {
  return {
    id: row.id,
    sourceThreadId: row.source_thread_id,
    projectId: row.project_id,
    sourceSeq: row.source_seq,
    trigger: row.trigger,
    status: row.status,
    attempts: row.attempts,
    error: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function candidateView(row: CandidateRow & { source_thread_id?: string }) {
  return {
    id: row.id,
    jobId: row.job_id,
    sourceThreadId: row.source_thread_id ?? "",
    kind: row.kind,
    name: row.name,
    summary: row.summary,
    details: row.details,
    reason: row.reason,
    tags: JSON.parse(row.tags_json) as string[],
    importance: row.importance,
    confidence: row.confidence,
    evidenceRefs: JSON.parse(row.evidence_refs_json) as string[],
    explicitRemember: row.explicit_remember === 1,
    status: row.status,
    statusMessage: row.status_message,
    memoryId: row.memory_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function generatedErrorCode(error: unknown): string {
  if (error instanceof MemoryCliError) return error.code;
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  return "reflection_failed";
}

function generatedErrorIsRetryable(error: unknown): boolean {
  return !(error instanceof MemoryCliError && error.code === "source_deleted");
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Включить auto-reflection",
      default: false,
    },
    reflectOnIdle: {
      type: "boolean",
      label: "Рефлексировать после завершения хода",
      default: false,
    },
    reflectOnArchive: {
      type: "boolean",
      label: "Рефлексировать при архивировании потока",
      default: true,
    },
    autoSaveExplicit: {
      type: "boolean",
      label: "Автоматически сохранять только явные просьбы «запомни»",
      default: true,
    },
    autoSaveHighConfidence: {
      type: "boolean",
      label: "Сохранять в память проекта без ревью уроки с высоким доверием",
      default: false,
    },
    autoSaveConfidenceThreshold: {
      type: "number",
      label: "Порог доверия для автосохранения, %",
      experimental_schema: z.number().int().min(50).max(100),
      default: 90,
    },
    maxSourceChars: {
      type: "number",
      label: "Максимум символов источника для одной рефлексии",
      experimental_schema: z.number().int().min(2_000).max(48_000),
      default: 16_000,
    },
    retentionDays: {
      type: "number",
      label: "Хранить результаты и предложения, дней",
      experimental_schema: z.number().int().min(1).max(365),
      default: 30,
    },
  });

  const db = bb.storage.database();
  const store = new ReflectionStore(db, (database, statements) => bb.storage.migrate(database, statements));
  store.recoverInterruptedSaves();

  function publishChanged() {
    bb.realtime.publish(CHANGED, { at: Date.now() });
  }

  async function resolveLocalProjectPath(projectId: string): Promise<string> {
    const [project, config] = await Promise.all([
      bb.sdk.projects.get({ projectId }),
      bb.sdk.system.config(),
    ]);
    const source = project.sources.find((item) => item.isDefault) ?? project.sources[0];
    if (!source || !config.primaryHostId || source.hostId !== config.primaryHostId || !existsSync(source.path)) {
      throw new MemoryCliError(
        "Для записи в BB Memory нужен локальный source проекта на серверной машине; удалённые проекты пока поддерживаются только для review.",
        "project_not_local",
      );
    }
    return source.path;
  }

  async function latestSequence(threadId: string): Promise<number> {
    const rows = await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "1" });
    const seq = rows[0]?.seq;
    if (typeof seq !== "number" || seq < 1) throw new MemoryCliError("В потоке пока нет событий для рефлексии", "empty_thread");
    return seq;
  }

  async function enqueueThread(thread: {
    id: string;
    projectId: string | null;
    originPluginId: string | null;
    visibility: string;
  }, trigger: JobTrigger) {
    if (thread.projectId === null || thread.originPluginId === bb.pluginId || thread.visibility === "hidden") return null;
    const sourceSeq = await latestSequence(thread.id);
    const queued = store.enqueue({
      sourceThreadId: thread.id,
      projectId: thread.projectId,
      sourceSeq,
      trigger,
    });
    publishChanged();
    return queued;
  }

  async function cleanupWorkerThread(threadId: string): Promise<void> {
    try {
      await bb.sdk.threads.archive({ threadId });
    } catch {
      // Continue to stop/delete: an archive can fail after a provider crash.
    }
    try {
      await bb.sdk.threads.stop({ threadId });
    } catch {
      // Continue to delete the temporary prompt-bearing thread.
    }
    try {
      await bb.sdk.threads.delete({ threadId, childThreadsConfirmed: false });
    } catch (error) {
      bb.log.warn(`Temporary reflection thread cleanup failed (${threadId}): ${errorText(error).slice(0, 160)}`);
    }
  }

  async function reconcileWorkerThreads(signal: AbortSignal): Promise<void> {
    const threads = await bb.sdk.threads.list({
      originPluginId: bb.pluginId,
      includeHidden: true,
      limit: 100,
      signal,
    });
    for (const thread of threads) {
      if (signal.aborted) return;
      if (thread.visibility !== "hidden") continue;
      let metadata: Record<string, unknown>;
      try {
        metadata = await bb.sdk.threads.getPluginMetadata({ threadId: thread.id, signal });
      } catch {
        continue;
      }
      if (metadata.memoryReflectionWorker !== true) continue;
      const job = store.getJobForWorker(thread.id);
      if (job?.lease_token) {
        store.failJob(job, job.lease_token, "worker_recovered", "Temporary worker was recovered after plugin restart", true);
      }
      await cleanupWorkerThread(thread.id);
      if (job) store.clearWorkerThread(job.id, thread.id);
    }
  }

  const PERMISSION_MODE_PREFERENCE = ["auto", "accept-edits", "full"] as const;
type ReflectionPermissionMode = (typeof PERMISSION_MODE_PREFERENCE)[number];

async function reflectionPermissionMode(
  bb: BbPluginApi,
  providerId: string,
  signal: AbortSignal,
): Promise<ReflectionPermissionMode | undefined> {
  let supported: readonly string[] | null = null;
  try {
    const providers = await bb.sdk.providers.list({ signal });
    const provider = providers.find((item) => item.id === providerId);
    supported = provider ? provider.capabilities.permissionModes : null;
  } catch {
    // An unreadable catalog must not block generation; the preferred mode is the least permissive one.
    supported = null;
  }
  // Null means the catalog did not describe this provider: keep the mode BB would choose on its own.
  if (supported === null) return undefined;
  // An empty list means the provider has no permission modes at all, so the field must stay unset.
  const mode = choosePermissionMode(supported);
  if (!mode) return undefined;
  if (mode === "full") {
    bb.log.warn(`Провайдер ${providerId} поддерживает только режим full; временный обработчик рефлексии запущен с полными разрешениями`);
  }
  return mode;
}

async function generateReflection(job: JobRow, messages: ReflectionMessage[], signal: AbortSignal): Promise<string> {
    const [sourceThread, projects] = await Promise.all([
      bb.sdk.threads.get({ threadId: job.source_thread_id, signal }),
      bb.sdk.projects.list({ includePersonal: true, signal }),
    ]);
    const personalProject = projects.find((project) => project.kind === "personal");
    if (!personalProject) throw new Error("Не найден личный проект BB для временного потока рефлексии");
    const permissionMode = await reflectionPermissionMode(bb, sourceThread.providerId, signal);
    const worker = await bb.sdk.threads.spawn({
      projectId: personalProject.id,
      environment: { type: "host", workspace: { type: "personal" } },
      providerId: sourceThread.providerId,
      ...(permissionMode ? { permissionMode } : {}),
      visibility: "hidden",
      title: WORKER_TITLE,
      pluginMetadata: { memoryReflectionWorker: true, jobId: job.id },
      prompt: buildReflectionPrompt(messages),
    });
    return await (async () => {
      try {
        // Store after spawn so a restart can find and clean up the prompt-bearing thread.
        const latest = store.getJob(job.id);
        if (latest?.lease_token) store.setWorkerThread(job.id, latest.lease_token, worker.id);
        const wait = await bb.sdk.threads.wait({
          threadId: worker.id,
          status: "idle",
          timeoutMs: MAX_WORKER_WAIT_MS,
          signal,
        });
        if (!wait.matched) throw new Error("reflection_worker_timeout");
        const result = await bb.sdk.threads.output({ threadId: worker.id, signal });
        if (!result.output) throw new Error("reflection_worker_empty_output");
        return result.output;
      } finally {
        await cleanupWorkerThread(worker.id);
        store.clearWorkerThread(job.id, worker.id);
      }
    })();
  }

  async function saveCandidate(
    candidateId: string,
    scope: "project" | "global",
    signal?: AbortSignal,
  ): Promise<{ status: CandidateSaveStatus; message: string }> {
    const context = store.candidateContext(candidateId);
    if (!context) throw new Error("Предложение не найдено");
    const candidate = store.markCandidateSaving(candidateId);
    if (!candidate) throw new Error("Предложение уже обработано или не найдено");
    try {
      const cwd = scope === "project" ? await resolveLocalProjectPath(context.project_id) : process.cwd();
      const result = await addMemoryCandidate(candidate, scope, cwd, {
        projectId: context.project_id,
        threadId: context.source_thread_id,
        serverUrl: bb.server.loopbackBaseUrl,
      }, signal);
      store.markCandidate(candidateId, "saved", `Сохранено в ${scope === "project" ? "память проекта" : "глобальную память"}`, result.memoryId);
      publishChanged();
      return { status: "saved" as const, message: "Урок записан в BB Memory" };
    } catch (error) {
      const code = error instanceof MemoryCliError ? error.code : "memory_write_failed";
      const status: CandidateSaveStatus = code === "possible_duplicate"
        ? "conflict"
        : code === "project_not_local"
          ? "blocked"
          : "pending_review";
      const message = errorText(error).slice(0, 500);
      store.markCandidate(candidateId, status, message);
      publishChanged();
      return { status, message };
    }
  }

  async function processJob(job: JobRow, signal: AbortSignal): Promise<void> {
    const config = await settings.get();
    if (job.trigger !== "manual" && !config.enabled) {
      store.cancelJob(job.id);
      publishChanged();
      return;
    }
    const thread = await bb.sdk.threads.get({ threadId: job.source_thread_id, signal });
    if (thread.projectId !== job.project_id) throw new MemoryCliError("Поток сменил проект после постановки в очередь", "source_changed");
    const messages = await readReflectionMessages(bb.sdk.threads, {
      threadId: job.source_thread_id,
      sourceSeq: job.source_seq,
      maxChars: config.maxSourceChars,
      signal,
    });
    const userMessages = messages.filter((message) => message.role === "user");
    if (userMessages.length === 0) {
      const lease = store.getJob(job.id)?.lease_token;
      if (lease) store.finishWithoutLessons(job, lease, "В снимке нет сообщений пользователя");
      publishChanged();
      return;
    }

    const output = await generateReflection(job, messages, signal);
    const result = parseReflectionResult(output);
    const safeLessons = filterSupportedLessons(result.lessons, messages);
    const current = store.getJob(job.id);
    if (!current?.lease_token) throw new Error("job_lease_lost");
    store.finishCandidates(current, current.lease_token, safeLessons);

    const policy: AutoSavePolicy | null = config.autoSaveHighConfidence
      ? { minConfidence: config.autoSaveConfidenceThreshold / 100, onlyExplicit: false }
      : config.enabled && config.autoSaveExplicit
        ? { minConfidence: 0.9, onlyExplicit: true }
        : null;
    if (policy) {
      // Project scope only: a global record still needs an explicit scope choice from the user.
      const candidates = store.listOverview().candidates.filter((candidate) => candidate.job_id === job.id);
      for (const candidate of selectCandidatesToAutoSave(candidates, policy)) {
        if (signal.aborted) break;
        await saveCandidate(candidate.id, "project", signal);
      }
    }
    publishChanged();
  }

  async function manualReflect(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.projectId) throw new Error("Для рефлексии нужен поток внутри BB-проекта");
    if (thread.originPluginId === bb.pluginId || thread.visibility === "hidden") {
      throw new Error("Скрытые потоки плагина не являются источниками рефлексии");
    }
    const queued = await enqueueThread(thread, "manual");
    if (!queued) throw new Error("Не удалось поставить поток в очередь");
    return queued;
  }

  bb.rpc.register(rpcContract, {
    overview: async () => {
      const config = await settings.get();
      const overview = store.listOverview();
      return {
        enabled: config.enabled,
        autoSaveExplicit: config.autoSaveExplicit,
        autoSaveHighConfidence: config.autoSaveHighConfidence,
        autoSaveConfidenceThreshold: config.autoSaveConfidenceThreshold,
        jobs: overview.jobs.map(jobView),
        candidates: overview.candidates.map(candidateView),
      };
    },
    reflect: async ({ threadId }) => {
      const queued = await manualReflect(threadId);
      return { job: jobView(queued.job), alreadyQueued: queued.alreadyQueued };
    },
    candidate_action: async ({ candidateId, action, scope }, context) => {
      if (action === "reject") {
        if (!store.rejectCandidate(candidateId, "Отклонено пользователем")) {
          throw new Error("Предложение уже обработано или не найдено");
        }
        publishChanged();
        return { status: "rejected" as const, message: "Предложение отклонено" };
      }
      if (scope !== "project" && scope !== "global") throw new Error("Для сохранения нужно явно выбрать область памяти");
      return saveCandidate(candidateId, scope, context.experimental_signal);
    },
  });

  bb.events.on("thread.idle", async ({ thread }) => {
    const config = await settings.get();
    if (!config.enabled || !config.reflectOnIdle) return;
    try {
      await enqueueThread(thread, "idle");
    } catch (error) {
      bb.log.warn(`Could not queue idle reflection for ${thread.id}: ${errorText(error).slice(0, 160)}`);
    }
  });

  bb.events.on("thread.archived", async ({ thread }) => {
    const config = await settings.get();
    if (!config.enabled || !config.reflectOnArchive) return;
    try {
      await enqueueThread(thread, "archive");
    } catch (error) {
      bb.log.warn(`Could not queue archive reflection for ${thread.id}: ${errorText(error).slice(0, 160)}`);
    }
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    store.purgeThread(thread.id);
    publishChanged();
  });

  bb.background.service("reflection-worker", {
    async start(signal) {
      await reconcileWorkerThreads(signal);
      while (!signal.aborted) {
        const job = store.claimNext();
        if (!job) {
          await delay(1_500, signal);
          continue;
        }
        const leaseToken = job.lease_token;
        if (!leaseToken) continue;
        try {
          await processJob(job, signal);
        } catch (error) {
          if (!signal.aborted) {
            const code = generatedErrorCode(error);
            store.failJob(job, leaseToken, code, errorText(error), generatedErrorIsRetryable(error));
            bb.log.warn(`Reflection job ${job.id} failed (${code}): ${errorText(error).slice(0, 180)}`);
            publishChanged();
          }
        }
      }
    },
  });

  bb.background.schedule("retention-cleanup", "13 3 * * *", async () => {
    const config = await settings.get();
    store.cleanup(config.retentionDays);
    publishChanged();
  });

  bb.cli.register({
    name: "memory-reflection",
    summary: "Review and manage automatic BB Memory reflections",
    commands: [
      { name: "status", summary: "Show queue status", usage: "bb memory-reflection status [--json]" },
      { name: "reflect", summary: "Queue a thread for reflection", usage: "bb memory-reflection reflect [thread-id] [--json]" },
      { name: "list", summary: "List reflection jobs and candidates", usage: "bb memory-reflection list [--json]" },
      { name: "approve", summary: "Save a reviewed candidate", usage: "bb memory-reflection approve <candidate-id> --scope project|global [--json]" },
      { name: "reject", summary: "Reject a candidate", usage: "bb memory-reflection reject <candidate-id> [--json]" },
      { name: "retry", summary: "Retry a failed job", usage: "bb memory-reflection retry <job-id> [--json]" },
    ],
    async run(argv, context) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const [command, ...rest] = args;
      const reply = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value) : text });
      const fail = (message: string) => ({ exitCode: 1, stderr: message });
      const usage = "Commands: status, reflect [thread-id], list, approve <candidate-id> --scope project|global, reject <candidate-id>, retry <job-id>";

      switch (command) {
        case "status": {
          const config = await settings.get();
          const overview = store.listOverview();
          const counts = store.counts();
          return reply({ enabled: config.enabled, autoSaveExplicit: config.autoSaveExplicit, counts },
            `Auto-reflection: ${config.enabled ? "включён" : "выключен"}\nПредложений на review: ${overview.candidates.length}`);
        }
        case "reflect": {
          const threadId = rest.find((value) => !value.startsWith("--")) ?? context.threadId;
          if (!threadId) return fail("Укажи thread-id или запускай команду из потока.\n" + usage);
          try {
            const queued = await manualReflect(threadId);
            return reply({ job: jobView(queued.job), alreadyQueued: queued.alreadyQueued },
              queued.alreadyQueued ? `Уже в очереди: ${queued.job.id}` : `Поставил в очередь: ${queued.job.id}`);
          } catch (error) {
            return fail(errorText(error));
          }
        }
        case "list": {
          const overview = store.listOverview();
          const value = {
            jobs: overview.jobs.map(jobView),
            candidates: overview.candidates.map(candidateView),
          };
          const lines = [
            ...overview.jobs.map((job) => `${job.id}  ${job.status}  ${job.source_thread_id}`),
            ...overview.candidates.map((candidate) => `${candidate.id}  ${candidate.status}  ${candidate.name}`),
          ];
          return reply(value, lines.length ? lines.join("\n") : "Очередь и review-предложения пусты.");
        }
        case "approve": {
          const candidateId = rest.find((value) => !value.startsWith("--"));
          const scopeAt = rest.indexOf("--scope");
          const scope = scopeAt >= 0 ? rest[scopeAt + 1] : undefined;
          if (!candidateId || (scope !== "project" && scope !== "global")) return fail(usage);
          const result = await saveCandidate(candidateId, scope, context.signal);
          return result.status === "saved" ? reply(result, result.message) : fail(result.message);
        }
        case "reject": {
          const candidateId = rest.find((value) => !value.startsWith("--"));
          if (!candidateId) return fail(usage);
          if (!store.rejectCandidate(candidateId, "Отклонено пользователем")) {
            return fail("Предложение уже обработано или не найдено.");
          }
          publishChanged();
          return reply({ status: "rejected", candidateId }, `Отклонено: ${candidateId}`);
        }
        case "retry": {
          const jobId = rest.find((value) => !value.startsWith("--"));
          if (!jobId) return fail(usage);
          const job = store.retryJob(jobId);
          if (!job) return fail("Задание не найдено или его нельзя повторить.");
          publishChanged();
          return reply({ job: jobView(job) }, `Повтор поставлен в очередь: ${job.id}`);
        }
        case undefined:
        case "help":
        case "--help":
          return reply({ usage }, usage);
        default:
          return fail(usage);
      }
    },
  });

  settings.onChange(() => publishChanged());
  bb.log.info("Memory Reflection загружен; автоматическая обработка выключена по умолчанию");
}
