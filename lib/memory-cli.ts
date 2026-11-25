import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import type { CandidateRow } from "./store.js";

interface MemoryCommandResponse {
  ok: boolean;
  error?: { code?: string; message?: string };
  memories?: Array<{ id?: string; name?: string; summary?: string }>;
  memory?: { id?: string; sourceThreadId?: string | null };
}

export interface MemoryCommandContext {
  projectId: string;
  threadId: string;
  /** Loopback URL of the BB server this plugin runs on; without it the CLI would resolve another profile. */
  serverUrl: string;
}

export class MemoryCliError extends Error {
  constructor(message: string, readonly code = "memory_cli_error") {
    super(message);
    this.name = "MemoryCliError";
  }
}

function resolveCommand(args: string[]): { executable: string; args: string[] } {
  const configured = process.env.BB_CLI?.trim();
  if (process.platform !== "win32") return { executable: configured || "bb", args };
  if (!configured) {
    throw new MemoryCliError("Не задан BB_CLI; безопасный запуск BB CLI на Windows невозможен", "cli_unavailable");
  }

  const extension = extname(configured).toLowerCase();
  if (extension === ".exe" || extension === ".com") return { executable: configured, args };

  const script = extension === ".cmd" || extension === ".bat"
    ? configured.slice(0, -extension.length)
    : configured;
  if (!existsSync(script)) {
    throw new MemoryCliError("Не найден скрипт BB CLI, указанный в BB_CLI", "cli_unavailable");
  }

  // On Windows BB_CLI points to the Node entrypoint; .cmd files cannot be
  // executed safely with execFile because that would require a shell.
  return { executable: process.execPath, args: [script, ...args] };
}

function invoke(
  args: string[],
  cwd: string,
  context: MemoryCommandContext,
  signal?: AbortSignal,
): Promise<MemoryCommandResponse> {
  const command = resolveCommand(args);
  return new Promise((resolve, reject) => {
    execFile(command.executable, command.args, {
      cwd,
      env: {
        ...process.env,
        // Pin the profile: an inherited BB_SERVER_URL from the launching shell would
        // make the CLI read and write another server's memory.
        BB_SERVER_URL: context.serverUrl,
        BB_PROJECT_ID: context.projectId,
        BB_THREAD_ID: context.threadId,
      },
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 256 * 1024,
      signal,
    }, (error, stdout, stderr) => {
      let response: MemoryCommandResponse;
      try {
        response = JSON.parse(stdout) as MemoryCommandResponse;
      } catch {
        const detail = stderr.trim().slice(0, 240);
        reject(new MemoryCliError(detail || error?.message || "Memory CLI returned invalid JSON"));
        return;
      }
      if (response.ok !== true) {
        reject(new MemoryCliError(response.error?.message || "Memory command failed", response.error?.code));
        return;
      }
      // Treat the JSON receipt as authoritative: BB can emit a successful
      // Memory response before a non-zero process-exit assertion on Windows.
      resolve(response);
    });
  });
}

function normalizeKey(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/[\s._-]+/gu, " ").trim();
}

/**
 * BB memory search matches any word of a query, so its raw hits say nothing about
 * duplication. A hit counts only when the stored name or the stored summary is the
 * same text as the candidate's.
 */
export function isDuplicateMemory(
  candidate: Pick<CandidateRow, "name" | "summary">,
  memories: readonly { name?: string; summary?: string }[],
): boolean {
  const name = normalizeKey(candidate.name);
  const summary = normalizeKey(candidate.summary);
  return memories.some((memory) => {
    const storedName = normalizeKey(memory.name ?? "");
    const storedSummary = normalizeKey(memory.summary ?? "");
    return (name !== "" && storedName === name) || (summary !== "" && storedSummary === summary);
  });
}

export async function addMemoryCandidate(
  candidate: CandidateRow,
  scope: "project" | "global",
  cwd: string,
  context: MemoryCommandContext,
  signal?: AbortSignal,
): Promise<{ memoryId: string | null }> {
  const query = candidate.name.replace(/[._-]+/gu, " ").trim();
  const search = await invoke(
    ["memory", "search", query, "--scope", scope, "--limit", "20", "--json"],
    cwd,
    context,
    signal,
  );
  if (!Array.isArray(search.memories)) {
    throw new MemoryCliError("Memory search response has no memories list", "invalid_search_response");
  }
  if (isDuplicateMemory(candidate, search.memories)) {
    throw new MemoryCliError("Похожа́я запись уже есть в Memory; проверь её через bb memory search перед созданием новой.", "possible_duplicate");
  }

  const tags = [...new Set(["auto-reflection", ...(JSON.parse(candidate.tags_json) as string[])])].slice(0, 20);
  const args = [
    "memory", "add",
    "--scope", scope,
    "--name", candidate.name,
    "--summary", candidate.summary,
    "--details", candidate.details,
    "--reason", candidate.reason,
    "--kind", candidate.kind,
    "--importance", String(candidate.importance),
    "--json",
  ];
  for (const tag of tags) args.push("--tag", tag);
  const result = await invoke(args, cwd, context, signal);
  const memoryId = result.memory?.id;
  if (typeof memoryId !== "string" || !memoryId) {
    throw new MemoryCliError("BB Memory did not return the ID of the saved entry", "invalid_add_response");
  }
  if (result.memory?.sourceThreadId !== context.threadId) {
    throw new MemoryCliError("BB Memory did not preserve the source thread for this entry", "source_not_recorded");
  }
  return { memoryId };
}
