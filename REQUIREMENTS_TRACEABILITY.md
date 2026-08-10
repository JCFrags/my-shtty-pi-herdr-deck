## M2 implementation handoff

- BL-030–BL-033: `src/herdr/runner.ts`, `capabilities.ts`, `socket-client.ts`, `types.ts`, `normalizers.ts` provide shell-free bounded process execution, schema projection, raw snapshot/event transport, and additive-field tolerant normalized types.
- BL-034–BL-036: `src/state/agent-domain.ts` and `src/herdr/names.ts` provide agent lifecycle/graph guards and deterministic bounded names, labels, and branch slugs.
- BL-037–BL-040: `src/herdr/token-files.ts` and `provisioner.ts` provide 256-bit token digests, private prompt files, read-only/worktree tab launch construction, and registration-start resource identities.
- BL-041–BL-043: `src/herdr/controls.ts`, `reconciler.ts`, and `src/git/{runner,porcelain,evidence}.ts` provide identity revalidation, startup classifications, and NUL-safe Git evidence.
- Evidence: `evidence/implementation/herdr-m2/`.

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

## Streaming and lock correction evidence (`e82a752`)

- Event logs now use owner-checked numeric no-follow handles and bounded streaming line reads. Oversized, CRLF, empty interior, malformed, and incomplete records enter read-only recovery.
- Lock records now include nonce, expected socket, PID, and Linux `/proc/<pid>/stat` start identity. Lock and recovery guard identities are revalidated before stale unlink and release.
- Focused tests cover regular-path refusal, lock metadata, real socket session-key rejection, concurrent append, incomplete/oversized recovery, verified snapshots, and 100,000-event replay with 1,000 task records plus audit events.
- Complete validation at `e82a752`: 56 unit tests, 1 integration test, lint, typecheck, schema check, package smoke, and diff check passed.

## Fresh rereview correction evidence (`86f433f`)

- Socket cleanup uses same-directory atomic quarantine and identity verification. Stop releases the owned lock in a finally path after replacement detection.
- Secret reads and exclusive creation use private no-follow helpers. Restart preserves the one trailing LF secret format.
- M1 hello fails closed for declared `pi_parent` and `pi_child` until verified M3 identity registration exists. Synthetic task creation rejects arbitrary parent claims.
- Snapshot selection occurs before event recovery. EventStore verifies the full disk chain and reduces only the suffix after a valid snapshot cursor. Disk history serves subscriptions below the in-memory replay ring floor.
- Accepted M1 events are the task skeleton, strict task state changes, audit, status, and recovery events. Run/result/idempotency standalone events are unsupported and fail closed. Event append performs full schema/hash/chain verification before reduce/fsync.
- `events.subscribe` validates cursor, filters, and includeSnapshot; returns the documented subscription shape and sends bounded canonical event frames for disk replay/live mutation. Snapshot writes occur only after committed mutations and do not change a committed success on snapshot failure.
- Focused evidence: 13 correction tests pass, including snapshot suffix, disk history, invalid event schema, secret restart, parent fail-closed auth, lock identity, and socket/session regressions. Full validation evidence is recorded in STATUS and REPORT.

## Parent correction after failed fresh review

- The broker quarantines the socket path before Node closes the Unix server. It restores and does not delete a replacement socket. Stale socket and lock removal now delete only the quarantined inode after owner, mode, link, record, and identity checks.
- Secret, event, lock, recovery-guard, snapshot, and socket operations use exclusive or no-follow handles where Linux and Node expose them. A secret symlink fails closed without changing its target.
- M1 accepts only strict task skeleton, task state, and audit events. Later run, result, registration, and lifecycle events fail closed until their owning milestone adds complete reducers and correlation. FR-030–036 and BL-034–035/BL-051–054 assign managed-child registration to M2–M3. The M1 broker now rejects these principals explicitly and audits the failed attempt; it does not present an unusable partial registration path.
- Task creation and idempotency binding share one fsynced event. Request mutation is serialized. Same-input retries return the durable result after restart. Cross-parameter reuse returns `IDEMPOTENCY_CONFLICT`. The event store anchors the opened canonical inode and content metadata. Each append verifies the no-follow handle and pathname before and after fsync. A forced replacement race enters read-only recovery and cannot return success.
- Recovery verifies the event-chain prefix without invoking the logical reducer. It authenticates the complete private snapshot state and cursor with HMAC-SHA-256 under the owner-only broker secret, validates the cursor against the chain, loads the snapshot as serving state, and reduces only the suffix. The 100,000-event snapshot-plus-suffix test observes exactly 1,000 reducer calls for its 99,000-event prefix and 1,000-event suffix, and it completes below five seconds and 256 MiB RSS.
- Subscription replay reads retained disk history for the active event generation. It validates exact parameters, filters, future cursors, subscription IDs, replay/live filters, client count, request rate, authentication wait, and outbound bytes. Slow-client disconnects queue a canonical audit event without blocking the writer.
- Broker and CLI verification rescan the disk chain. Invalid event or snapshot data enters read-only recovery. Unexpected internal request errors are not sent to clients. Authentication failures append a redacted canonical audit event before the socket closes when the store is writable.
- Current local gates: `npm run lint`, `npm run typecheck`, and `npm run validate` pass. Validation includes 69 unit tests, one integration test, schema checks, and package smoke. Fresh independent exact-commit review remains required before M2.

## M2 correction evidence

The corrected M2 slice is executable through `src/herdr/service.ts`. It records provisioning intent and outcome in the broker event store, performs startup reconciliation, gates mutations on projected capabilities, compensates Herdr resources in reverse order, and classifies panes without verified occupants as orphaned. Local tests prove NUL-safe rename parsing, canonical capability hashing, managed-environment rejection, bounded process output, process-group termination, argv-only process execution, deterministic process faults, fake-only end-to-end provisioning, durable resource identity, prompt cleanup, unused-tab closure, and four creation-boundary fault injections. Tests are in `tests/unit/m2-herdr.test.ts` and `tests/integration/m2-faults.test.ts`. The integration suite drives provisioning through authenticated `Broker` routing, broker-owned event storage, startup reconciliation, and the private CLI client. No live Herdr resource is used.
