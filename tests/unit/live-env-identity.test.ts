import assert from "node:assert/strict";
import test from "node:test";
import { HerdrService } from "../../src/herdr/service.js";
import { normalizeSnapshot } from "../../src/herdr/normalizers.js";
import type { HerdrSnapshot } from "../../src/herdr/types.js";

const reference = {
  source: "herdr:pi",
  agent: "pi",
  kind: "path",
  value: "/home/test/.pi/sessions/exact.jsonl",
} as const;

function officialSnapshot(
  worktree: unknown = {
    repo_key: "repo-key",
    repo_name: "repo",
    repo_root: "/repo",
    checkout_path: "/checkout",
    is_linked_worktree: true,
  },
): HerdrSnapshot {
  return normalizeSnapshot({
    result: {
      snapshot: {
        version: "0.8.0",
        protocol: 19,
        workspaces: [
          {
            workspace_id: "w1",
            ...(worktree === undefined ? {} : { worktree }),
          },
        ],
        tabs: [
          {
            tab_id: "tab1",
            workspace_id: "w1",
            cwd: "/work",
          },
        ],
        panes: [
          {
            pane_id: "p1",
            terminal_id: "term1",
            workspace_id: "w1",
            tab_id: "tab1",
            cwd: "/work",
            agent: "pi",
          },
        ],
        layouts: [],
        agents: [
          {
            terminal_id: "term1",
            pane_id: "p1",
            workspace_id: "w1",
            tab_id: "tab1",
            agent: "pi",
            agent_session: reference,
          },
        ],
      },
    },
  });
}

function service(snapshot: HerdrSnapshot): HerdrService {
  return new HerdrService({
    store: {} as never,
    provisioner: {} as never,
    cli: {
      requireMutationCapabilities: () => undefined,
      snapshot: async () => snapshot,
    } as never,
  });
}

test("official Pi identity derives the terminal and binds the exact path session reference", async () => {
  assert.deepEqual(
    await service(officialSnapshot()).verifyRoot({
      paneId: "p1",
      sessionReference: reference,
    }),
    {
      paneId: "p1",
      terminalId: "term1",
      workspaceId: "w1",
      tabId: "tab1",
      cwd: "/checkout",
    },
  );
});

test("official Pi identity accepts a missing optional workspace worktree", async () => {
  const result = await service(officialSnapshot(null)).verifyRoot({
    paneId: "p1",
    sessionReference: reference,
  });
  assert.equal(result.cwd, "/work");
  assert.equal(result.worktreeId, undefined);
});

test("official Pi identity rejects malformed workspace worktree metadata", async () => {
  await assert.rejects(
    () =>
      service(
        officialSnapshot({
          repo_key: "repo-key",
          repo_name: "repo",
          repo_root: "/repo",
          checkout_path: "relative-checkout",
          is_linked_worktree: true,
        }),
      ).verifyRoot({ paneId: "p1", sessionReference: reference }),
    /HERDR_IDENTITY_MISMATCH/,
  );
});

test("official Pi identity rejects every changed session reference field", async () => {
  for (const patch of [
    { source: "other" },
    { agent: "other" },
    { kind: "id" },
    { value: "/home/test/.pi/sessions/replaced.jsonl" },
  ])
    await assert.rejects(
      () =>
        service(officialSnapshot()).verifyRoot({
          paneId: "p1",
          sessionReference: { ...reference, ...patch },
        }),
      /HERDR_IDENTITY_MISMATCH/,
    );
});

test("official Pi identity rejects global duplicate terminals and stale old panes", async () => {
  const duplicatePane = officialSnapshot();
  duplicatePane.panes.push({
    id: "p2",
    terminalId: "term1",
    workspaceId: "w1",
    tabId: "tab1",
  });
  await assert.rejects(
    () =>
      service(duplicatePane).verifyRoot({
        paneId: "p1",
        sessionReference: reference,
      }),
    /HERDR_IDENTITY_MISMATCH/,
  );

  const staleOldPane = officialSnapshot();
  staleOldPane.agents = [
    staleOldPane.agents[0]!,
    {
      ...staleOldPane.agents[0]!,
      agentId: "a2",
      paneId: "p2",
    },
  ];
  await assert.rejects(
    () =>
      service(staleOldPane).verifyRoot({
        paneId: "p1",
        sessionReference: reference,
      }),
    /HERDR_IDENTITY_MISMATCH/,
  );
});

