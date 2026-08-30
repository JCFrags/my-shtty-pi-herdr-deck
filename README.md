# Agent Board

`pi-herdr-orchestrator` is a Linux package for Pi and a managed-pane plugin for Herdr. It provides a local broker, Pi lifecycle integration, task and workflow control, result and question handling, a scheduler, and the Agent Board control pane.

This release is for reviewed local use. It does not publish an npm package or create a public release.

## Requirements

| Component | Minimum or requirement                  |
| --------- | --------------------------------------- |
| Linux     | Required                                |
| Node.js   | 22.19.0                                 |
| Herdr     | 0.8.2                                   |
| Pi        | 0.84.2 with the required extension APIs |

The plugin manifest requires Herdr 0.8.2. Upgrade Herdr before you link or open the plugin.

The Pi control deck also requires component mouse events, per-tool expansion state, current-turn and session bulk expansion selectors, and expansion-change subscription. If these APIs are absent, the deck reports an incompatibility and does not emulate them with terminal input.

## Shipped identifiers

| Item                      | Shipped value                                |
| ------------------------- | -------------------------------------------- |
| Pi extension              | `./dist/extensions/pi-herdr-orchestrator.js` |
| Primary Pi status command | `/orchestrator-status`                       |
| Agent settings command    | `/agent-settings`                            |
| Herdr plugin ID           | `pi.herdr.orchestrator`                      |
| Managed pane entrypoint   | `deck`                                       |
| Managed pane title        | `Agent Board`                                |
| Managed pane command      | `./bin/pi-herdr-orchestrator deck`           |
| Startup hook command      | `./bin/pi-herdr-orchestrator broker startup` |
| Minimum Herdr             | `0.8.2`                                      |

The package manifest and plugin manifest are the source of truth for these identifiers.

## Build and validate

Run these commands from the package root:

```bash
npm install
npm run validate
```

The build emits the Pi extension and runtime under `dist/`. Validation runs type checks, schema checks, the static release-document check, the build, unit and integration tests, and the package smoke test. Tests use local fakes and do not need a live Pi or Herdr process.

## Managed model, placement, and lifecycle policy

The broker resolves one exact provider, model, and thinking selection before provisioning. An identity-bound explicit user or task selection has precedence. Otherwise, the broker applies its installed-capability checks, allowlist, and configured selection policy. A settings change does not change an agent that is already running.

The broker reads `~/.config/pi-herdr-orchestrator/config.json` by default. Set `PI_HERDR_ORCH_CONFIG_PATH` to use a different owner-controlled file. Use `modelPolicy.defaults.global`, `modelPolicy.defaults.projects`, and `modelPolicy.defaults.roles` for scoped defaults. An optional allowlist can restrict the effective selection. The broker and provisioner validate the model and its exact thinking levels against the installed Pi catalog before they create a Herdr resource. This includes `xhigh` and `max` only when the installed model reports support.

Run `/agent-settings` in Pi to edit the broker-owned agent settings. The main screen keeps model scope, routing mode, endpoint capacity, exact model-to-endpoint mappings, task-profile scoring, and foundation-source status in one draft. Open one scoped model to choose its allowed thinking levels. Open a task profile to edit capability, protocol reliability, speed, effective cost, human preference, uncertainty penalty, and tie band values. Profile weights must total 1,000,000 parts per million. Endpoint IDs must already exist in the owner configuration before the screen can map models to them. One Save action validates and persists the complete batch before it changes broker runtime state. Escape cancels the draft. Changes apply only to new agents.

Restricted scope must retain every effective model default and supports at most 64 exact model and thinking-level pairs. `/agent-settings` keeps those default pairs locked because delegate, compact, workflow, retry, and replay paths can still use them. `explicit_required` prevents a direct `agent_spawn` call from using a locked default when the caller omits `model`. Unrestricted scope removes the allowlist. Endpoint limits are hard concurrent-agent limits. Lowering a limit below current use does not stop an active agent. It blocks new admission until use falls below the new limit. A manual foundation refresh remains bounded to the configured scoped models and does not block agent creation.

The Agent Board Settings overlay also shows installed choices. Press `d` in Settings to save a scoped default. Open Agents and press `n` to create an agent with a lifecycle class and either an explicit identity-bound selection or broker selection. The `agent_spawn` tool supports the same optional override. After resolution, Pi starts with explicit `--provider`, provider-qualified `--model`, and `--thinking` arguments. Managed registration must report the same selection. A successful `agent_spawn`, non-dry-run delegation, or accepted compact delegation result reminds the parent to collect each terminal task and conditionally close an unneeded open agent. Delegation dry runs and compact previews omit the reminder because they create no task.

