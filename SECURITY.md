# Security

`pi-herdr-deck` is a control UI. It is not a sandbox or an authentication boundary.

## Trust boundary

The Pi extension and bridge run with the same Unix account as Pi. The bridge uses a Unix-domain socket in an owner-only runtime directory. The socket mode is `0600`. Any process that already runs as the same UID can connect and control the Pi session. The socket does not identify the intended deck process.

Treat all local same-UID processes as trusted with the full impact of this UI. A connected client can send messages, steer or follow up a working turn, abort, compact, change the model, change active tools, and expand or collapse tool calls. The state and command checks reduce accidental misuse. They do not provide authorization.

## Data disclosure

The bridge sends a limited state whitelist. It does not send prompts, tool output, file contents, environment variables, credentials, or session-file paths. It does not send the Pi working directory. Pane identifiers, model and tool names, activity, and bounded error status can be visible to a same-UID client.

Herdr failures are returned as generic messages. Herdr is started with argv arrays, `shell: false`, a bounded output limit, a timeout, and a reduced environment. Only schema-confirmed `agent.list` and `agent.focus` wrappers are used.

## Reporting

Do not include credentials, private session data, or command output in a report. Report a reproducible security issue to the repository owner through the repository's private security channel before public disclosure.