test("official Pi identity rejects pane and session-reference ambiguity in either order", async () => {
  for (const duplicate of [
    {
      ...officialSnapshot().agents[0]!,
      terminalId: "other-terminal",
    },
    {
      ...officialSnapshot().agents[0]!,
      paneId: "other-pane",
      terminalId: "other-terminal",
    },
  ])
    for (const reverse of [false, true]) {
      const snapshot = officialSnapshot();
      snapshot.agents = reverse
        ? [duplicate, snapshot.agents[0]!]
        : [snapshot.agents[0]!, duplicate];
      await assert.rejects(
        () =>
          service(snapshot).verifyRoot({
            paneId: "p1",
            sessionReference: reference,
          }),
        /HERDR_IDENTITY_MISMATCH/,
      );
    }
});

test("official Pi identity rejects missing or mismatched required workspace and tab fields", async () => {
  for (const mutate of [
    (snapshot: HerdrSnapshot) => {
      const { workspaceId: _workspaceId, ...agent } = snapshot.agents[0]!;
      snapshot.agents = [agent];
    },
    (snapshot: HerdrSnapshot) => {
      const { tabId: _tabId, ...agent } = snapshot.agents[0]!;
      snapshot.agents = [agent];
    },
    (snapshot: HerdrSnapshot) => {
      snapshot.agents[0]!.workspaceId = "other";
    },
    (snapshot: HerdrSnapshot) => {
      snapshot.agents[0]!.tabId = "other";
    },
    (snapshot: HerdrSnapshot) => {
      snapshot.workspaces = [];
    },
    (snapshot: HerdrSnapshot) => {
      snapshot.tabs = [];
    },
    (snapshot: HerdrSnapshot) => {
      snapshot.tabs[0]!.workspaceId = "other-workspace";
    },
  ]) {
    const snapshot = officialSnapshot();
    mutate(snapshot);
    await assert.rejects(
      () =>
        service(snapshot).verifyRoot({
          paneId: "p1",
          sessionReference: reference,
        }),
      /HERDR_IDENTITY_MISMATCH/,
    );
  }
});

test("an expected session reference rejects absence in official and legacy snapshots", async () => {
  const official = officialSnapshot();
  const { sessionReference: _reference, ...agent } = official.agents[0]!;
  official.agents = [agent];
  await assert.rejects(
    () =>
      service(official).verifyRoot({
        paneId: "p1",
        sessionReference: reference,
      }),
    /HERDR_IDENTITY_MISMATCH/,
  );
  const legacy = officialSnapshot(undefined);
  legacy.agents = [];
  legacy.panes[0]!.occupant = { kind: "pi", terminalId: "term1" };
  await assert.rejects(
    () =>
      service(legacy).verifyRoot({ paneId: "p1", sessionReference: reference }),
    /HERDR_IDENTITY_MISMATCH/,
  );
});

test("official agents cannot be masked by a nested legacy occupant", async () => {
  const malformed = officialSnapshot();
  const { terminalId: _terminalId, ...withoutTerminal } = malformed.agents[0]!;
  malformed.agents = [withoutTerminal];
  await assert.rejects(
    () =>
      service(malformed).verifyRoot({
        paneId: "p1",
        sessionReference: reference,
      }),
    /HERDR_IDENTITY_MISMATCH/,
  );
});

test("official Pi identity rejects duplicate workspace and tab context", async () => {
  for (const mutate of [
    (snapshot: HerdrSnapshot) =>
      snapshot.workspaces.push({ id: "w1", tabs: [] }),
    (snapshot: HerdrSnapshot) => snapshot.tabs.push({ id: "tab1", panes: [] }),
  ]) {
    const snapshot = officialSnapshot();
    mutate(snapshot);
    await assert.rejects(
      () =>
        service(snapshot).verifyRoot({
          paneId: "p1",
          sessionReference: reference,
        }),
      /HERDR_IDENTITY_MISMATCH/,
    );
  }
});
