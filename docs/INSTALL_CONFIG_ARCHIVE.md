# Local install, configuration, and legacy archive

## Install

Build and validate the reviewed checkout before installation:

```bash
npm install
npm run validate
pi install "$(pwd)"
herdr plugin link "$(pwd)"
```

Use `pi install -l "$(pwd)"` for a project-local Pi install. Keep the local package directory at the same absolute path.

Linking the Herdr plugin does not run its startup hook. Use the authorized Herdr maintenance procedure to restart Herdr. Then verify the broker:

```bash
./bin/pi-herdr-orchestrator broker status
./bin/pi-herdr-orchestrator doctor --json
```

Pi `/reload` reconnects the currently loaded extension to an existing broker. Pi 0.84.2 can retain an old module factory after a deployed multi-module `dist/` changes. Fully exit and restart Pi after each extension deployment. Do not use `/reload` as the deployment activation step. It does not start a missing broker. A resumed Pi session is valid only after Herdr identity and broker reconciliation succeed.

## Configuration

Normal adopted Pi panes use the Herdr socket and pane context that Herdr supplies. Do not set or copy broker secrets, session keys, token files, pane IDs, or binary paths for normal use.

The package registers only `dist/extensions/pi-herdr-orchestrator.js`. It does not register any file in `archive/legacy-extensions/`.

Active-tool reconciliation changes only current orchestrator tool names. It preserves every active non-orchestrator tool. It fails closed when Pi reports a duplicate current orchestration name or any distinct legacy orchestration tool.

A managed broker question emits `herdr:blocked` while `orchestrator_ask` waits. The existing Herdr state integration remains the sole pane-state reporter. The broker remains the sole task and lifecycle authority.

The optional Artificial Analysis foundation source uses the fixed owner-only file `~/.config/pi-herdr-orchestrator/artificial-analysis.key`. Keep the key out of `config.json`, environment variables, command arguments, logs, and chat. The source is disabled unless `modelIntelligence.sources.artificialAnalysis.enabled` is true. See the scoped foundation section in the main README for the strict mapping shape and status commands. A source failure keeps the last good evidence and never blocks agent creation.

## Legacy archive

`archive/legacy-extensions/` contains four curated source files and an exact SHA-256 map. It excludes all private runtime and session data. See its README for the mapping and safety boundary.

Verify it with:

```bash
(cd archive/legacy-extensions && sha256sum --check SHA256SUMS)
```

The archive is intentionally inert. There is no activation script. Do not install it as a Pi extension or import its old tools.

Before an approved live migration, separately back up and hash the deployed settings, Herdr plugin registry and configuration, broker state, legacy runtime tree, legacy Pi sessions, package entrypoints, and repository state. Do not store those private backups in this repository.
