import type { ProviderProjection } from "../../src/shared/provider-projections.js";

/** Static provider payloads accepted by the Signals and Files projection contracts. */
export const approvedSignalsProjection: ProviderProjection["agentBoard"] = {
  available: true,
  openCount: 1,
  items: [{ id: "signal-question-1", title: "Approve release", state: "open" }],
  pendingQuestions: [
    {
      questionId: "signal-question-1",
      revision: 4,
      question: "Approve release?",
      response: {
        kind: "single_or_text",
        options: [
          { id: "approve", label: "Approve" },
          {
            id: "hold",
            label: "Hold",
            description: "Keep the release pending.",
          },
        ],
      },
      recommendedOptionIds: ["approve"],
    },
  ],
  view: {
    view: {
      tabCounts: { inbox: 1, updates: 1, decisions: 0, history: 1 },
      tabs: {
        inbox: {
          rows: [
            {
              id: "signal-question-1",
              title: "Approve release",
              revision: 4,
              userAnswerable: true,
              dismissible: true,
            },
          ],
        },
        updates: {
          rows: [
            {
              id: "signal-update-1",
              title: "Release is ready",
              state: "active",
              revision: 2,
              detail: "All focused checks passed.",
              archivable: true,
              retryableDelivery: true,
              changedAt: "2026-08-23T12:00:00.000Z",
            },
          ],
        },
        decisions: { rows: [] },
        history: {
          rows: [
            {
              id: "signal-update-1",
              title: "Release was prepared",
              state: "completed",
              revision: 3,
              terminalAt: "2026-08-23T12:01:00.000Z",
            },
          ],
        },
      },
    },
  },
};

export const approvedFilesProjection: NonNullable<ProviderProjection["files"]> =
  {
    available: true,
    capability: { standalone: true, actions: ["preview", "refresh"] },
    summary: {
      cwd: "/repo",
      currentPath: ".",
      selectedCount: 1,
      selectedKnownBytes: 24,
      selectedApproximateTokens: 6,
      limits: { maxPreviewLines: 5000 },
    },
    view: {
      currentPath: ".",
      filter: "",
      showHidden: false,
      rows: [
        {
          path: "src",
          name: "src",
          kind: "directory",
          depth: 0,
          expanded: true,
        },
        {
          path: "src/index.ts",
          name: "index.ts",
          kind: "file",
          depth: 1,
          selected: true,
        },
      ],
      preview: {
        actionPath: "src/index.ts",
        metadata: { encoding: "utf-8", lines: 1 },
        lines: ["export const ready = true;"],
      },
    },
  };

export const approvedProviderProjection = (): ProviderProjection => ({
  ownerAgentId: "owner",
  piSessionId: "session-1",
  todo: { available: true, total: 0, completed: 0, items: [] },
  agentBoard: structuredClone(approvedSignalsProjection),
  files: structuredClone(approvedFilesProjection),
});
