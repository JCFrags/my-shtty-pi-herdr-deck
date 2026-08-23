# Agent Board consolidation

## Purpose

Agent Board is the unified mouse-first side TUI for Pi and Herdr. It replaces the visible Pi Herd deck identity. It has four primary surfaces: Board, Files, Agents, and Activity. Settings is a temporary overlay.

## Current architecture

The package has one broker-backed deck in `src/deck/broker-app.ts`. It reads broker state and bounded provider projections. Phase 1 had six tabs: Home, Work, Files, Agents, Board, and Settings. Work also had Todo, Tasks, Results, Groups, and History views. The provider that emits `pi-agent-board:*` events is tracked in `/home/mainpc/Projects/pi-signal-board`. The provider previously owned `/agent-board` and presented itself as Agent Board.

Repository B, `/home/mainpc/Projects/my-shtty-pi`, owns the standalone `packages/files-ui` source. It does not own the Signals provider.

## Final architecture

`BrokerDeckApp` owns shell state and dispatch. Pure selectors in `product-presentation.ts` build bounded Board and Activity models. Existing scope, provider-authority, task-detail, agent-list, and Signals normalization selectors remain authoritative. The Files surface consumes only the versioned provider projection. It does not read the repository directly.

```text
Pi and broker events
       |
       v
DeckState + bounded provider projections
       |
       +-- selectUnifiedBoardPresentation
       +-- selectFilesPresentationAuthority
       +-- selectAgentListPresentation
       +-- selectActivityPresentation
       |
       v
Board | Files | Agents | Activity
              + Settings and Help overlays
```

## Visible naming map

| Old visible name                   | Final visible name         |
| ---------------------------------- | -------------------------- |
| Pi Herd / Pi Herdr Deck            | Agent Board                |
| Agent Board provider / Signalboard | Signals                    |
| Home                               | Board sections or Activity |
| Work / Todo / Tasks / Groups       | Board current work         |
| Board / Inbox                      | Board attention queue      |
| Results / History                  | Activity                   |
| Settings tab                       | Settings overlay           |

## Internal compatibility map

The plugin ID `pi.herdr.orchestrator`, executable names, package name, broker paths, persisted schemas, global symbols, provider event names, provider tool names, and wire field `agentBoard` do not change. The legacy `/pi-herd` command remains an alias. The provider keeps `pi-agent-board:*` event names and `signal_board_*` tools.

## Command ownership

The unified orchestrator extension is the sole owner of `/agent-board`. `/agent-board` and `/pi-herd` call the same open-or-focus handler. The tracked provider moves its standalone UI to `/signals`. It may keep `/signalboard` as a compatibility alias. It must not register `/agent-board` or `/agentboard`.

## Provider ownership

| Capability            | Tracked owner                           | Contract                    |
| --------------------- | --------------------------------------- | --------------------------- |
| Signals               | `/home/mainpc/Projects/pi-signal-board` | `pi-agent-board:*` events   |
| Todo                  | Pi Todo provider                        | `pi-todo:*` events          |
| Files                 | Repository B `packages/files-ui`        | `pi-files-ui:*` events      |
| Orchestrator entities | This repository                         | broker snapshot and actions |

## Surface-to-capability migration

| Old surface                          | New location                            |
| ------------------------------------ | --------------------------------------- |
| Home portfolio and notices           | Board summary and notices               |
| Work Todo                            | Board current work                      |
| Work Tasks                           | Board current work and detail           |
| Work Groups                          | Board current work and actions          |
| Work Results                         | Activity                                |
| Work History                         | Activity                                |
| Provider Board Inbox                 | Board attention queue, labelled Signals |
| Provider updates and recommendations | Board attention and Activity            |
| Provider decisions and history       | Activity                                |
| Settings                             | Header and `,` overlay                  |

## Board item taxonomy

`BoardItem` is a discriminated union with `todo`, `task`, `group`, `broker-question`, `signal-question`, `signal-update`, and `signal-recommendation`. Keys include the source kind, so equal source IDs do not collapse. Todo and orchestrator tasks remain separate. Current work excludes terminal tasks and groups. Attention contains unanswered broker questions and current Signals questions, updates, and recommendations. Stable kind-plus-ID ordering prevents map insertion order from changing the UI.

## Activity item taxonomy

`ActivityItem` contains `result`, terminal `task`, terminal `group`, terminal `agent`, `signal-update`, `signal-decision`, and `signal-history`. The adopted scope filters broker entities. Provider tabs stay bounded by the Signals presentation selector. Stable kind-plus-ID ordering gives deterministic fallback selection.

## Files interaction contract

The provider view is authoritative. A focused path and provider selection are different states.

- Clicking a file row focuses and previews it. It does not select it.
- Clicking a caret expands or collapses a directory.
- Clicking a checkbox changes provider selection.
- Enter can perform the explicit combined keyboard action.
- Tree and preview have independent scroll state.
- Filtering uses the provider action and a bounded local display filter for compatibility.
- The action bar supports refresh, preview, clear, insert paths, insert contents, and standalone open.
- The deck never reads arbitrary files directly.

## Responsive behavior

Wide terminals keep enough room for list and detail information. Narrow terminals keep rows and controls in one column. Control rows wrap. Hit boxes are created from emitted geometry, not ANSI output. Files caret, checkbox, row, tree-scroll, and preview-scroll regions are independent.

## Render invariants

- Polling stays active.
- A store update renders only when the visible surface model changes.
- Local selection changes synchronize the dependency baseline.
- Provider authority fails closed when pane identity is ambiguous.
- Files depends only on selected Files authority, Files projection, and standalone-open availability.
- Board and Activity depend only on their bounded presentation models.
- Settings capability and policy responses request their own render.
- Protocol timestamps and heartbeat churn do not repaint unless visible.

## Examples

### Board

```text
AGENT BOARD  ● ONLINE
[BOARD 1] [Files 2] [Agents 3] [Activity 4] [Settings ,]
BOARD  4 current · 2 need attention
CURRENT WORK
> [working] Implement parser
  [open] Review Todo
ATTENTION
  [attention] Broker approval needed
  [OPEN] SIGNALS · Choose deployment
```

### Files

```text
FILES  ● READY
TREE                         PREVIEW src/index.ts
  ▾ [ ] src                 │ export function main() {
> · [x] index.ts            │   ...
[Insert paths] [Insert contents] [Clear selection]
```

### Agents

```text
AGENTS · ACTIVE
> worker-a  working
  worker-b  idle
AGENT DETAIL
Model openai-codex/gpt-5.6-luna
[Focus] [Prompt] [Ask] [Interrupt] [Stop] [Close]
```

### Activity

```text
ACTIVITY  Results · decisions · updates · groups · lifecycle
> [accepted] Validation passed
  [decision] SIGNALS · Keep compatibility alias
  [closed] group release-check
```

### Settings

```text
SETTINGS  Escape or , closes
[Set model default] [Toggle auto-close] [Close]
DEFAULTS FOR NEW AGENTS
Global openai-codex/gpt-5.6-luna · medium
```

## Non-goals

This phase does not rename compatibility-sensitive IDs. It does not change broker or provider schemas. It does not replace the standalone Files package. It does not create a new Signals provider. It does not add raw terminal control or direct repository filesystem access.

## Upgrade and migration

Install the unified extension and the tracked Signals and Files providers in the same Pi session. Use `/agent-board` for the unified product. Existing `/pi-herd` scripts continue to work. Use `/signals` for the standalone Signals UI. Existing data, event names, broker state, and provider wire formats need no migration. Reload must transfer runtime ownership without duplicate handlers.
