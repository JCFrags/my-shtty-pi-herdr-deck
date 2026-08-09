# my-shtty-pi-herdr-deck

The `pi-herdr-deck` package is a combined Pi package and Herdr plugin that opens a narrow, mouse-first control deck beside a running Pi pane. Version 0.1.0 is Linux-only and exposes two functional tabs: **Overview** and **Tools**.

The deck controls Pi through a private Unix-domain socket created by the Pi extension. It does not inject terminal input, mirror the transcript, expose a shell command, or listen on TCP.

## Compatibility

| Component | Requirement |
| --- | --- |
| Operating system | Linux |
| Node.js | 22.19.0 or newer |
| Herdr | 0.7.2 or newer, with `agent.list` and `agent.focus` in the installed schema |
| Pi | A build exposing component mouse events, per-tool expansion state, current-turn/session bulk expansion selectors, and expansion-change subscription |

The Herdr minimum is **0.7.2**, not the version used by a developer workstation. Herdr plugin v1 and managed panes appeared in 0.7.0, but this plugin also requires the authoritative `herdr api schema --json` command added in 0.7.2. At every deck startup, the installed binary is queried and the required methods are checked before any wrapper is invoked.

Pi is capability-gated rather than version-gated. The extension and standalone deck use the same compatibility text:

> Pi Deck requires Pi with component mouse events, per-tool expansion state and bulk selectors, and expansion-change subscription. The installed Pi API is incompatible.

An incompatible Pi session starts a permission-restricted rejection endpoint long enough for the deck to receive that exact reason and stop reconnecting. No stack trace is shown.

The standalone process first checks a host-provided `@earendil-works/pi-tui` peer, then falls back to the exact `@earendil-works/pi-tui@0.83.0` runtime pinned through the private npm alias `@pi-herdr-deck/tui`. The extension imports Pi's host-side `@earendil-works/pi-tui` and other Pi core packages only through peer dependencies; none are bundled.

The public Pi 0.83.0 API/package surface was used as the compatibility baseline. That stock surface exposes only a global tool-expansion boolean and does not export the required component mouse API, so an unmodified Pi 0.83.0 installation follows the explicit incompatibility path above. A functional deck requires a Pi build that adds all four capability-gated surfaces; the extension never substitutes raw mouse parsing or terminal keystroke control.

## Build

From the repository root:

```bash
npm install
npm run build
```

The build emits the extension and deck under `dist/`. The package manifest points Pi at `dist/extensions/pi-herdr-deck.js`, so build before installing from a local path. For a capability-complete Pi fork, resolve the peer package names in this checkout to that fork before building; the peers remain external and are not included in the npm archive.

Run the full validation suite with:

```bash
npm run validate
```

Development validation for this release used Node.js 24.11.1 and TypeScript 5.8.3. Herdr 0.8.0 was exercised through its checked schema projection and a fake argv-compatible CLI; Pi 0.83.0 was exercised through source-shaped API fixtures, the incompatibility path, and a capability-complete fake bridge. No real Herdr or Pi executable, model provider, or model API key is required by the tests.

## Install as a Pi package

Install the built local directory. Pi records local paths without copying them, so keep the checkout in place.

```bash
pi install "$(pwd)"
```

For project-local installation, add `-l`:

```bash
pi install -l "$(pwd)"
```

Start or reload Pi after installation. Inside Pi, the command below reports the bridge state:

```text
/herdr-deck-status
```

When Pi is not running in a Herdr pane, the extension remains loadable and reports that `HERDR_PANE_ID` is unavailable.

## Link as a Herdr plugin

```bash
herdr plugin link "$(pwd)"
```

The manifest declares one managed pane entrypoint:

| Field | Value |
| --- | --- |
| Stable plugin ID | `pi.herdr.deck` |
| Entrypoint | `deck` |
| Title | `Pi Deck` |
| Default placement | `split` |
| Platform | `linux` |
| Build command | `npm run build` as argv |
| Minimum Herdr | `0.7.2` |
| Pane command | `./bin/pi-herdr-deck` as argv |

There are no placeholder Files, Review, Sessions, or Agents tabs.

## Open the deck beside a selected Pi pane

First list live agents and identify the Pi pane ID:

```bash
herdr agent list
```

