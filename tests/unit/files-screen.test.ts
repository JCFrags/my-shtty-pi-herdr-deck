import assert from "node:assert/strict";
import test from "node:test";
import {
  filesLayout,
  handleFilesKey,
  handleFilesMouse,
  normalizeFilesPresentation,
  renderFilesScreen,
} from "../../src/deck/files-screen.js";
import type { FilesScreenState } from "../../src/deck/screen-types.js";

for (const width of [50, 70])
  test(`Files uses narrow tabs at ${width} columns`, () => {
    assert.equal(filesLayout(width).narrow, true);
  });
for (const width of [80, 100, 120])
  test(`Files uses a 38/62 wide layout at ${width} columns`, () => {
    const layout = filesLayout(width);
    assert.equal(layout.narrow, false);
    assert.equal(
      layout.treeWidth + layout.previewWidth + layout.separatorWidth,
      width,
    );
    assert.ok(Math.abs(layout.treeWidth / (width - 1) - 0.38) < 0.03);
  });

test("Files normalization exposes additive state and sanitizes terminal and bidi controls", () => {
  const model = normalizeFilesPresentation({
    available: true,
    summary: {
      cwd: "/repo\u001b[31m",
      currentPath: "src",
      selectedCount: 2,
      showHidden: true,
      selectedKnownBytes: 40,
      selectedApproximateTokens: 10,
      limits: {},
    },
    view: {
      currentPath: "src",
      filter: "main",
      showHidden: true,
      previewPath: "src/main.ts",
      rows: [
        {
          path: "src/main.ts",
          name: "main\u202e.ts",
          kind: "file",
          depth: 1,
          selected: true,
          partiallySelected: false,
          expanded: false,
        },
      ],
      preview: {
        metadata: { encoding: "utf-8" },
        lines: ["safe\u001b[2Jline"],
      },
    },
  });
  assert.equal(model.showHidden, true);
  assert.equal(model.selectedApproximateTokens, 10);
  assert.equal(model.filter, "main");
  assert.equal(model.preview?.path, "src/main.ts");
  assert.doesNotMatch(
    model.cwd + model.rows[0]?.name + model.preview?.lines[0],
    /\u001b|\u202e/u,
  );
});

test("Files preserves raw action paths while using safe display and row geometry keys", () => {
  const rawPath = "src/a\u001b[31m.ts";
  const model = normalizeFilesPresentation({
    available: true,
    summary: {},
    view: { rows: [{ path: rawPath, name: "a\u001b[31m.ts", kind: "file" }] },
  });
  const row = model.rows[0];
  if (!row) throw new Error("expected normalized row");
  assert.equal(row.actionPath, rawPath);
  assert.doesNotMatch(row.displayPath, /\u001b/u);
  assert.doesNotMatch(row.rowKey, /\u001b|\s/u);
});

test("Files renders translated pane hitboxes, narrow tabs, and one action bar", () => {
  const presentation = normalizeFilesPresentation({
    available: true,
    summary: { selectedCount: 1 },
    view: {
      filter: "provider",
      showHidden: false,
      rows: [{ path: "a.txt", name: "a.txt", kind: "file", selected: true }],
      preview: { actionPath: "a.txt", metadata: { bytes: 3 }, lines: ["abc"] },
    },
  });
  const state: FilesScreenState = {
    activePane: "tree",
    treeScroll: 0,
    previewScroll: 0,
    focusTarget: "tree",
    wheelDetached: false,
    focusedPath: "a.txt",
  };
  const actions: unknown[] = [];
  const options = {
    presentation,
    state,
    onAction: (action: unknown) => actions.push(action),
  };
  const wide = renderFilesScreen(options, 80, 20);
  assert.equal(wide.layout.narrow, false);
  assert.deepEqual(
    wide.regions.map((region) => region.id),
    ["files:tree-region", "files:preview-region"],
  );
  assert.ok(wide.hitBoxes.some((box) => box.id.includes("files-row-")));
  assert.ok(wide.hitBoxes.every((box) => box.x >= 0 && box.y >= 0));
  handleFilesKey(options, "Enter");
  assert.deepEqual(actions[0], { action: "preview", actionPath: "a.txt" });
  const narrow = renderFilesScreen(options, 77, 20);
  assert.equal(narrow.layout.narrow, true);
  assert.ok(narrow.hitBoxes.some((box) => box.id === "files:tab-preview"));
  const mouse = {
    button: "left" as const,
    x: 10,
    y: 2,
    shift: false,
    alt: false,
    ctrl: false,
  };
  assert.ok(handleFilesMouse(options, narrow, { ...mouse, type: "press" }));
  assert.ok(handleFilesMouse(options, narrow, { ...mouse, type: "release" }));
});
