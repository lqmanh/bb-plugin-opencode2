// Request and event shapes verified against a live OpenCode v2.0.27 service.
import assert from "node:assert/strict";
import test from "node:test";
import {
  agentOptionChoice,
  answerFormFields,
  dynamicToolRow,
  forkBoundaryRetainingThrough,
  agentSessionOption,
  mapModel,
  metadataFileChanges,
  modelCatalogEntry,
  nativeSkillRoots,
  permissionReplyBody,
  planAgentTransition,
  planFormQuestions,
  planPermissionModeForTurn,
  promptBody,
  resolveModelVariant,
  selectedCommandMention,
  sessionPermissionRules,
  shellExitCode,
  withoutCommandMention,
  workspacePath,
} from "../../support/host-api.js";

test("accept-edits asks for everything except reads, searches, and edits", () => {
  const rules = sessionPermissionRules({
    permissionMode: "accept-edits",
    disableSubagents: false,
  });
  assert.deepEqual(rules[0], { action: "*", resource: "*", effect: "ask" });
  const effect = (action: string, resource = "*") =>
    // OpenCode evaluates rules in order and the last match wins.
    rules
      .filter(
        (rule) =>
          (rule.action === "*" || rule.action === action) &&
          (rule.resource === "*" || rule.resource === resource),
      )
      .at(-1)?.effect;
  assert.equal(effect("shell"), "ask");
  assert.equal(effect("webfetch"), "ask");
  assert.equal(effect("edit"), "allow");
  assert.equal(effect("read"), "allow");
  assert.equal(effect("read", "*.env"), "ask");
});

test("full mode allows everything and auto keeps OpenCode's agent rules", () => {
  assert.deepEqual(
    sessionPermissionRules({
      permissionMode: "full",
      disableSubagents: false,
    })[0],
    { action: "*", resource: "*", effect: "allow" },
  );
  assert.deepEqual(
    sessionPermissionRules({ permissionMode: "auto", disableSubagents: false }),
    [{ action: "bb_opencode2_*", resource: "*", effect: "deny" }],
  );
});

test("plan mode keeps file edits denied under every permission mode", () => {
  for (const permissionMode of ["accept-edits", "auto", "full"]) {
    const rules = sessionPermissionRules({
      permissionMode,
      disableSubagents: false,
      planMode: true,
    });
    for (const action of ["edit", "write", "patch"]) {
      const effect = rules
        .filter(
          (rule) =>
            (rule.action === "*" || rule.action === action) &&
            rule.resource === "*",
        )
        .at(-1)?.effect;
      assert.equal(effect, "deny", `${permissionMode} ${action}`);
    }
  }
});