Open the managed deck as a right-hand split, targeting that pane explicitly:

```bash
PI_PANE='replace-with-the-pi-pane-id'
herdr plugin pane open \
  --plugin pi.herdr.deck \
  --entrypoint deck \
  --placement split \
  --target-pane "$PI_PANE" \
  --direction right \
  --focus
```

Herdr supplies the invocation context through `HERDR_PLUGIN_CONTEXT_JSON`. The deck verifies context candidates against live Pi agents returned by the schema-gated `agent list` wrapper. If the context does not identify exactly one live Pi pane, the deck shows a picker—even when discovery finds only one candidate. It never silently attaches to an arbitrary agent.

## Verify the connection

In the target Pi pane:

```text
/herdr-deck-status
```

A connected session reports the exact socket path. The deck header changes to `Connected to <pane-id>`, and Overview shows the current state/model/thinking/context fields.

The runtime location is:

```text
${XDG_RUNTIME_DIR}/pi-herdr-deck-${uid}/
```

or, when `XDG_RUNTIME_DIR` is unset:

```text
${os.tmpdir()}/pi-herdr-deck-${uid}/
```

The directory is mode `0700`; the socket is mode `0600` where supported. The filename is the sanitized Herdr Pi pane ID plus a collision-resistant suffix and `.sock`.

A shell-level verification on Linux:

```bash
BASE="${XDG_RUNTIME_DIR:-$(node -p 'require("node:os").tmpdir()')}"
RUNTIME_DIR="$BASE/pi-herdr-deck-$(id -u)"
stat -c '%a %U %n' "$RUNTIME_DIR" "$RUNTIME_DIR"/*.sock
```

Expected modes are `700` for the directory and `600` for the socket.

## Deck controls

### Overview

Overview shows Pi activity, current model, thinking level, context use, queued-message presence, Stop/Compact controls, and an editable message box.

Delivery rules are enforced on both sides of the socket:

- **Send** uses normal delivery and is enabled only while Pi is idle.
- **Steer** and **Follow-up** are enabled only while Pi is working.
- Empty messages are rejected.
- **Stop** aborts only a working run.
- **Compact** is enabled only while Pi is idle.
- Model changes require an exact provider/model ID pair from the advertised scoped choices.

### Tools

Tools shows the expanded/total count, status filter, active-tool selectors, individual tool calls, and four bulk controls:

- current-turn Expand and Collapse;
- session Expand and Collapse.

Only the caret hit area changes an individual tool call. Active-tool changes reject names that Pi did not advertise.

### Mouse and keyboard

The deck receives first-class component-local mouse events from Pi TUI. It does not parse SGR mouse sequences itself.

- One left-button press/release on the same control activates it.
- Movement between press and release cancels activation.
- Mouse wheel scrolls the Tools list.
- Right-click is not consumed, leaving Herdr’s right-click behavior available.
- `Tab` and `Shift+Tab` move focus; `Enter` or `Space` activates the focused control.
- `1` and `2`, or Left/Right, select Overview and Tools.
- Arrow keys move through dropdowns and scroll tool rows.
- `Esc` closes a dropdown or leaves message editing.

While disconnected, all Pi-mutating controls are visibly disabled. Commands are never retained for later delivery. Reconnection uses bounded exponential backoff; when the retry limit is reached, the deck remains disconnected until reopened.

## Transport and protocol

The transport is newline-delimited JSON over a same-user Unix-domain socket. Protocol version is `1`; the maximum line size is 1 MiB. Every frame is checked by a runtime validator.

The server sends `hello` with sequence 1, then an initial `state` snapshot. State sequence numbers increase strictly per connection. Clients discard stale state frames.

Commands:

```text
abort
compact
sendUserMessage
setThinkingLevel
setModel
setActiveTools
setToolExpanded
setToolGroupExpanded
refreshState
```

Command results use the same request ID and return either a value or a structured `{ code, message }` error. Malformed and oversized input is rejected without terminating the bridge.

The state whitelist includes a session ID when available, the Herdr pane ID, idle/working state, queued-message presence, model choices/current model, thinking choices/current level, context usage, active/available tools, per-tool expansion state, turn index, and a generic last error. It does not serialize the session-file path or working directory. It never serializes credentials, environment variables, prompt text, tool output, or file contents.

