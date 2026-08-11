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

Project configuration is accepted only when `PI_HERDR_ORCH_PROJECT_TRUSTED=1` is set by the trusted Pi context. Unknown fields, writable files, symlinks, and secret-like fields fail closed. The shipped CLI also applies the effective config policy and returns its generation and hash.

## Broker lifecycle, state, and export

Run broker commands inside the affected Herdr session. Herdr 0.8.0 or newer gives the canonical socket to ordinary panes. It gives the authoritative `HERDR_BIN_PATH` to the plugin startup hook and plugin panes. Do not set an internal broker socket, session key, client secret, token, terminal ID, or binary path. The broker never searches `PATH` for Herdr.

Link or enable alone does not run the plugin startup hook. Use an authorized Herdr start or restart after link. The hook then starts or reuses the session broker and exits. A new Pi session attaches to that broker and registers itself as the adopted root. The deck uses the same broker.

Ordinary Herdr panes can run these authenticated attach-only commands:

```bash
pi-herdr-orchestrator broker status
pi-herdr-orchestrator doctor --json
pi-herdr-orchestrator events verify --json
pi-herdr-orchestrator broker stop
```

The public `broker start` and `broker restart` commands require Herdr plugin runtime context. Do not set or copy a binary path. Use the authorized Herdr restart and startup hook for installation, recovery, and rollback.

`start` and `status` accept only an authenticated broker for the canonical Herdr session. `stop` and `restart` verify the recorded process-start identity. They do not signal an unverified process.

For state checks:

```bash
pi-herdr-orchestrator broker status
pi-herdr-orchestrator events verify --json
pi-herdr-orchestrator recovery plan
pi-herdr-orchestrator recovery export --output ./private-export
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

The harness is plan-only. `--execute` is rejected. Operator mutations use `src/ops/operator-actions.ts`; they require explicit confirmation, exact commit and resource identities, preflight evidence, a finite timeout, and a rollback record. Execution requires an injected runner and is used only by fake-runner tests in this lane.

Create an expected plan, then verify it against a separate owner-only current-evidence file:

```bash
umask 077
pi-herdr-orchestrator ops plan --action restart \
  --commit <candidate-40-hex> --rollback <rollback-40-hex> \
  --evidence validate:<sha256> --resource broker:broker-v1:clean > expected.json
pi-herdr-orchestrator ops verify --plan expected.json --current current.json
pi-herdr-orchestrator ops apply --plan expected.json --current current.json
```

`expected.json` and `current.json` must be owner-only regular files. The loader rejects unknown fields, duplicates, malformed entries, stale identities, stale preflight evidence, and unsafe resource states. CLI apply reports that execution is disabled. It does not imply that a mutation ran. An injected runner is required for apply tests.

Canary order is: fake validation, package smoke, disposable fake stack, then an explicitly selected low-risk task. Do not repoint Pi or Herdr registration until each earlier gate passes.

## Rollback

1. Run `pi-herdr-orchestrator broker stop` inside the affected Herdr session.
2. Export and verify state.
3. Check stored schema compatibility with the target version.
4. Restore the exact prior package or checkout.
5. Use an authorized Herdr start or restart so the restored startup hook starts the broker. Verify `broker status` and `doctor`, then reopen Pi.
6. Reconcile agents and retain dirty or ambiguous worktrees.

Never run older code against a newer unsupported state generation. Never kill-scan processes. Never remove a dirty, live, unknown, missing, ambiguous, or replaced resource. Operation verification fails closed when a resource identity changes.

## Soak evidence

The harness repeats deterministic integration tests. It does not claim live reliability or elapsed wall time. A live soak must record start/end UTC, exact commit, iteration count, failures, broker restart count, and retained resources. Stop at the first integrity, identity, secret, or cleanup failure.

## Uninstall and cleanup boundary

Normal uninstall preserves state, logs, results, and worktrees. `retention plan` is read-only. There is no automatic deletion command in M7. Data deletion requires a separately approved, explicit operation after all live agents and the broker are stopped.