test("each session sees only its own BB tool server, and subagents are denied", () => {
  const rules = sessionPermissionRules({
    permissionMode: "accept-edits",
    disableSubagents: true,
    dynamicToolServer: "bb_opencode2_abc",
    dynamicToolNames: ["bb_echo"],
  });
  assert.deepEqual(rules.slice(-4), [
    { action: "bb_opencode2_*", resource: "*", effect: "deny" },
    { action: "bb_opencode2_abc_*", resource: "*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "task", resource: "*", effect: "deny" },
  ]);
  // Without BB tools, other threads' servers are still hidden.
  assert.deepEqual(
    sessionPermissionRules({ permissionMode: "full", disableSubagents: false }),
    [
      { action: "*", resource: "*", effect: "allow" },
      { action: "bb_opencode2_*", resource: "*", effect: "deny" },
    ],
  );
});

test("permission replies send `decision`, with a message when rejecting", () => {
  assert.deepEqual(permissionReplyBody("once"), { decision: "once" });
  assert.deepEqual(permissionReplyBody("always"), { decision: "always" });
  const reject = permissionReplyBody("reject");
  assert.equal(reject.decision, "reject");
  assert.match(reject.message ?? "", /denied/);
});

test("fork bodies use `before`, never the stripped `boundary` key", () => {
  const messages = [
    { id: "msg_u1", type: "user" },
    { id: "msg_a1", type: "assistant" },
    { id: "msg_u2", type: "user" },
  ];
  assert.deepEqual(forkBoundaryRetainingThrough(messages, "msg_u1"), {
    before: "msg_u2",
  });
  assert.deepEqual(forkBoundaryRetainingThrough(messages, "msg_u2"), {});
});

const model = (variants: string[], context?: number) => ({
  providerID: "opencode",
  id: "test-model",
  name: "Test Model",
  variants: variants.map((id) => ({ id })),
  ...(context ? { limit: { context } } : {}),
});

test("maps OpenCode variants to BB reasoning levels, including aliases", () => {
  const entry = modelCatalogEntry(
    model(["thinking", "minimal", "none", "max"], 200_000),
  );
  assert.deepEqual(
    [...entry.variants],
    [
      ["none", "none"],
      ["low", "minimal"],
      ["high", "thinking"],
      ["max", "max"],
    ],
  );
  assert.equal(entry.contextWindow, 200_000);
  // A native level wins over an alias.
  assert.equal(
    modelCatalogEntry(model(["low", "minimal"])).variants.get("low"),
    "low",
  );
});

test("never sends a variant the model does not have", () => {
  const withVariants = modelCatalogEntry(model(["minimal", "high"]));
  const ref = { providerID: "opencode", id: "test-model" };
  assert.deepEqual(
    resolveModelVariant({ ...ref, variant: "low" }, withVariants),
    { ...ref, variant: "minimal" },
  );
  assert.deepEqual(
    resolveModelVariant({ ...ref, variant: "medium" }, withVariants),
    ref,
  );
  assert.deepEqual(
    resolveModelVariant(
      { ...ref, variant: "medium" },
      modelCatalogEntry(model([])),
    ),
    ref,
  );
});

test("defaults to medium effort and marks only the chosen default model", () => {
  const mapped = mapModel(model(["none", "low", "medium", "high"]), true);
  assert.equal(mapped.defaultReasoningEffort, "medium");
  assert.equal(mapped.isDefault, true);
  assert.equal(mapModel(model([]), false).isDefault, false);
  assert.deepEqual(mapModel(model([]), false).supportedReasoningEfforts, [
    { reasoningEffort: "medium", description: "Default" },
  ]);
});

test("reads shell exit codes from v2 tool metadata or content", () => {
  assert.equal(
    shellExitCode({ metadata: { status: "completed", exit: 3 } }),
    3,
  );
  assert.equal(
    shellExitCode({
      content: [
        { type: "text", text: "tick\n" },
        { type: "text", text: "Exited with code 2" },
      ],
    }),
    2,
  );
  assert.equal(shellExitCode({ metadata: { status: "completed" } }), undefined);
});

test("builds file-change rows from OpenCode's edit metadata patches", () => {
  assert.deepEqual(
    metadataFileChanges(
      {
        files: [
          {
            file: "src/a.ts",
            patch: "@@ -1 +1 @@\n-a\n+b\n",
            status: "modified",
          },
          { file: "new.ts", status: "added" },
          { file: "old.ts", status: "deleted" },
          { status: "modified" },
        ],
      },
      "/repo",
    ),
    [
      { path: "src/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b\n" },
      { path: "new.ts", kind: "add" },
      { path: "old.ts", kind: "delete" },
    ],
  );
  assert.deepEqual(metadataFileChanges({ truncated: false }, "/repo"), []);
  assert.deepEqual(
    metadataFileChanges(
      {
        files: [
          {
            file: "/repo/a.ts",
            patch: "--- /repo/a.ts\n+++ /repo/a.ts\n",
            status: "modified",
          },
        ],
      },
      "/repo",
    ),
    [{ path: "a.ts", kind: "update", diff: "--- a.ts\n+++ a.ts\n" }],
  );
});

test("reports touched files relative to the workspace", () => {
  assert.equal(workspacePath("/repo", "/repo/src/a.ts"), "src/a.ts");
  assert.equal(workspacePath("/repo", "src/a.ts"), "src/a.ts");
  assert.equal(workspacePath("/repo", "/elsewhere/b.ts"), "/elsewhere/b.ts");
});

test("renders BB dynamic tool calls as the BB tool", () => {
  const presentation = {
    icon: { glyph: "Globe" },
    label: { pending: "Opening page", completed: "Opened page" },
  };
  const tools = [
    {
      name: "browser_open",
      description: "Open a page",
      inputSchema: {},
      presentation,
    },
    { name: "bb_echo", description: "Echo", inputSchema: {} },
  ];
  const row = dynamicToolRow(
    "bb_opencode2_abc",
    tools,
    "bb_opencode2_abc_browser_open",
    {
      url: "https://example.com",
    },
  );
  assert.equal(row?.item.tool, "browser_open");
  assert.deepEqual(row?.presentation, presentation);
  const echo = dynamicToolRow(
    "bb_opencode2_abc",
    tools,
    "bb_opencode2_abc_bb_echo",
    { text: "ping" },
  );
  assert.equal(echo?.item.tool, "bb_echo");
  assert.equal(echo?.presentation.title, "ping");
  assert.equal(
    dynamicToolRow("bb_opencode2_abc", tools, "shell", {}),
    undefined,
  );
});

test("derives BB skill roots from the skills OpenCode discovered", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const base = mkdtempSync(join(tmpdir(), "oc-skills-"));
  const home = join(base, "home", ".agents", "skills");
  const repo = join(base, "repo");
  const project = join(repo, ".opencode", "skills");
  for (const dir of [
    join(home, "unslop"),
    join(home, "grill-me"),
    join(project, "local"),
  ]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: x\n---\n");
  }
  assert.deepEqual(
    nativeSkillRoots(
      [
        { path: "/builtin/opencode.md" },
        { path: join(home, "unslop", "SKILL.md") },
        { path: join(home, "grill-me", "SKILL.md") },
        { path: join(project, "local", "SKILL.md") },
        { path: join(base, "missing", "gone", "SKILL.md") },
        {},
      ],
      repo,
    ),
    [
      { path: home, origin: "user", shape: "skills" },
      { path: project, origin: "project", shape: "skills" },
    ],
  );
});

