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
