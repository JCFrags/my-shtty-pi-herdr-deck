# M7 release rehearsal

This runbook defines a local release rehearsal. It does not deploy to Herdr or Pi.

## Limits

- The harness is dry-run only.
- It never executes live Herdr or Pi commands.
- It never publishes a package.
- It never creates tags.
- It never deletes data, resources, or worktrees.
- A missing or invalid rollback commit fails closed.

Run the harness from the candidate checkout:

```bash
node scripts/m7-release-harness.mjs plan \
  --candidate 0123456789abcdef0123456789abcdef01234567 \
  --rollback fedcba9876543210fedcba9876543210fedcba98
```

The command prints one JSON plan. The candidate and rollback values must be
full 40-character commit IDs. The harness records the pair in every plan.
Use environment variables instead of command arguments when local policy
requires it:

```bash
export PI_HERDR_ORCH_CANDIDATE_COMMIT=$(git rev-parse HEAD)
export PI_HERDR_ORCH_ROLLBACK_COMMIT=<approved-prior-commit>
node scripts/m7-release-harness.mjs plan
```

`--execute` is rejected. Do not add an execution mode to this harness.

## Finite plan stages

Each command creates the same bounded rehearsal structure:

1. `plan` records the safety boundary and inputs.
2. `deploy` plans repository validation.
3. `canary` plans fake validation, package smoke, a disposable fake stack,
   and one selected low-risk task.
4. `soak` plans deterministic repeated tests.
5. `rollback` plans restoration of the compatible candidate pair, then doctor,
   status, and reconciliation checks.

The harness only describes these stages. It does not run them.

## Package privacy

The plan checks `package.json` before a rehearsal is accepted. The check
rejects private project paths in the package file list and secret-like package
metadata. Package smoke is a dry-run concern only. Never publish the package
from this worktree.

## Repeatable soak metadata

Set a finite iteration count from 1 through 1000. The default is 10.
Set a stable seed when comparing plans:

```bash
PI_HERDR_ORCH_SOAK_ITERATIONS=20 \
PI_HERDR_ORCH_SOAK_SEED=m7-release-soak-v1 \
node scripts/m7-release-harness.mjs soak
```

The output includes the format, seed, iteration count, stop-on-failure policy,
exact commit pair, and a deterministic plan ID. It does not claim live elapsed
time or live reliability.

## Evidence and rollback record

Store the JSON output in an owner-only directory outside the package source. Do not store secrets, prompts, sessions, cookies, tokens, or private keys.
A live release, if separately approved, must record its own UTC start and end,
exact candidate and rollback pair, iteration count, failure count, broker
restart count, and retained resources. That live activity is outside this
harness and this contract.

Before any separately approved operator action, verify state compatibility.
Stop at the first integrity, identity, secret, or cleanup failure. Never run
older code against a newer unsupported state generation. Preserve dirty,
ambiguous, replaced, and unknown worktrees.