Lifecycle classes are `temporary`, `reusable`, `retained`, and `pinned`. Agent lists and the inspector show the class and close recommendation. A temporary agent is recommended for close only after its task is terminal and its result is collected. Reusable agents stay idle and marked for reuse. Press `o` in Settings to enable or disable safe automatic closure. Automatic closure never closes a pinned, retained, reusable, blocked, or active agent. It also never closes an agent with an uncollected result.

The parent extension subscribes to broker-owned state events. Normal child settlement arrives through terminal `run.state_changed`. Direct task terminal paths can arrive through `task.state_changed`. A succeeded, failed, cancelled, or timed-out child task injects a `pi-herdr-task-terminal` follow-up message and starts a parent turn when the parent is idle. The message names the task and assigned agent when available. It directs the parent to `task_collect`, then advises `agent_close` only if the agent remains open and is no longer needed. A blocked task does not count as terminal. The extension stores a small event cursor and exact task, state, and result delivery key in the Pi session. After a broker reconnect or Pi reload, it replays only the missed event suffix and does not suppress a later terminal result. Structured broker state remains completion truth. The reminder is not lifecycle authority. The extension does not infer completion from final prose.

The broker sends narrower task rules through its identity-tracked temporary system-prompt file. It does not create or copy `AGENTS.md`. A project-owned `AGENTS.md` remains under user control and is inherited from the selected cwd. If a task requires a custom task-local `AGENTS.md`, place it only in that task's broker-created isolated worktree. Its lifecycle is the worktree lifecycle. An authorized close removes the exact clean owned worktree. A dirty, replaced, missing, or ambiguous worktree is retained with a cleanup reason instead of being removed. Do not create permanent per-worker instruction directories outside broker-owned workspaces.

A task agent uses `current-workspace` placement by default. A caller can request `new-workspace` placement. Herdr creates the visible workspace before Pi starts. A worktree task uses the new workspace that Herdr creates for the worktree. `agent_close` and `group_close` close an exact broker-created tab when it still contains only the managed pane. If another pane exists in that tab, broker closure preserves the tab and closes only the managed pane. Legacy `manager` and `subagent` model profiles remain only for rollback compatibility.

The read-only `agent_list` parent tool authorizes descendant scope before it applies filters. It supports exact agent IDs, managed state, agent lifecycle state, profile, assigned task, workspace, and live managed-client connection filters. Results use stable agent-ID order, a numeric cursor, a limit, and an output byte bound. `connected` means that the broker has one authenticated live child connection for the current agent generation and Pi session. The tool does not advertise expanded `include` sections. A direct broker request with a nonempty `include` receives a clear `INVALID_REQUEST` response.

`agent_result` reads an accepted structured result. It does not mark that result as collected and cannot make a temporary agent eligible for close. `task_collect` returns bounded result summaries and appends `task.collected` only for each complete, untruncated result that it returns. Collection can change the broker-owned close recommendation after the task is terminal. Use `agent_result` for inspection and `task_collect` for collection. After collection, use `agent_close` only when the assigned agent remains open and is no longer needed.

Example configuration:

```json
{
  "version": 1,
  "modelPolicy": {
    "defaults": {
      "global": {
        "provider": "openai-codex",
        "modelId": "gpt-5.6-luna",
        "thinkingLevel": "medium"
      },
      "roles": {
        "planner": {
          "provider": "openai-codex",
          "modelId": "gpt-5.6-sol",
          "thinkingLevel": "high"
        }
      },
      "projects": {
        "/home/mainpc/Projects/example": {
          "provider": "openai-codex",
          "modelId": "gpt-5.6-sol",
          "thinkingLevel": "max"
        }
      }
    }
  },
  "lifecyclePolicy": { "autoCloseCompletedTemporary": false }
}
```

### Scoped internet foundation data

The optional Artificial Analysis adapter imports task-capability scores as a capped foundation prior. It uses only `GET /api/v2/language/models/{slug}`. It does not list or import the provider catalog. Before it sends a request, the broker requires an installed Pi model, permission from the broker allowlist when one is configured, an exact runtime mapping, and an explicit canonical-to-source mapping. Runtime variants that map to one canonical model share one request.

Add the source under the existing version-1 configuration. Every exact runtime mapping needs a declared scheduler endpoint. `profileMetrics` maps a broker task profile to one supported source metric: `coding`, `intelligence`, or `agentic`.

