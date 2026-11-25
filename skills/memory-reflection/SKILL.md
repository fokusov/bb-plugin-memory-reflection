---
name: memory-reflection
description: Review and manage BB Memory reflection jobs and lesson candidates.
---

# Memory Reflection

Use this plugin to inspect background reflection work and review proposed durable lessons.

```sh
bb memory-reflection status [--json]
bb memory-reflection list [--json]
bb memory-reflection reflect [thread-id] [--json]
bb memory-reflection approve <candidate-id> --scope project|global [--json]
bb memory-reflection reject <candidate-id> [--json]
bb memory-reflection retry <job-id> [--json]
```

Run `reflect` from a thread to use that thread as the source. Review every candidate before saving it. Project scope is for repository knowledge; global scope is only for lessons that clearly apply across projects and must be selected explicitly.

A reflection can return multiple independent lessons. Each candidate shows the source thread and evidence message IDs. Long histories are sampled across the bounded timeline range, so verify the cited messages and surrounding context before approval.

The plugin does not overwrite or delete existing memories. If a search finds a possible duplicate, inspect it with `bb memory search` and update it manually with the expected version instead of creating a competing record. Do not approve secrets, personal contact data, temporary task state, unverified conclusions, raw logs, or information already covered by project policy.
