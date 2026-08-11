# Pi Herd Orchestrator

`pi-herdr-orchestrator` is a Linux package for Pi and a managed-pane plugin for Herdr. It provides a local broker, Pi lifecycle integration, task and workflow control, result and question handling, a scheduler, and the Pi Herd control pane.

This release is for reviewed local use. It does not publish an npm package or create a public release.

## Requirements

| Component | Minimum or requirement                                    |
| --------- | --------------------------------------------------------- |
| Linux     | Required                                                  |
| Node.js   | 22.19.0                                                   |
| Herdr     | 0.8.0                                                     |
| Pi        | A compatible build of Pi with the required extension APIs |

The plugin manifest requires Herdr 0.8.0. Herdr 0.7.5 and older versions cannot load this plugin metadata. Upgrade Herdr before you link or open the plugin.

The Pi control deck also requires component mouse events, per-tool expansion state, current-turn and session bulk expansion selectors, and expansion-change subscription. If these APIs are absent, the deck reports an incompatibility and does not emulate them with terminal input.

## Shipped identifiers

| Item                      | Shipped value                                |
| ------------------------- | -------------------------------------------- |
| Pi extension              | `./dist/extensions/pi-herdr-orchestrator.js` |
| Primary Pi status command | `/orchestrator-status`                       |
| Herdr plugin ID           | `pi.herdr.orchestrator`                      |
| Managed pane entrypoint   | `deck`                                       |
| Managed pane title        | `Pi Herd`                                    |
| Managed pane command      | `./bin/pi-herdr-orchestrator deck`           |
| Minimum Herdr             | `0.8.0`                                      |

The package manifest and plugin manifest are the source of truth for these identifiers.

## Build and validate

Run these commands from the package root:

```bash
npm install
npm run validate
```

The build emits the Pi extension and runtime under `dist/`. Validation runs type checks, schema checks, the static release-document check, the build, unit and integration tests, and the package smoke test. Tests use local fakes and do not need a live Pi or Herdr process.

## Install the local Pi package

Pi local paths point to the directory. Pi does not copy it. Keep the directory at the same path after installation.

Install for the current user:

```bash
PACKAGE_ROOT=$(pwd)
pi install "$PACKAGE_ROOT"
```

Install for the current project instead:

```bash
PACKAGE_ROOT=$(pwd)
pi install -l "$PACKAGE_ROOT"
```

Start Pi after installation. Pi loads `./dist/extensions/pi-herdr-orchestrator.js` from the package manifest.

## Link the Herdr plugin

Confirm that Herdr is version 0.8.0 or newer. Then link the same package root:

```bash
PACKAGE_ROOT=$(pwd)
herdr plugin link "$PACKAGE_ROOT"
```

The manifest links plugin `pi.herdr.orchestrator`. It declares entrypoint `deck`, title `Pi Herd`, and pane command `./bin/pi-herdr-orchestrator deck`.

## Open Pi Herd

List live agents and select the target Pi pane:

```bash
herdr agent list
```

Open the managed pane as a right-hand split:

```bash
PI_PANE='replace-with-the-pi-pane-id'
herdr plugin pane open \
  --plugin pi.herdr.orchestrator \
  --entrypoint deck \
  --placement split \
  --target-pane "$PI_PANE" \
  --direction right \
  --focus
```

Herdr supplies the plugin context. Pi Herd checks the selected pane against live agent data. It does not silently attach to an arbitrary pane when identity is missing or ambiguous.

## Verify

In the target Pi pane, run:

```text
/orchestrator-status
```

The command reports the orchestrator extension and broker state. The managed pane title is `Pi Herd`.

For command-line checks, use:

```bash
./bin/pi-herdr-orchestrator doctor --json
./bin/pi-herdr-orchestrator broker status
./bin/pi-herdr-orchestrator events verify --json
```

A dry-run release rehearsal is also available:

```bash
npm run ops:plan
```

The rehearsal does not deploy, restart, or roll back a live process.

