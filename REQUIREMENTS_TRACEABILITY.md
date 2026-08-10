
## M0/M1 implementation handoff

- M0: package metadata, dual binaries, strict source layout, copied schemas/examples, shared clock/ID/path/subprocess/error primitives, doctor capability report, and artifacts ignore are implemented in commit `13455b7`.
- M1: LF-bounded protocol codec, authenticated principals, private paths and lock, canonical hash-chain event store with fsync, deterministic reducer/invariants, snapshots, Unix broker IPC, synthetic task create/get/list, and status/events verification are implemented in commit `273d041`.
- Validation evidence: `npm run validate` passed on Node 24.18.0; 48 unit tests, 1 integration test, schema/example JSON checks, and package smoke passed.