test("forwards native OpenCode skill mentions, not only BB-configured ones", () => {
  const body = promptBody(
    [
      {
        type: "text",
        text: "/unslop this README",
        mentions: [
          {
            start: 0,
            end: 7,
            resource: {
              kind: "command",
              source: "skill",
              trigger: "/",
              name: "unslop",
            },
          },
        ],
      },
    ],
    {
      configuredSkillNames: new Set(["bb-cli"]),
      nativeSkillNames: new Set(["unslop"]),
    },
  );
  assert.deepEqual(body.skills, [
    { id: "unslop", mention: { start: 0, end: 7, text: "/unslop" } },
  ]);
});

test("offers an agent session option whenever OpenCode has a primary agent", () => {
  assert.equal(agentSessionOption([]), undefined);
  assert.deepEqual(
    agentSessionOption([{ id: "build" }, { id: "plan" }])?.values,
    [
      { id: "build", label: "build" },
      { id: "plan", label: "plan" },
    ],
  );
  assert.deepEqual(
    agentSessionOption([
      { id: "build" },
      { id: "plan" },
      { id: "reviewer", description: "Reviews code" },
    ]),
    {
      type: "select",
      id: "agent",
      label: "Agent",
      description: "OpenCode primary agent",
      value: "build",
      values: [
        { id: "build", label: "build" },
        { id: "plan", label: "plan" },
        { id: "reviewer", label: "reviewer", description: "Reviews code" },
      ],
    },
  );
  assert.equal(
    agentSessionOption([{ id: "build" }, { id: "reviewer" }], "reviewer")
      ?.value,
    "reviewer",
  );
  // A choice that is no longer offered falls back to the default.
  assert.equal(
    agentSessionOption([{ id: "build" }, { id: "reviewer" }], "gone")?.value,
    "build",
  );
  const option = agentSessionOption([{ id: "build" }, { id: "reviewer" }]);
  assert.ok(option);
  assert.deepEqual(
    mapModel({ providerID: "p", id: "m" }, true, [option]).sessionOptions,
    [option],
  );
  assert.equal(
    "sessionOptions" in mapModel({ providerID: "p", id: "m" }, true),
    false,
  );
});

