
## M0/M1 implementation handoff

- M0: package metadata, dual binaries, strict source layout, copied schemas/examples, shared clock/ID/path/subprocess/error primitives, doctor capability report, and artifacts ignore are implemented in commit `13455b7`.
- M1: LF-bounded protocol codec, authenticated principals, private paths and lock, canonical hash-chain event store with fsync, deterministic reducer/invariants, snapshots, Unix broker IPC, synthetic task create/get/list, and status/events verification are implemented in commit `273d041`.
- Validation evidence: `npm run validate` passed on Node 24.18.0; 48 unit tests, 1 integration test, schema/example JSON checks, and package smoke passed.

## Correction cycle evidence (exact commits 7a99a53, 11b0326)

- Broker path safety: numeric `O_NOFOLLOW` helpers, owner/type/link/mode checks, lock fsync and identity checks, socket identity capture, mismatch-safe stop, persisted secret, and session-key validation. Regression evidence: `tests/unit/core-m1.test.ts`.
- Canonical state: pre-write reducer validation, serialized append queue, strict event field/hash/type checks, incomplete-record read-only recovery, atomic task/idempotency event binding, canonical parameter binding, lazy structural reducer copies, and bounded replay ring. Regression evidence: `tests/unit/core-m1.test.ts` and `tests/unit/m1-recovery-performance.test.ts`.
- Snapshot/replay: verified checksum/cursor, atomic temp publication with file and directory fsync, private no-follow reads, replay cursor retention floor, and 100,000-event replay evidence.
- Subscription/load: bounded client count, cursor expiry at the replay floor, unsubscribe, and bounded outbound socket buffering are implemented in `src/broker/broker.ts`.
- Exact correction gate: `/home/mainpc/.agents/projects/pi-herdr-agent-orchestration/evidence/reviews/M0_M1_CORRECTION_CHECKLIST.md` was re-read. Independent fresh review remains the integration prerequisite.
