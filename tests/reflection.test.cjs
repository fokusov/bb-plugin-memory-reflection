const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const ts = require("typescript");

const packageRoot = path.resolve(__dirname, "..");

function loadTypeScript(relativePath) {
  const filename = path.join(packageRoot, relativePath);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  loaded._compile(output, filename);
  return loaded.exports;
}

test("history selection covers early and late Unicode evidence within its bound", () => {
  const { selectRepresentativeMessages } = loadTypeScript("lib/reflection.ts");
  const history = Array.from({ length: 500 }, (_, index) => ({
    id: `message-${index + 1}`,
    seq: index + 1,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `Эпизод ${index + 1}: исправление конфигурации. `.repeat(20),
  }));

  const selected = selectRepresentativeMessages(history, 6_000);
  assert.equal(selected[0].id, "message-1");
  assert.equal(selected.at(-1).id, "message-500");
  assert.ok(selected.length > 2);
  assert.ok(selected.reduce((size, message) => size + message.text.length, 0) <= 6_000);
  assert.ok(selected.every((message) => message.text.includes("Эпизод")));
});

test("timeline starts at the latest page and follows the cursor issued by BB", async () => {
  const { readReflectionMessages } = loadTypeScript("lib/reflection.ts");
  const signal = new AbortController().signal;
  const cursor = { anchorSeq: 18, anchorId: "opaque-timeline-cursor" };
  const row = (id, seq, text = id) => ({
    kind: "conversation", role: "user", id, text, sourceSeqStart: seq, sourceSeqEnd: seq,
  });
  const pages = [
    { rows: [row("last", 19), row("future", 21), row("continued", 20)], timelinePage: { olderCursor: cursor } },
    { rows: [row("first", 2)], timelinePage: { olderCursor: null, olderRowUpdates: [row("continued", 20, "full message")] } },
  ];
  const requests = [];
  const messages = await readReflectionMessages({ timeline: async (request) => {
    requests.push(request);
    return pages.shift();
  } }, { threadId: "thread", sourceSeq: 20, maxChars: 2_000, signal });
  assert.deepEqual(requests.map(({ beforeAnchorSeq, beforeAnchorId }) => [beforeAnchorSeq, beforeAnchorId]), [
    [undefined, undefined], ["18", "opaque-timeline-cursor"],
  ]);
  assert.deepEqual(messages.map(({ id, text }) => [id, text]), [
    ["first", "first"], ["last", "last"], ["continued", "full message"],
  ]);
});

test("a stale timeline cursor restarts once and discards the previous page", async () => {
  const { readReflectionMessages } = loadTypeScript("lib/reflection.ts");
  const signal = new AbortController().signal;
  const expired = new Error("HTTP 400: Timeline pagination cursor is no longer available; reload the latest page");
  const page = (id, anchorId, seq = 10) => ({
    rows: [{ kind: "conversation", role: "user", id, text: id, sourceSeqStart: seq, sourceSeqEnd: seq }],
    timelinePage: { olderCursor: anchorId ? { anchorSeq: 8, anchorId } : null },
  });
  const input = { threadId: "thread", sourceSeq: 10, maxChars: 2_000, signal };
  const steps = [page("old", "expired"), expired, page("replacement", "fresh"), page("earlier", null, 3)];
  const cursors = [];
  const messages = await readReflectionMessages({ timeline: async ({ beforeAnchorId }) => {
    cursors.push(beforeAnchorId);
    const step = steps.shift();
    if (step instanceof Error) throw step;
    return step;
  } }, input);
  assert.deepEqual(cursors, [undefined, "expired", undefined, "fresh"]);
  assert.deepEqual(messages.map(({ id }) => id), ["earlier", "replacement"]);
  await assert.rejects(readReflectionMessages({ timeline: async ({ beforeAnchorId }) => {
    if (beforeAnchorId) throw expired;
    return page("old", "expired");
  } }, input), expired);
});

test("the temporary worker asks for the least permissive mode the provider supports", () => {
  const { choosePermissionMode } = loadTypeScript("lib/reflection.ts");
  assert.equal(choosePermissionMode(["full"]), "full");
  assert.equal(choosePermissionMode(["full", "auto"]), "auto");
  assert.equal(choosePermissionMode(["accept-edits", "full"]), "accept-edits");
  assert.equal(choosePermissionMode([]), null);
});

