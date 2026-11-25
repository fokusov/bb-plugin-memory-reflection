import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ReflectionCandidate, ReflectionJob, rpcContract } from "./rpc";
import { Button } from "@/components/ui/button";

interface Overview {
  enabled: boolean;
  autoSaveExplicit: boolean;
  autoSaveHighConfidence: boolean;
  autoSaveConfidenceThreshold: number;
  jobs: ReflectionJob[];
  candidates: ReflectionCandidate[];
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: "В очереди",
    running: "В работе",
    retryable_failed: "Повторится автоматически",
    review_pending: "Нужен review",
    no_lessons: "Уроков не найдено",
    succeeded: "Готово",
    terminal_failed: "Ошибка",
    cancelled: "Отменено",
    pending_review: "На review",
    saving: "Сохраняю",
    saved: "Сохранено",
    rejected: "Отклонено",
    conflict: "Возможный дубликат",
    blocked: "Запись недоступна",
  };
  return labels[status] ?? status;
}

function ReflectionPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    rpc.call("overview", null).then((value) => {
      setOverview(value);
      setError(null);
    }, (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [rpc]);

  useEffect(() => refresh(), [refresh]);
  useRealtime("memory-reflection-changed", refresh);

  const act = async (
    candidate: ReflectionCandidate,
    action: "save" | "reject",
    scope?: "project" | "global",
  ) => {
    if (busyId !== null) return;
    setBusyId(candidate.id);
    try {
      const result = await rpc.call("candidate_action", {
        candidateId: candidate.id,
        action,
        ...(scope ? { scope } : {}),
      });
      if (result.status === "conflict" || result.status === "blocked") setError(result.message);
      else setError(null);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const candidates = overview?.candidates ?? [];
  const jobs = overview?.jobs ?? [];
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-4xl px-4 pb-6 pt-4 md:px-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-foreground">Auto-reflection</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Предложения хранятся отдельно до review. В глобальную память запись попадёт только после явного выбора.
            </p>
          </div>
          <div className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
            {overview === null ? "Загружаю…" : overview.enabled ? "Автоматизация включена" : "Автоматизация выключена"}
          </div>
        </header>

        {overview?.autoSaveHighConfidence ? (
          <p className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Уроки с доверием от {overview.autoSaveConfidenceThreshold}% сохраняются в память проекта без review. В глобальную память автосохранение не пишет.
          </p>
        ) : overview?.autoSaveExplicit ? (
          <p className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            В настройках включено авто-сохранение только для уроков с явной просьбой «запомни» и подтверждёнными ссылками на сообщения.
          </p>
        ) : null}

        {error ? <p role="alert" className="mt-4 text-sm text-destructive">{error}</p> : null}

        <section className="mt-6">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-foreground">Предложения на review</h2>
            <span className="text-xs text-muted-foreground">{candidates.length}</span>
          </div>
          {candidates.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              Пока нет предложений. Для ручного запуска используй <code>bb memory-reflection reflect</code> из потока.
            </div>
          ) : (
            <ul className="space-y-3">
              {candidates.map((candidate) => (
                <li key={candidate.id} className="rounded-lg border border-border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="break-words text-sm font-semibold text-foreground">{candidate.name}</h3>
                        <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                          {candidate.kind}
                        </span>
                        <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                          {statusLabel(candidate.status)}
                        </span>
                      </div>
                      <p className="mt-2 text-sm text-foreground">{candidate.summary}</p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      confidence {Math.round(candidate.confidence * 100)}%
                    </span>
                  </div>

                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs text-muted-foreground">Детали и доказательства</summary>
                    <div className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{candidate.details}</div>
                    <p className="mt-2 text-xs text-muted-foreground">Зачем сохранять: {candidate.reason}</p>
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      Поток {candidate.sourceThreadId}; сообщения: {candidate.evidenceRefs.join(", ") || "нет"}
                    </p>
                    {candidate.statusMessage ? (
                      <p className="mt-2 text-xs text-destructive">{candidate.statusMessage}</p>
                    ) : null}
                  </details>

                  {candidate.status !== "saved" && candidate.status !== "rejected" ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button size="sm" disabled={busyId !== null} onClick={() => act(candidate, "save", "project")}>
                        Сохранить в проект
                      </Button>
                      <Button size="sm" variant="outline" disabled={busyId !== null} onClick={() => act(candidate, "save", "global")}>
                        Сохранить глобально
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busyId !== null} onClick={() => act(candidate, "reject")}>
                        Отклонить
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-7">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-foreground">Последние задания</h2>
            <span className="text-xs text-muted-foreground">{jobs.length}</span>
          </div>
          {jobs.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
              Очередь пуста.
            </div>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border bg-card px-4">
              {jobs.map((job) => (
                <li key={job.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium text-foreground">{statusLabel(job.status)}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{job.trigger} · seq {job.sourceSeq}</span>
                    {job.error ? <p className="mt-1 text-xs text-destructive">{job.error}</p> : null}
                  </div>
                  <span className="break-all font-mono text-[11px] text-muted-foreground">{job.sourceThreadId}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "review",
    title: "Memory Reflection",
    icon: "Brain",
    path: "review",
    component: ReflectionPage,
  });
});