## Operator safety and runtime limits

The broker uses an owner-only Unix-domain socket and bounded newline-delimited JSON frames. It has no TCP listener and no arbitrary shell broker method. External commands use argument arrays without shell interpolation.

Canonical state uses a verified event chain and authenticated snapshots. Recovery fails closed on corrupt or ambiguous state. Resource operations revalidate identity and preserve dirty, replaced, missing, or ambiguous worktrees instead of deleting them.

The extension does not serialize credentials, environment variables, prompts, tool output, file contents, session-file paths, or working directories into the deck state. This package is a same-user control plane, not a sandbox. Its processes have the permissions of the account that runs Pi and Herdr.

Retained registration files have count, size, age, type, ownership, mode, symlink, replacement, and hard-link admission checks. Normal uninstall preserves state. Data deletion is a separate owner-approved operation after the broker and managed agents stop.

See [docs/OPERATIONS_M7.md](docs/OPERATIONS_M7.md) for recovery, export, retention, and operation-plan details. See [docs/OPERATIONS_M7_RELEASE.md](docs/OPERATIONS_M7_RELEASE.md) for the non-live release rehearsal.

## Roll back a local package change

Keep the prior reviewed package directory or exact checkout available. Before a separately approved rollback, stop new work and export and verify state as described in the operations runbook. Confirm that the prior version supports the stored state generation.

Remove the current Pi package with the exact source string used to install it. Then install the prior local directory:

```bash
CURRENT_PACKAGE_ROOT='/absolute/path/used-for-the-current-install'
PRIOR_PACKAGE_ROOT='/absolute/path/to-the-reviewed-prior-package'
pi remove "$CURRENT_PACKAGE_ROOT"
pi install "$PRIOR_PACKAGE_ROOT"
```

For project-local settings, use the same `-l` scope for both commands:

```bash
pi remove -l "$CURRENT_PACKAGE_ROOT"
pi install -l "$PRIOR_PACKAGE_ROOT"
```

Relink Herdr to the prior package root:

```bash
herdr plugin unlink pi.herdr.orchestrator
herdr plugin link "$PRIOR_PACKAGE_ROOT"
```

A live rollback also requires an approved restart, health checks, reconciliation, and recorded proof. The dry-run harness is plan-only and is not live rollback proof.

## Unlink and remove

Close a visible managed pane before unlinking when needed:

```bash
herdr plugin pane close replace-with-the-pi-herd-pane-id
```

Unlink the shipped plugin:

```bash
herdr plugin unlink pi.herdr.orchestrator
```

Remove the Pi package with the exact local source string used at installation:

```bash
PACKAGE_ROOT='/absolute/path/used-for-installation'
pi remove "$PACKAGE_ROOT"
```

For a project-local install:

```bash
pi remove -l "$PACKAGE_ROOT"
```

Normal removal does not delete orchestrator state, logs, results, or managed worktrees.

## Compatibility: legacy Pi Deck

This section describes compatibility entrypoints. They are not the primary package or plugin identifiers.

- `pi-herdr-deck` remains available for one release for the legacy Overview and Tools deck behavior. It prints a deprecation notice that directs operators to `pi-herdr-orchestrator deck` before it launches the new deck.
- `/herdr-deck-status` belongs to the legacy deck extension.
- The old plugin ID `pi.herdr.deck` is not the shipped plugin ID. Do not use it to open, unlink, or verify this release.
- The primary Pi package loads only `./dist/extensions/pi-herdr-orchestrator.js`. It does not load the legacy extension as its primary extension.

The legacy deck uses a same-user Unix socket, explicit target selection, bounded reconnect, no offline command queue, and capability checks for Pi mouse and tool-expansion APIs. Its status command is available only when the legacy deck extension is loaded explicitly. Use `/orchestrator-status` for the shipped package.

## Deferred scope

The Files UI is deferred. Version 0.1.0 does not provide a file browser, arbitrary shell execution, transcript mirroring, or raw terminal keystroke control.