test("routes only currently listed slash commands and keeps other mentions", () => {
  const input = [
    {
      type: "text",
      text: "/review /unslop this change",
      mentions: [
        {
          start: 0,
          end: 7,
          resource: {
            kind: "command",
            source: "command",
            trigger: "/",
            name: "review",
          },
        },
        {
          start: 8,
          end: 15,
          resource: {
            kind: "command",
            source: "skill",
            trigger: "/",
            name: "unslop",
          },
        },
      ],
    },
  ];
  assert.deepEqual(selectedCommandMention(input, new Set(["review"])), {
    name: "review",
  });
  assert.equal(selectedCommandMention(input, new Set(["init"])), undefined);
  assert.deepEqual(withoutCommandMention(input, "review"), [
    {
      type: "text",
      text: "/unslop this change",
      mentions: [
        {
          start: 0,
          end: 7,
          resource: {
            kind: "command",
            source: "skill",
            trigger: "/",
            name: "unslop",
          },
        },
      ],
    },
  ]);
});

test("plans general forms only when BB can represent their schema", () => {
  const plan = planFormQuestions({
    fields: [
      { key: "name", title: "Name", type: "string", required: true },
      { key: "count", title: "Count", type: "integer", minimum: 1 },
      {
        key: "tags",
        title: "Tags",
        type: "multiselect",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
        custom: true,
      },
      { key: "active", title: "Active", type: "boolean" },
      { key: "mode", type: "string", default: "fast", hidden: true },
    ],
  });
  assert.ok(!("error" in plan));
  assert.equal(plan.questions.length, 4);
  assert.deepEqual(plan.hiddenAnswers, { mode: "fast" });
  assert.deepEqual(plan.questions[3], {
    id: "active",
    prompt: "Active",
    shortLabel: "Active",
    multiSelect: false,
    allowFreeText: true,
    options: [
      { value: "true", label: "Yes" },
      { value: "false", label: "No" },
    ],
  });

  for (const fields of [
    [{ key: "a", type: "external", url: "https://example.com" }],
    [{ key: "a", type: "string", when: [{ key: "b", op: "eq", value: 1 }] }],
    [
      ...Array.from({ length: 11 }, (_, index) => ({
        key: `q${index}`,
        type: "string",
      })),
    ],
    [
      {
        key: "a",
        type: "string",
        options: ["1", "2", "3", "4", "5"].map((value) => ({
          value,
          label: value,
        })),
      },
    ],
    [{ key: "a", type: "string", hidden: true }],
  ]) {
    assert.ok("error" in planFormQuestions({ fields }));
  }

  const select = planFormQuestions({
    fields: [
      {
        key: "mode",
        type: "string",
        options: [
          { value: "fast", label: "Fast" },
          { value: "slow", label: "Slow" },
        ],
      },
    ],
  });
  assert.ok(!("error" in select));
  assert.equal(select.questions[0].allowFreeText, false);
});

test("maps general form answers onto the field types", () => {
  const plan = planFormQuestions({
    fields: [
      { key: "name", title: "Name", type: "string", required: true },
      { key: "count", title: "Count", type: "integer", minimum: 1 },
      { key: "active", title: "Active", type: "boolean" },
      {
        key: "tags",
        title: "Tags",
        type: "multiselect",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
        custom: true,
      },
    ],
  });
  assert.ok(!("error" in plan));
  assert.deepEqual(
    answerFormFields(plan.fields, plan.hiddenAnswers, {
      name: { selected: [], freeText: "Ada" },
      count: { selected: [], freeText: "3" },
      active: { selected: ["true"] },
      tags: { selected: ["a"], freeText: "b" },
    }),
    {
      answer: { name: "Ada", count: 3, active: true, tags: ["a", "b"] },
      summary: ["Name: Ada", "Count: 3", "Active: Yes", "Tags: a, b"],
    },
  );
  assert.deepEqual(
    answerFormFields(
      plan.fields,
      {},
      {
        name: { selected: [], freeText: "Ada" },
        count: { selected: [], freeText: "0" },
        active: { selected: ["true"] },
        tags: { selected: ["a"] },
      },
    ),
    { error: '"count" must be at least 1' },
  );
  assert.deepEqual(
    answerFormFields(
      plan.fields,
      {},
      {
        count: { selected: [], freeText: "3" },
        active: { selected: ["true"] },
        tags: { selected: ["a"] },
      },
    ),
    { error: 'The user left required field "name" unanswered' },
  );
});