```json
{
  "version": 1,
  "scheduler": {
    "endpoints": {
      "remote_primary": { "maxConcurrentAgents": 4 }
    }
  },
  "modelIntelligence": {
    "schemaVersion": 1,
    "mappings": [
      {
        "provider": "openai-codex",
        "modelId": "gpt-5.6-luna",
        "endpointId": "remote_primary",
        "canonicalModelId": "openai/gpt-test"
      }
    ],
    "sources": {
      "artificialAnalysis": {
        "enabled": true,
        "refreshHours": 168,
        "maxRequestsPerRefresh": 4,
        "profileMetrics": {
          "implementer": "coding",
          "planner": "intelligence"
        },
        "models": [
          {
            "canonicalModelId": "openai/gpt-test",
            "slug": "gpt-test"
          }
        ]
      }
    }
  }
}
```

Artificial Analysis requires a supported API entitlement. Store its key only in `~/.config/pi-herdr-orchestrator/artificial-analysis.key`. The broker accepts one owner-only regular file. It rejects symlinks, unsafe modes, invalid ownership, extra lines, and values outside the bounded format. Do not put the key in `config.json`, an environment variable, a command argument, state, logs, or chat.

```bash
install -d -m 700 ~/.config/pi-herdr-orchestrator
install -m 600 /dev/null ~/.config/pi-herdr-orchestrator/artificial-analysis.key
${EDITOR:-vi} ~/.config/pi-herdr-orchestrator/artificial-analysis.key
```

Restart the broker after a configuration change. Use these operator commands to inspect state or request one bounded asynchronous refresh:

```bash
./bin/pi-herdr-orchestrator foundation status
./bin/pi-herdr-orchestrator foundation refresh
```

A refresh runs outside agent admission and the broker mutation queue. Missing credentials, source outages, rate limits, or rejected data report `failed` or `stale` status. They do not block agent creation and do not replace the last validated snapshot. Source evidence records its Artificial Analysis attribution, observation time, expiry, canonical model, task profile, and content-derived identity in the existing hash-chained event store. It does not change model selection in this release.

### Advisory model options and shadow receipts

The read-only `agent_model_options` parent tool ranks only exact provider, model, and thinking pairs that Pi reports as available and that the current task profile, placement, and broker allowlist permit. It calls broker method `model.options`. The request requires `profileId`. It can also include `placement`, `modelProfileId`, `projectKey`, and a result `limit` from 1 to 16. The parent tool requests 16 options by default. The broker rejects an eligible scope above 256 exact pairs.

The broker method and parent tool both return the same short public list under `availableModels`; this keeps direct broker-backed tool routes from exposing the internal ranking object. Each entry contains only the exact `provider`, `modelId`, and `thinkingLevel` needed by `agent_spawn`, its rank, recommendation flag, readable availability, and simple whole-star ratings from 0 to 5. `overall` projects the confidence-adjusted final score. `taskFit`, `reliability`, `speed`, and `value` project the corresponding task capability, protocol reliability, speed, and effective-cost components. Each parts-per-million value is rounded to the nearest whole star and formatted as `★★★★★ 5/5`; a negative final score is shown as zero. The response contains no raw scores, broker-policy exclusions, other internal score components, evidence dates, or digests. The collapsed TUI shows five entries with their overall rating. Expanding it shows all returned entries and the four category ratings. Internal ranking, selection, receipts, and audits continue to use the complete private view.

Version 1 defaults to integer weights of 45% task capability, 25% protocol reliability, 10% endpoint speed, 5% effective cost, and 15% human preference. Each task profile can override these parts-per-million weights, the uncertainty penalty, and the tie band. Missing confidence can subtract up to the configured penalty. The default two-point tie band uses provider, model ID, thinking level, and endpoint ID as the stable tie order. It does not disclose a configured default selection.

Endpoint capacity is separate from model eligibility and quality. An eligible model remains in the list when its endpoint has no free slot; the entry then says `will queue`. Capacity cannot change a quality score, rank group, or ranking digest.

Every created agent task stores one bounded `advisoryModelReceipt` inside its existing durable project payload. This applies to `agent_spawn`, `delegate`, accepted compact delegation, and workflow creation. The receipt freezes the model that the broker selected, the top option, alternatives, capacity, evidence and policy digests, routing mode, and selection reason. A selected model that is outside the installed ranking scope stays selected and is marked ineligible with a null rank.

