import assert from "node:assert/strict";
import test from "node:test";
import {
  filesLayout,
  normalizeFilesPresentation,
} from "../../src/deck/files-screen.js";

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
