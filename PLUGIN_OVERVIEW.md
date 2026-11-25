Review durable lessons extracted from completed BB threads before they enter BB Memory.

## What you get

- An **Memory Reflection** page in the sidebar with proposed lessons and job status.
- A durable, idempotent queue driven by thread lifecycle events or a manual CLI command.
- Policy checks that route inferred lessons to review and only auto-save explicit memory requests.

## How it works

Queue metadata and review candidates live in this plugin's SQLite database. Source transcripts are read on demand and are not copied into that database. A temporary hidden worker thread is deleted after generation. Accepted lessons are written through the built-in `bb memory` CLI.

## For agents

The bundled skill documents `bb memory-reflection reflect`, `list`, `approve`, and `reject`. Project writes require a local project source; global writes require an explicit scope selection.