test("one snapshot yields several distinct lessons and repeats collapse inside the job", () => {
  const reflection = loadTypeScript("lib/reflection.ts");
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "./reflection.js" && parent?.filename.endsWith(`${path.sep}lib${path.sep}store.ts`)) {
      return reflection;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { ReflectionStore } = loadTypeScript("lib/store.ts");
    const db = new Database(":memory:");
    try {
      const store = new ReflectionStore(db, (database, statements) => {
        statements.forEach((statement) => database.exec(statement));
      });
      const lesson = (name, evidence) => ({
        kind: "procedure",
        name,
        summary: `Урок ${name}`,
        details: `Детали ${name}`,
        reason: `Причина ${name}`,
        tags: ["pilot"],
        importance: 60,
        confidence: 0.9,
        evidence_refs: [evidence],
        explicit_remember: false,
      });

      const job = store.enqueue({
        sourceThreadId: "long-thread",
        projectId: "synthetic-project",
        sourceSeq: 400,
        trigger: "manual",
      }).job;
      const claimed = store.claimNext();
      store.finishCandidates(claimed, claimed.lease_token, [
        { lesson: lesson("early-fix", "user-message-1"), explicitRemember: false },
        { lesson: lesson("late-fix", "user-message-9"), explicitRemember: false },
        { lesson: lesson("early-fix", "user-message-1"), explicitRemember: false },
      ]);

      const rows = db.prepare("SELECT name, evidence_refs_json FROM reflection_candidates WHERE job_id = ? ORDER BY name")
        .all(job.id);
      assert.deepEqual(rows.map((row) => row.name), ["early-fix", "late-fix"]);
      assert.deepEqual(JSON.parse(rows[0].evidence_refs_json), ["user-message-1"]);
      assert.deepEqual(JSON.parse(rows[1].evidence_refs_json), ["user-message-9"]);
      assert.equal(store.getJob(job.id).status, "review_pending");
    } finally {
      db.close();
    }
  } finally {
    Module._load = originalLoad;
  }
});

test("an incomplete timeline snapshot fails with an explicit coverage error", async () => {
  const { readReflectionMessages } = loadTypeScript("lib/reflection.ts");
  const signal = new AbortController().signal;
  let pages = 0;
  await assert.rejects(readReflectionMessages({ timeline: async () => {
    pages += 1;
    return {
      rows: [{ kind: "conversation", role: "user", id: `message-${pages}`, text: "x", sourceSeqStart: 1000 + pages, sourceSeqEnd: 1000 + pages }],
      timelinePage: { olderCursor: { anchorSeq: 9_000, anchorId: `cursor-${pages}` } },
    };
  } }, { threadId: "thread", sourceSeq: 5000, maxChars: 2_000, signal }),
  /page limit reached before the reflection snapshot/u);
  assert.equal(pages, 128);
});

test("long PEM evidence is redacted before truncation, including an unmatched begin marker", () => {
  const { selectRepresentativeMessages } = loadTypeScript("lib/reflection.ts");
  const message = {
    id: "synthetic-pem-message",
    seq: 1,
    role: "user",
    text: `Контекст до маркера. -----BEGIN PRIVATE KEY-----\n${"SYNTHETIC-PRIVATE-DATA-".repeat(500)}`,
  };

  const [selected] = selectRepresentativeMessages([message], 4_000);
  assert.match(selected.text, /^Контекст до маркера\./u);
  assert.match(selected.text, /\[REDACTED PRIVATE KEY\]/u);
  assert.doesNotMatch(selected.text, /-----BEGIN PRIVATE KEY-----|SYNTHETIC-PRIVATE-DATA/u);
  assert.ok(selected.text.length <= 4_000);
});

test("a loose search hit does not block a new memory; a real duplicate does", async () => {
  const memoryCli = loadTypeScript("lib/memory-cli.ts");
  const candidate = {
    name: "agent-history-request-limit",
    summary: "В Session Overview запрос истории вкладки «Агенты» должен учитывать лимит BB: не более 100 событий.",
    details: "details",
    reason: "reason",
    kind: "episode",
    tags_json: JSON.stringify(["session-overview"]),
    importance: 80,
  };
  assert.equal(memoryCli.isDuplicateMemory(candidate, []), false);
  assert.equal(memoryCli.isDuplicateMemory(candidate, [{
    name: "preserve-openspec-profile-settings",
    summary: "При обновлении плагина сохраняйте настройки и привязки тредов.",
  }]), false);
  assert.equal(memoryCli.isDuplicateMemory(candidate, [{ name: "Agent.History_Request Limit" }]), true);
  assert.equal(memoryCli.isDuplicateMemory(candidate, [{
    name: "other-name",
    summary: "в session overview запрос истории вкладки «Агенты» должен учитывать лимит bb: не более 100 событий.",
  }]), true);
});

