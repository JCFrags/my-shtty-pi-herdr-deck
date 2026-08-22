# Provider actions

The deck uses the provider-owned event contracts without duplicating provider state.

- Todo requests use `pi-todo:request-action-v1` and responses use `pi-todo:action-response-v1`.
  Actions are `start`, `done`, and `clear_wait`. Each request carries a bounded request ID and task ID.
- Agent Board requests use `pi-agent-board:action-request-v1` and responses use `pi-agent-board:action-response-v1`.
  The deck can open the provider UI or answer one exact pending question with its revision.

The broker action layer keeps controls disabled while a request is pending. A successful response is followed by a provider summary refresh. Provider summaries remain authoritative. Unavailable providers show an explicit health label instead of an enabled control.
