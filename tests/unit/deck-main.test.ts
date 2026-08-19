import assert from "node:assert/strict";
import test from "node:test";
import {
  DECK_TUI_COMPATIBILITY_MESSAGE,
  hasDeckTuiApi,
} from "../../src/deck/main.js";

test("deck runtime accepts the current alternate-screen Pi TUI API", () => {
  assert.equal(
    hasDeckTuiApi({
      TuiAltScreen: class {},
      ProcessTerminal: class {},
    }),
    true,
  );
});

test("deck runtime rejects the removed legacy TUI constructor", () => {
  assert.equal(
    hasDeckTuiApi({
      TUI: class {},
      ProcessTerminal: class {},
    }),
    false,
  );
  assert.equal(
    DECK_TUI_COMPATIBILITY_MESSAGE,
    "Pi Herdr Deck requires Pi TUI with TuiAltScreen and ProcessTerminal.",
  );
});