`modelIntelligence.routingMode` controls application. A missing value and `current_default` preserve the configured default. `advisory` reports rankings without applying them. `rated_auto` can replace the model only for a direct `agent_spawn` request that omitted an explicit model. The first candidate must have nonzero confidence. The next candidate must also be outside the configured tie band. Otherwise, the broker keeps the configured default and records `insufficient_evidence`. `explicit_required` rejects a non-dry direct `agent_spawn` request that omits `model`. In this mode, a restricted allowlist can omit configured defaults, but it must contain at least one exact model and thinking-level pair. The settings UI does not lock or preselect a default pair in this mode. The bounded `MODEL_SELECTION_REQUIRED` response identifies only `model` as missing. It directs the caller to `agent_model_options` and to retry the same visible arguments with only `model` added. The rejection occurs before workflow, task, run, agent, endpoint-lease, Herdr, worktree, or task-instruction mutation. The broker stores no pending request. Explicit model selections always have precedence after normal policy validation. Delegate, compact delegation, workflow, retry, and replay paths do not select independently.

Set routing mode to `current_default` to roll back automatic or required explicit selection without deleting evidence, endpoint limits, or mappings. Ranking never changes endpoint capacity. The existing scheduler remains the only admission authority.

A scoring override uses exact parts-per-million totals:

```json
{
  "version": 1,
  "modelIntelligence": {
    "schemaVersion": 1,
    "routingMode": "rated_auto",
    "mappings": [],
    "profiles": {
      "implementer": {
        "weightsPpm": {
          "taskCapability": 450000,
          "protocolReliability": 250000,
          "speed": 100000,
          "effectiveCost": 50000,
          "humanPreference": 150000
        },
        "uncertaintyPenaltyPpm": 100000,
        "tieBandPpm": 20000
      }
    }
  }
}
```

## Compact delegation rollback switch

The `delegate_compact` parent tool previews compact todo text without mutation. Scheduling requires `accept: true` and the exact preview digest. Accepted work uses the existing broker workflow, task, result, question, model, authority, and cleanup paths.

Set `PI_HERDR_COMPACT_DELEGATION=0` in the trusted broker startup environment to reject new compact compilation and scheduling. This switch does not delete or close existing tasks, metadata, tabs, worktrees, results, questions, or transcript references. Keep the current compatible broker available to collect or close existing compact work through exact identity checks.

## Link the Herdr plugin and run startup

Confirm that Herdr is version 0.8.2 or newer. Then link the reviewed package root:

```bash
PACKAGE_ROOT=$(pwd)
herdr plugin link "$PACKAGE_ROOT"
```

The manifest links plugin `pi.herdr.orchestrator`. It declares entrypoint `deck`, title `Agent Board`, and pane command `./bin/pi-herdr-orchestrator deck`. Its one-shot startup command is `./bin/pi-herdr-orchestrator broker startup`. Herdr resolves both relative commands from the linked package root.

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

Open a new Pi session inside Herdr after startup verification. Pi loads `./dist/extensions/pi-herdr-orchestrator.js` from the package manifest. The extension uses the standard Herdr socket and pane context. It attaches to the session broker and registers the current Pi pane as the adopted root. A reload reuses the same adopted root after the old client disconnects and Herdr verifies the new Pi session. The broker rejects a replacement while the old client remains connected. A normal extension reload can retain stale dependency bytes after a deployed package build. Fully exit and restart the Pi process for final acceptance of changed extension dependencies.

Do not set a broker socket, client secret, session key, token, terminal ID, or Herdr binary path for normal installed use. Ordinary Pi panes do not need the binary value. The broker never searches `PATH` for Herdr.

## Open Agent Board

Inside a Pi pane managed by Herdr, run `/agent-board` to open the `pi.herdr.orchestrator` deck as a focused right split targeting that pane. `/pi-herd` is a compatibility alias for the same open-or-focus path. The command uses Herdr's `HERDR_BIN_PATH` and `HERDR_PANE_ID` values and reports a clear notification when run outside Herdr. `/orchestrator-status` remains available.

Agent Board is a mouse-first right-side control surface. Its stable views are:

- **Board** partitions questions, blocked work, and waits into Needs Attention; active Todo, task, and group work into Current Work; and active provider updates into Recent Signals. Recommendation data belongs to a Signals question. Signals decisions appear only in Activity.
- **Files** shows the provider-backed repository tree and preview. Row, caret, and checkbox clicks have separate actions. Tree and preview scrolling are independent.
- **Agents** keeps broker-owned lifecycle, model, thinking, prompt, ask, stop, and close controls.
- **Activity** combines retained results, decisions, updates, terminal tasks, groups, and agent lifecycle records.

Press `,` or click **Settings** to open the temporary settings overlay. Settings is not a primary tab. Signals is the user-facing name for the provider formerly called Agent Board and Signalboard. Use `/signals` for its standalone UI. `/signalboard` is its compatibility alias.

