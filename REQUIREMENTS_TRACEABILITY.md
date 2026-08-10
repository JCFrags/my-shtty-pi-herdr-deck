## M4 implementation handoff

Work: `pi-herdr-agent-orchestration-001-m4-results`
Base: `44d8ac945713d4729b228fe8d06b54448843c310`
Implementation commits: `c01b183`, `1f3a759`
Test commits: `0156262`, `7c0f71a`, `8f92d18`

| Requirement | Implementation | Focused evidence |
|---|---|---|
| FR-080 | `src/results/tools.ts` and `ResultService.publish` inject frozen run identity and validate the result body. | `tests/unit/m4-results.test.ts`, `tests/integration/m4-results-questions.test.ts` |
| FR-081 | Result map accepts one result per run. Byte-equivalent duplicate is idempotent. Differing duplicate is rejected and audited through event hook. | `m4-results.test.ts`, `m4-results-questions.test.ts` |
| FR-082 | `publish` and `settle` implement result-pending until matching Pi settle. Terminal Pi error prevents success. | `m4-results.test.ts`, `m4-results-questions.test.ts` |
| FR-083 | Settle without result enters `result_pending_missing`, invokes one recovery callback, and fails through `failMissing`. | `m4-results.test.ts`, `m4-results-questions.test.ts` |
| FR-084 | Result collections are bounded by validator limits. `ArtifactStore` uses owner-only exclusive files, digest/size verification, bounded reads, and traversal rejection. | `m4-artifact-security.test.ts` (4 pass) |
| FR-085 | `assessEvidence` and result publication compare claimed changed files with independent Git evidence. | `src/results/evidence.ts`; integration fixture |
| FR-086 | Test claims remain `reported` unless an independent verifier callback confirms every claim. | `src/results/evidence.ts` |
| FR-087 | `validateQuestion`, `ResultService.ask`, and `ManagedChildTools.orchestratorAsk` implement the structured question contract. | `m4-results.test.ts`, `m4-question-races.test.ts` |
| FR-088 | Accepted questions set the run to `blocked`, emit `question.opened`, and wait through a bounded waiter. | `m4-results.test.ts`, `m4-results-questions.test.ts` |
| FR-089 | `answer` updates state before releasing the waiter. A concurrent later answer receives `QUESTION_ALREADY_ANSWERED`. | `m4-question-races.test.ts` (4 pass) |
| FR-090 | `timeout` is durable through the service event hook. Late answers are rejected and cannot reach a later run. | `m4-question-races.test.ts`, integration fixture |

## Lane gates

- `npm ci --ignore-scripts`: pass in child worktrees.
- `npm run typecheck`: pass.
- `npm run build`: pass.
- Focused unit tests: 14 pass.
- Focused integration tests: 4 pass.
- `git diff --check`: pass in child handoffs.
- Package/privacy live gates: pending later convergence. No live deployment was performed.

## Interface freeze and limits

M4 adds only namespaced result/question modules, stable IDs, result/question events, and optional event emission callbacks. It does not rename frozen M0–M2 fields or invoke live Herdr/Pi APIs. Files UI remains deferred. The M3 adapter will bind `RunBinding` to its canonical run and assignment records during convergence.

## Private child handoffs

- `agents/orch_m4_artifact_tests/REPORT.md`, commit `6751112c6cd25421e83dfb9635ce03cc25473f29`.
- `agents/orch_m4_question_tests/REPORT.md`, commit `3ce31109845568564ace72d4405ea169bac09cb8`; custody correction is recorded in its STATUS.
- `agents/orch_m4_integration_tests/REPORT.md`, commit `64b4eef86cfd2f5705f7a1e9c13a84937b971f09`.
