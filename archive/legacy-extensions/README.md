# Legacy extension source archive

This directory contains a small, read-only source archive from the retired `pi-agent-orchestration` extension. It exists for design traceability. The package does not load or register these files.

## Included mapping

| Archived file                                    | Historical source                            | Reason kept                                                                                  |
| ------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pi-agent-orchestration/index.ts`                | deployed extension `index.ts`                | Shows the old fixed runtime entrypoint.                                                      |
| `pi-agent-orchestration/extension-bootstrap.mjs` | deployed extension `extension-bootstrap.mjs` | Shows exact manifest admission and lifecycle setup.                                          |
| `pi-agent-orchestration/tool-composition.mjs`    | deployed extension `tool-composition.mjs`    | Records the old tool names and schemas.                                                      |
| `pi-agent-orchestration/coordination-core.ts`    | deployed extension `coordination-core.ts`    | Records the non-authoritative wait design. This file was not imported by the old entrypoint. |

`SHA256SUMS` records the SHA-256 of each exact archived file. Run this command from this directory:

```bash
sha256sum --check SHA256SUMS
```

## Safety boundary

The archive excludes runtime configuration, manifests, participant records, session JSONL files, prompts, task payloads, questions, answers, reports, journals, audit data, tokens, secrets, native binaries, and process state. Do not add those items.

The archive is inert. It has no package entrypoint and no activation script. Do not import these files into the current extension. The broker and `pi-herdr-orchestrator` are the only current orchestration authority.

## Ideas kept in the current system

The current system keeps the useful principles, not the old runtime:

- exact identity checks before authority;
- durable broker-owned task, question, and result state;
- bounded inputs and outputs;
- explicit lifecycle correlation;
- non-authoritative observation waits;
- fail-closed behavior for conflicting orchestration tool ownership.

The old file-ledger controller, protected participant sockets, Step 5 identities, legacy tool namespace, and duplicate question and wait protocols are obsolete. They must not run beside the current broker.