test("lessons cite any snapshot message, but only a user request grants auto-save", () => {
  const { filterSupportedLessons } = loadTypeScript("lib/reflection.ts");
  const messages = [
    { id: "thr:user-seed:1", role: "user", text: "Implement the change; read the artifacts first." },
    { id: "thr:assistant:2", role: "assistant", text: "Fixed the cursor read; the job now produces proposals." },
    { id: "thr:user-seed:5", role: "user", text: "Запомни это: пагинация требует курсора BB." },
  ];
  const lesson = (name, evidenceRefs, explicitRemember) => ({
    kind: "procedure",
    name,
    summary: `Урок ${name}`,
    details: `Детали ${name}`,
    reason: `Причина ${name}`,
    tags: ["pilot"],
    importance: 60,
    confidence: 0.95,
    evidence_refs: evidenceRefs,
    explicit_remember: explicitRemember,
  });

  const supported = filterSupportedLessons([
    lesson("assistant-evidence", ["thr:assistant:2"], false),
    lesson("explicit-request", ["thr:user-seed:5"], true),
    lesson("model-claims-explicit", ["thr:assistant:2"], true),
    lesson("unknown-ref", ["thr:missing:9"], false),
    lesson("generic-kickoff", ["thr:user-seed:1"], true),
  ], messages);

  assert.deepEqual(supported.map(({ lesson }) => lesson.name), [
    "assistant-evidence", "explicit-request", "model-claims-explicit", "generic-kickoff",
  ]);
  assert.deepEqual(supported.map(({ explicitRemember }) => explicitRemember), [false, true, false, false]);
});

test("saving a candidate writes the source thread through the BB CLI", async () => {
  const calls = [];
  const originalLoad = Module._load;
  let memoryCli;
  Module._load = function (request, parent, isMain) {
    if (request === "node:child_process") {
      return {
        execFile(executable, args, options, callback) {
          calls.push({ executable, args, cwd: options.cwd, env: options.env });
          const response = calls.length === 1
            ? { ok: true, memories: [{ name: "unrelated", summary: "unrelated" }] }
            : { ok: true, memory: { id: "mem_synthetic", sourceThreadId: "thread-1" } };
          callback(null, JSON.stringify(response), "");
          return { kill() {} };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    memoryCli = loadTypeScript("lib/memory-cli.ts");
    const candidate = {
      name: "agent-history-request-limit",
      summary: "Лимит истории — 100 событий.",
      details: "details",
      reason: "reason",
      kind: "episode",
      tags_json: JSON.stringify(["session-overview", "auto-reflection"]),
      importance: 80,
    };
    const result = await memoryCli.addMemoryCandidate(candidate, "project", "C:/pilot", {
      projectId: "proj_pilot",
      threadId: "thread-1",
    });
    assert.deepEqual(result, { memoryId: "mem_synthetic" });
    assert.equal(calls.length, 2);
    assert.match(calls[0].args.join(" "), /memory search agent history request limit --scope project --limit 20 --json$/u);
    assert.match(calls[1].args.join(" "), /memory add --scope project --name agent-history-request-limit/u);
    assert.equal(calls[0].env.BB_PROJECT_ID, "proj_pilot");
    assert.equal(calls[0].env.BB_THREAD_ID, "thread-1");
    const tagValues = calls[1].args.reduce((tags, value, index, args) =>
      value === "--tag" ? [...tags, args[index + 1]] : tags, []);
    assert.deepEqual(tagValues, ["auto-reflection", "session-overview"]);
  } finally {
    Module._load = originalLoad;
  }
});

test("a repeated lesson in a later snapshot of the same thread is deduplicated", () => {
  const reflection = loadTypeScript("lib/reflection.ts");
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "./reflection.js" && parent?.filename.endsWith(`${path.sep}lib${path.sep}store.ts`)) {
      return reflection;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { ReflectionStore } = loadTypeScript("lib/store.ts");
    const db = new Database(":memory:");
    try {
      const store = new ReflectionStore(db, (database, statements) => {
        statements.forEach((statement) => database.exec(statement));
      });
      const lesson = {
        kind: "procedure",
        name: "check-branch",
        summary: "Проверь ветку перед изменением настроек",
        details: "Перед правкой проверь текущую ветку.",
        reason: "В нескольких прогонах это предотвращало неверную правку.",
        tags: ["workflow"],
        importance: 70,
        confidence: 0.95,
        evidence_refs: ["user-message-1"],
        explicit_remember: false,
      };

      function reflectSnapshot(sourceSeq) {
        const job = store.enqueue({
          sourceThreadId: "synthetic-thread",
          projectId: "synthetic-project",
          sourceSeq,
          trigger: "manual",
        }).job;
        const claimed = store.claimNext();
        assert.equal(claimed.id, job.id);
        store.finishCandidates(claimed, claimed.lease_token, [{ lesson, explicitRemember: false }]);
        return store.getJob(job.id);
      }

      assert.equal(reflectSnapshot(100).status, "review_pending");
      assert.equal(reflectSnapshot(200).status, "succeeded");
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM reflection_candidates").get().count, 1);
    } finally {
      db.close();
    }
  } finally {
    Module._load = originalLoad;
  }
});