test("rejects answers that violate a form field's format", () => {
  const fields = [
    { key: "email", type: "string", format: "email" },
    { key: "site", type: "string", format: "uri" },
    { key: "day", type: "string", format: "date" },
    { key: "at", type: "string", format: "date-time" },
  ];
  for (const [key, value, error] of [
    ["email", "nope", '"email" must be an email address'],
    ["site", "not a url", '"site" must be a URL'],
    ["day", "2024-02-30", '"day" must be a date (YYYY-MM-DD)'],
    ["at", "not a date", '"at" must be a date and time'],
  ] as const) {
    assert.deepEqual(
      answerFormFields(
        fields,
        {},
        { [key]: { selected: [], freeText: value } },
      ),
      { error },
    );
  }
  assert.deepEqual(
    answerFormFields(
      fields,
      {},
      {
        email: { selected: [], freeText: "ada@example.com" },
        site: { selected: [], freeText: "https://example.com" },
        day: { selected: [], freeText: "2024-02-29" },
        at: { selected: [], freeText: "2024-02-29T10:00:00Z" },
      },
    ),
    {
      answer: {
        email: "ada@example.com",
        site: "https://example.com",
        day: "2024-02-29",
        at: "2024-02-29T10:00:00Z",
      },
      summary: [
        "email: ada@example.com",
        "site: https://example.com",
        "day: 2024-02-29",
        "at: 2024-02-29T10:00:00Z",
      ],
    },
  );
});

test("keeps plan-mode edit denies when a plan turn is steered", () => {
  // The plan turn's own message sets the flag.
  assert.equal(planPermissionModeForTurn(true, true, undefined), true);
  // A steer joins the running plan turn and must keep the denies.
  assert.equal(planPermissionModeForTurn(false, false, true), true);
  // A new ordinary turn leaves plan mode.
  assert.equal(planPermissionModeForTurn(false, true, true), false);
  // A steer outside plan mode stays ordinary.
  assert.equal(planPermissionModeForTurn(false, false, undefined), false);
});

test("maps BB plan mode onto the plan agent for one turn", () => {
  const session = {
    agent: "build" as string | undefined,
    agentChoice: undefined as string | undefined,
    planMode: undefined as boolean | undefined,
    agentBeforePlan: undefined as string | undefined,
  };
  assert.equal(planAgentTransition(session, true, true), "plan");
  assert.equal(session.planMode, true);
  assert.equal(session.agentBeforePlan, "build");

  // A steer during the plan turn does not switch back.
  assert.equal(planAgentTransition(session, false, false), undefined);
  assert.equal(session.planMode, true);

  // The next ordinary turn returns to the previous agent.
  assert.equal(planAgentTransition(session, false, true), "build");
  assert.equal(session.planMode, false);
  assert.equal(session.agentBeforePlan, undefined);

  const chosen = {
    agent: "build" as string | undefined,
    agentChoice: "reviewer" as string | undefined,
    planMode: undefined as boolean | undefined,
    agentBeforePlan: undefined as string | undefined,
  };
  assert.equal(planAgentTransition(chosen, true, true), "plan");
  chosen.agent = "plan";
  assert.equal(planAgentTransition(chosen, false, true), "reviewer");

  // A worker restart loses the in-memory plan flag but sees the plan agent.
  const restarted = {
    agent: "plan" as string | undefined,
    agentChoice: undefined as string | undefined,
    planMode: undefined as boolean | undefined,
    agentBeforePlan: undefined as string | undefined,
  };
  assert.equal(planAgentTransition(restarted, false, true), "build");
});

test("shows the agent a plan turn returns to", () => {
  assert.equal(
    agentOptionChoice({
      agent: "build",
      agentChoice: "reviewer",
      planMode: true,
      agentBeforePlan: "build",
    }),
    "reviewer",
  );
  assert.equal(
    agentOptionChoice({
      agent: "build",
      agentChoice: undefined,
      planMode: true,
      agentBeforePlan: "build",
    }),
    "build",
  );
  assert.equal(
    agentOptionChoice({
      agent: "plan",
      agentChoice: "reviewer",
      planMode: false,
    }),
    "reviewer",
  );
  assert.equal(
    agentOptionChoice({
      agent: "build",
      agentChoice: undefined,
      planMode: false,
    }),
    "build",
  );
});