Only one controlling deck may attach to a Pi pane. A second client is explicitly rejected. The bridge rate-limits state pushes to avoid render storms.

## Herdr interaction boundary

The deck reads `HERDR_BIN_PATH` and launches Herdr with argv arrays and `shell: false`. It reads the installed schema with:

```bash
herdr api schema --json
```

Version one uses only schema-confirmed CLI wrappers to list agents and focus the target Pi agent. It does not resize unrelated panes, switch workspaces, launch agents, or use undocumented Herdr socket methods.

## Security model

This is a control UI, **not a sandbox or permission boundary**. The Pi extension runs with the same account and authority as Pi. The filesystem permissions restrict the local socket to its owner, but a process already running as that user may act with that user’s permissions.

The bridge has no TCP listener, no arbitrary command name, no arbitrary shell execution, no terminal keystroke injection, and no shell interpolation. Existing socket paths are removed only after a connection probe confirms that no server is listening. Non-socket paths are never removed.

## Uninstall

Remove the Pi package using the same local source string used for installation:

```bash
pi remove "$(pwd)"
```

For a project-local installation:

```bash
pi remove -l "$(pwd)"
```

Unlink the Herdr plugin:

```bash
herdr plugin unlink pi.herdr.deck
```

Close any still-visible managed deck pane before unlinking when necessary:

```bash
herdr plugin pane close replace-with-the-deck-pane-id
```

Build artifacts and local dependencies can then be removed:

```bash
rm -rf dist node_modules
```

## Troubleshooting

### `HERDR_PANE_ID` is unavailable

Pi was started outside a Herdr-owned pane. The extension intentionally stays loaded but does not create a socket. Start Pi inside a Herdr pane, then run `/herdr-deck-status` again. Opening the standalone deck does not retrofit `HERDR_PANE_ID` into an already-running external Pi process.

### Incompatible Pi API

The shared compatibility sentence means at least one mandatory surface is absent: component mouse events, per-tool expansion snapshot, current-turn/session bulk expansion, or expansion-change subscription. A single global “tools expanded” boolean is insufficient.

The expansion adapter accepts either a `ctx.ui.toolExpansion` capability object (`getStates`/`getSnapshot`, `setToolExpanded`, `setGroupExpanded`, `subscribe`) or the corresponding flat methods exposed directly by `ctx.ui`. Upgrade to a Pi build that supplies all four capabilities; the bridge does not emulate them by injecting terminal input.

### Socket permission or ownership errors

Check ownership and modes with the `stat` command in **Verify the connection**. The runtime directory must be owned by the current UID and must not be a symlink. Correct an accidentally permissive directory with:

```bash
chmod 700 "${XDG_RUNTIME_DIR:-/tmp}/pi-herdr-deck-$(id -u)"
```

Do not manually delete a socket while Pi is running. On startup, the extension probes an existing socket and removes it only when no listener responds. If a regular file occupies the expected socket path, startup fails rather than deleting it.

### More than one Pi pane exists

Pass `--target-pane` when opening the managed pane. If context remains ambiguous, select the intended live Pi agent in the deck picker. The picker is deliberate; there is no first-agent fallback.

### Installed Herdr schema is missing a method

Run:

```bash
herdr api schema --json > /tmp/herdr-api.schema.json
```

The deck requires `agent.list` and `agent.focus`. Upgrade Herdr when either method or the schema command is absent. The manifest minimum remains 0.7.2 because that is the earliest release with the required schema bootstrap, not because it happened to be installed during development.

## Tests

`npm run validate` runs, in order:

1. strict TypeScript typecheck;
2. production build;
3. unit tests;
4. fake Pi bridge/fake Herdr CLI integration test with no model key;
5. npm package smoke test.

Coverage includes protocol encoding/decoding, malformed and oversized frames, socket paths/modes, stale recovery, hello/state sequencing, stale-state rejection, every command and invalid state, model/tool validation, reconnect/no-queue behavior, duplicate clients, target resolution, first-class mouse and keyboard activation, disabled controls, state secret whitelisting, extension reload/session-shutdown cleanup, compatibility rejection, schema drift, and package contents.

## Non-goals

Version one does not implement a file browser, change review, session switching, sub-agent spawning, arbitrary shell execution, transcript mirroring, or raw terminal keystroke control.
