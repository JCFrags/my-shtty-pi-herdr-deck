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
| Startup hook command      | `./bin/pi-herdr-orchestrator broker startup` |
| Minimum Herdr             | `0.8.0`                                      |

The package manifest and plugin manifest are the source of truth for these identifiers.

## Build and validate

Run these commands from the package root:

```bash
npm install
npm run validate
```

The build emits the Pi extension and runtime under `dist/`. Validation runs type checks, schema checks, the static release-document check, the build, unit and integration tests, and the package smoke test. Tests use local fakes and do not need a live Pi or Herdr process.

## Managed model and placement policy

A task agent uses `current-workspace` placement by default. It starts in a new visible tab in the authenticated parent workspace. The default `subagent` model profile is `openai-codex/gpt-5.6-luna` with `medium` thinking.

A caller can request `new-workspace` placement with the `manager` model profile. Herdr creates the visible workspace before Pi starts. The default manager selection is `openai-codex/gpt-5.6-sol` with `medium` thinking. A worktree task uses the new workspace that Herdr creates for the worktree.

The broker resolves task-profile compatibility and the model allowlist first. The provisioner then reads the installed Pi model catalog and CLI thinking capabilities before it creates registration files or Herdr resources. Pi starts with explicit `--provider`, provider-qualified `--model`, and `--thinking` arguments. Managed registration must report the same provider, model, and thinking level. A mismatch fails registration and compensates the pending visible resources.

Broker configuration can override the `manager` and `subagent` selections, the allowlist, and task-profile compatibility through `modelPolicy`. The broker reads `~/.config/pi-herdr-orchestrator/config.json` by default. Set `PI_HERDR_ORCH_CONFIG_PATH` to use a different owner-controlled file. The effective selection must be in the allowlist. The `max` thinking level is not permitted.

## Compact delegation rollback switch

The `delegate_compact` parent tool previews compact todo text without mutation. Scheduling requires `accept: true` and the exact preview digest. Accepted work uses the existing broker workflow, task, result, question, model, authority, and cleanup paths.

Set `PI_HERDR_COMPACT_DELEGATION=0` in the trusted broker startup environment to reject new compact compilation and scheduling. This switch does not delete or close existing tasks, metadata, tabs, worktrees, results, questions, or transcript references. Keep the current compatible broker available to collect or close existing compact work through exact identity checks.

## Link the Herdr plugin and run startup

Confirm that Herdr is version 0.8.0 or newer. Then link the reviewed package root:

```bash
PACKAGE_ROOT=$(pwd)
herdr plugin link "$PACKAGE_ROOT"
```

The manifest links plugin `pi.herdr.orchestrator`. It declares entrypoint `deck`, title `Pi Herd`, and pane command `./bin/pi-herdr-orchestrator deck`. Its one-shot startup command is `./bin/pi-herdr-orchestrator broker startup`. Herdr resolves both relative commands from the linked package root.

Linking or enabling the plugin does not run its startup hook. Use the authorized Herdr maintenance procedure to start or restart Herdr after the link. Herdr runs the hook after restore and socket readiness. The hook receives the authoritative binary path, starts or reuses one broker, writes no secret to standard output or standard error, and exits. This restart is an installation step. It is not a manual broker service, secret, or binary-path step.

After the authorized Herdr restart, verify the attach-only broker from an ordinary Herdr pane:

```bash
./bin/pi-herdr-orchestrator broker status
./bin/pi-herdr-orchestrator doctor --json
```

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

Open a new Pi session inside Herdr after startup verification. Pi loads `./dist/extensions/pi-herdr-orchestrator.js` from the package manifest. The extension uses the standard Herdr socket and pane context. It attaches to the session broker and registers the current Pi pane as the adopted root. A reload reuses the same adopted root.

Do not set a broker socket, client secret, session key, token, terminal ID, or Herdr binary path for normal installed use. Ordinary Pi panes do not need the binary value. The broker never searches `PATH` for Herdr.

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

Herdr supplies the plugin context. Pi Herd checks the selected pane against live agent data. It does not silently attach to an arbitrary pane when identity is missing or ambiguous. The deck uses the same canonical session resolver and starts or reuses the same broker. You do not need to start a service before you open it.

## Verify

In the target Pi pane, run:

```text
/orchestrator-status
```

The command reports the orchestrator extension and broker state. The managed pane title is `Pi Herd`.

For command-line checks, run these commands in a Herdr pane:

```bash
./bin/pi-herdr-orchestrator doctor --json
./bin/pi-herdr-orchestrator broker status
./bin/pi-herdr-orchestrator events verify --json
```

Ordinary Herdr panes can use authenticated attach-only checks and stop:

```bash
./bin/pi-herdr-orchestrator broker status
./bin/pi-herdr-orchestrator doctor --json
./bin/pi-herdr-orchestrator events verify --json
./bin/pi-herdr-orchestrator broker stop
```

`status` reports only an authenticated broker. `doctor` asks that broker to run the same checks with its retained exact Herdr binary. The response does not include a binary path, session key, client secret, or token. `stop` verifies the recorded process-start identity before it requests shutdown. It does not signal an unverified process.

The public `broker start` and `broker restart` commands require Herdr plugin runtime context because only that context has the authoritative binary path. Do not run them from an ordinary pane. Normal installation and recovery use an authorized Herdr start or restart so Herdr runs the one-shot startup hook. Do not set or copy a binary path.

A dry-run release rehearsal is also available:

```bash
npm run ops:plan
```

The rehearsal does not deploy, restart, or roll back a live process.

## Operator safety and runtime limits

The broker uses one owner-only Unix-domain socket for each canonical Herdr session and bounded newline-delimited JSON frames. Runtime records and the client secret use owner-only paths. State and logs use a separate per-session state directory. The broker has no TCP listener and no arbitrary shell broker method. External commands use argument arrays without shell interpolation.

Canonical state uses a verified event chain and authenticated snapshots. Recovery fails closed on corrupt or ambiguous state. Resource operations revalidate identity and preserve dirty, replaced, missing, or ambiguous worktrees instead of deleting them.

The extension does not serialize credentials, environment variables, prompts, tool output, file contents, session-file paths, or working directories into the deck state. This package is a same-user control plane, not a sandbox. Its processes have the permissions of the account that runs Pi and Herdr.

Retained registration files have count, size, age, type, ownership, mode, symlink, replacement, and hard-link admission checks. Normal uninstall preserves state. Data deletion is a separate owner-approved operation after the broker and managed agents stop.

See [docs/OPERATIONS_M7.md](docs/OPERATIONS_M7.md) for recovery, export, retention, and operation-plan details. See [docs/OPERATIONS_M7_RELEASE.md](docs/OPERATIONS_M7_RELEASE.md) for the non-live release rehearsal. See [docs/INSTALL_CONFIG_ARCHIVE.md](docs/INSTALL_CONFIG_ARCHIVE.md) for concise local install, reload, configuration, and legacy archive rules.

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

Before a live package rollback, run `./bin/pi-herdr-orchestrator broker stop` from the affected Herdr session. Restore and link the prior reviewed package. Then use an authorized Herdr start or restart so its startup hook starts the compatible broker. Verify `broker status` and `doctor --json` before you reopen Pi and run `/orchestrator-status`. Reopening Pi alone does not start a broker. A live rollback also requires approved health checks, reconciliation, and recorded proof. The dry-run harness is plan-only and is not live rollback proof.

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