`BrokerDeckApp` is the shell and dispatcher. Typed Board, Files, Agents, Activity, and overlay modules own screen rendering and terminal-cell geometry. One `OverlayState` owns Settings, Help, Agent More, confirmations, text input, and question responses. Modal input has priority over screen and global input. The shell header shows connection state, adopted scope, the canonical Needs Attention count, Settings, and Help.

Board uses one canonical selected item. Typed action routing resolves that item at activation time. Broker and Signals questions use the question-response overlay. Signals answer requests keep exact option IDs and current revisions. Files keeps the exact provider-relative action path separate from safe display text and hitbox keys. At 78 columns or more, Files renders Tree and Preview in a 38/62 split. At narrower widths, it renders persistent Tree and Preview tabs. Provider refreshes are microtask-coalesced. Render dependencies compare the visible shell plus only the active screen or overlay.

Representative plain output from the final renderer:

```text
AGENT BOARD  ONLINE  scope: project  attention: 2  [Settings] [Help]
[BOARD 1] [Files 2] [Agents 3] [Activity 4]
NEEDS ATTENTION              │ DETAIL · SIGNALS question
> [SIGNALS] waiting Approve  │ Choose one response.
CURRENT WORK                 │ [Submit Answer] [Cancel]
  [TODO] running Build       │

FILES · selected 2 · 1.2 KiB · ~300 tokens
TREE (38%)                   │ PREVIEW (62%)
▾ src                        │ path: src/index.ts
  ☐ index.ts                 │ encoding: utf-8 · 24 lines
  ☐ cli.ts                   │ 1  export function main() {
[Insert paths] [Insert contents] [Clear selection] [Refresh] [Open standalone Files]

[Tree] [Preview]
TREE · narrow
▾ src
  ☐ index.ts
```

The installed Pi extension requests and watches provider summaries through these stable `pi.events` names:

- `pi-agent-board:request-summary-v1`
- `pi-agent-board:summary-v1`
- `pi-agent-board:summary-changed-v1`
- `pi-todo:request-summary-v1`
- `pi-todo:summary-v1`
- `pi-todo:summary-changed-v1`

Provider callback wrappers can change. The adapters accept common `summary`, `snapshot`, and `data` wrappers. Each projection is bounded and serializable. The authenticated Pi adapter sends it to the broker. The broker keeps it only in memory and includes it in deck snapshots and change events. The provider keeps authority. The broker does not persist these projections. A missing provider appears as unavailable and does not fail the deck.

Click tabs, entity rows, and action buttons in the managed pane. Mouse tracking is enabled only in that managed pane. The main Pi pane keeps its normal mouse behavior.

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

Herdr supplies the plugin context. Agent Board checks the selected pane against live agent data. It does not silently attach to an arbitrary pane when identity is missing or ambiguous. The deck uses the same canonical session resolver and starts or reuses the same broker. You do not need to start a service before you open it.

## Verify

In the target Pi pane, run:

```text
/orchestrator-status
```

The command reports the orchestrator extension and broker state. The managed pane title is `Agent Board`.

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

Active `agent.spawn`, `agent.get`, `agent.list`, `task.get`, and `task.list` responses include a broker-derived `progress` object when work is queued, creating Herdr resources, waiting for Pi registration, or starting Pi. It contains the phase, operation start time, elapsed milliseconds, and the current task or registration deadline with remaining or overdue milliseconds. Agent Board shows the same data in agent and task detail. These values are a read-time view of existing task, run, agent, and Herdr resource state. They are not a second lifecycle record. Elapsed and remaining values are a snapshot and update on the next read or board snapshot.

A broker request timeout now names the method, the connect or response phase, the configured timeout, and the observed elapsed time. During broker startup, only this known request timeout is retried under the existing 15-second authenticated readiness deadline. Authentication and the broker ping remain the only readiness authority.

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

Registration files have count, size, age, type, ownership, mode, symlink, replacement, and hard-link admission checks. After successful registration, the broker moves verified prompt and token files from `prompts/` to the owner-only `registration-archive/` directory. This keeps the active admission directory below its 128-file limit without deleting registration evidence. If agent creation reports `HERDR_REGISTRATION_RETENTION_BUDGET_EXCEEDED`, check for files that remained in `prompts/` before you retry. Normal uninstall preserves state. Data deletion is a separate owner-approved operation after the broker and managed agents stop.

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

The Files view consumes the additive `/files` provider protocol. It does not mirror a terminal or use arbitrary shell execution. **Open standalone Files** focuses the adopted Pi pane and invokes the provider-supported standalone entrypoint when that capability is available. Version 0.1.0 does not provide transcript mirroring or raw terminal keystroke control.
