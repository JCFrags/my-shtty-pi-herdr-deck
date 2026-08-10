# M7 operations runbook

This runbook is local only. It does not publish packages or change a live Herdr session.

## Preflight

Run from the exact candidate commit:

```bash
npm ci --ignore-scripts
npm run validate
node scripts/m7-ops.mjs plan
```

Record the JSON plan under a private evidence directory. Do not record secrets, prompts, or session files.

## Configuration

Validate an owner-controlled configuration file:

```bash
pi-herdr-orchestrator config validate ./config.json
```

Project configuration is accepted only when `PI_HERDR_ORCH_PROJECT_TRUSTED=1` is set by the trusted Pi context. Unknown fields, writable files, symlinks, and secret-like fields fail closed.

## State and export

```bash
pi-herdr-orchestrator broker status
pi-herdr-orchestrator events verify --json
pi-herdr-orchestrator retention plan
pi-herdr-orchestrator export --output ./private-export
```

Export is additive. It copies only verified event and snapshot files and writes a mode-0600 manifest.

## Deployment rehearsal

The harness is dry-run by default:

```bash
npm run ops:plan
npm run ops:deploy
npm run ops:canary
PI_HERDR_ORCH_SOAK_ITERATIONS=20 npm run ops:soak
npm run ops:rollback
```

`--execute` is reserved for a separately approved operator run. The harness uses argv-only child processes, finite timeouts, and records only command status and output lengths.

Canary order is: fake validation, package smoke, disposable fake stack, then an explicitly selected low-risk task. Do not repoint Pi or Herdr registration until each earlier gate passes.

## Rollback

1. Stop the broker through its owner-controlled command.
2. Export and verify state.
3. Check stored schema compatibility with the target version.
4. Restore the exact prior package or checkout.
5. Start the broker and run `doctor` and `status`.
6. Reconcile agents and retain dirty or ambiguous worktrees.

Never run older code against a newer unsupported state generation. Never kill-scan processes. Never remove a dirty, live, unknown, or replaced resource.

## Soak evidence

The harness repeats deterministic integration tests. It does not claim live reliability or elapsed wall time. A live soak must record start/end UTC, exact commit, iteration count, failures, broker restart count, and retained resources. Stop at the first integrity, identity, secret, or cleanup failure.

## Uninstall and cleanup boundary

Normal uninstall preserves state, logs, results, and worktrees. `retention plan` is read-only. There is no automatic deletion command in M7. Data deletion requires a separately approved, explicit operation after all live agents and the broker are stopped.
