import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalPermissionReply,
  automaticPermissionReply,
  backgroundTaskDescription,
  backgroundTaskItem,
  backgroundTaskKey,
  backgroundTaskTaskType,
  backgroundTaskUsage,
  forkBoundaryRetainingThrough,
  isManualCompactionTurn,
  itemKeyForOpenItem,
  LOCAL_AGENT_TASK_TYPE,
  manualCompactionOutcomeDeltas,
  manualCompactionStartDeltas,
  MAX_TIMELINE_DELTA_BYTES,
  nextMessageIdAfterCheckpoint,
  parseBackgroundCompletion,
  promptBody,
  providerFailureDeltas,
  revertTargetRetainingThrough,
  steerAcceptedDelta,
  timelineDeltasForEmission,
  toolFailureError,
  toolRow,
  touchedPaths,
} from "../../support/host-api.js";

test("bounds multi-megabyte tool input and output before serializing a BB timeline delta", () => {
  const huge = `start-${"x".repeat(4 * 1024 * 1024)}-end`;
  const [delta] = timelineDeltasForEmission([
    {
      kind: "item.close",
      key: { providerItemId: "call_1", channel: "tool" },
      status: "completed",
      resultText: huge,
      item: {
        type: "tool",
        tool: "write",
        args: {
          path: "src/large.ts",
          content: huge,
          ...Object.fromEntries(
            Array.from({ length: 8 }, (_, index) => [`extra_${index}`, huge]),
          ),
        },
        result: huge,
      },
      providerTurnId: "turn_1",
    },
  ]);
  const serialized = JSON.stringify(delta);
  const item = delta.item as { args: { content: string }; result: string };

  assert.ok(Buffer.byteLength(serialized) <= MAX_TIMELINE_DELTA_BYTES);
  assert.match(item.args.content, /\[truncated /);
  assert.match(item.result, /\[truncated /);
  assert.match(item.result, /start-/);
  assert.match(item.result, /-end/);
});

test("keeps channel-qualified keys when unfinished items are closed", () => {
  assert.deepEqual(itemKeyForOpenItem("message_1", { type: "agentMessage" }), {
    providerItemId: "message_1",
    channel: "agentMessage",
  });
  assert.deepEqual(itemKeyForOpenItem("reasoning_1", { type: "reasoning" }), {
    providerItemId: "reasoning_1",
    channel: "reasoningText",
  });
  assert.deepEqual(itemKeyForOpenItem("tool_1", { type: "command" }), {
    providerItemId: "tool_1",
    channel: "tool",
  });
});

test("projects provider failures as a visible error followed by a failed turn boundary", () => {
  assert.deepEqual(
    providerFailureDeltas({
      providerTurnId: "turn_1",
      error: "This model requires 18+ age confirmation.",
      providerCheckpointId: "msg_1",
    }),
    [
      {
        kind: "provider.error",
        message: "This model requires 18+ age confirmation.",
        providerTurnId: "turn_1",
        settlesTurn: true,
      },
      {
        kind: "turn.boundary",
        status: "failed",
        error: { message: "This model requires 18+ age confirmation." },
        providerCheckpointId: "msg_1",
        providerTurnId: "turn_1",
      },
    ],
  );
});

test("maps OpenCode file reads to BB's native read row", () => {
  assert.equal(
    toolRow("read", { filePath: "README.md" }, "/repo").item.type,
    "fileRead",
  );
});

test("maps a read of a directory to BB's native file-list row", () => {
  assert.equal(toolRow("read", { filePath: "." }, "/tmp").item.type, "search");
});

test("maps OpenCode searches and commands to native BB rows", () => {
  assert.equal(
    toolRow("grep", { pattern: "needle" }, "/repo").item.type,
    "search",
  );
  assert.equal(
    toolRow("bash", { command: "pnpm test" }, "/repo").item.type,
    "command",
  );
});

test("extracts touched files from write/edit/patch inputs", () => {
  // OpenCode's write tool uses `path`, and step.ended carries no file list,
  // so the bridge records touches from tool input instead.
  assert.deepEqual(
    touchedPaths("write", { path: "/tmp/a.txt", content: "hi" }),
    ["/tmp/a.txt"],
  );
  assert.deepEqual(touchedPaths("edit", { filePath: "src/b.ts" }), [
    "src/b.ts",
  ]);
  assert.deepEqual(
    touchedPaths("apply_patch", {
      patchText: "*** Update File: src/a.ts\n*** Add File: src/b.ts\n",
    }),
    ["src/a.ts", "src/b.ts"],
  );
  assert.deepEqual(touchedPaths("read", { filePath: "README.md" }), []);
  assert.deepEqual(touchedPaths("bash", { command: "ls" }), []);
});

test("leaves prompts unchanged and surfaces the subagent warning on failure", () => {
  const off = promptBody([{ type: "text", text: "hello" }], {
    disableSubagents: true,
  });
  assert.equal(off.text, "hello");
  const on = promptBody([{ type: "text", text: "hello" }], {
    disableSubagents: false,
  });
  assert.equal(on.text, "hello");
  assert.match(
    toolFailureError("task", true, "Permission denied"),
    /Native subagents/,
  );
  assert.match(
    toolFailureError("task", true, "Permission denied"),
    /Permission denied/,
  );
  assert.match(
    toolFailureError("subagent", true, undefined),
    /Native subagents/,
  );
  assert.equal(toolFailureError("bash", true, "boom"), "boom");
  assert.equal(toolFailureError("task", false, "boom"), "boom");
});

test("maps every BB permission mode to the matching OpenCode reply behavior", () => {
  assert.equal(
    automaticPermissionReply("accept-edits", false, "bash"),
    undefined,
  );
  assert.equal(automaticPermissionReply("auto", false, "bash"), "once");
  assert.equal(automaticPermissionReply("full", false, "bash"), "always");
  assert.equal(approvalPermissionReply("allow_once"), "once");
  assert.equal(approvalPermissionReply("allow_for_session"), "always");
  assert.equal(approvalPermissionReply("deny"), "reject");
});

test("rejects native subagent permission requests before every automatic mode", () => {
  for (const permissionMode of ["accept-edits", "auto", "full"] as const) {
    assert.equal(
      automaticPermissionReply(permissionMode, true, "task"),
      "reject",
    );
    assert.equal(
      automaticPermissionReply(permissionMode, true, "subagent"),
      "reject",
    );
  }
});

test("forwards BB skill mentions to OpenCode's native skill API shape", () => {
  const body = promptBody([
    {
      type: "text",
      text: "/review this",
      mentions: [
        {
          start: 0,
          end: 7,
          resource: {
            kind: "command",
            label: "review",
            name: "review",
            origin: "user",
            source: "skill",
            trigger: "/",
            argumentHint: null,
          },
        },
      ],
    },
  ]);
  assert.deepEqual(body.skills, [
    { id: "review", mention: { start: 0, end: 7, text: "/review" } },
  ]);
});

test("falls back to the configured BB skill file when OpenCode has not discovered it", () => {
  const body = promptBody(
    [
      {
        type: "text",
        text: "/review this",
        mentions: [
          {
            start: 0,
            end: 7,
            resource: {
              kind: "command",
              label: "review",
              name: "review",
              origin: "user",
              source: "skill",
              trigger: "/",
              argumentHint: null,
            },
          },
        ],
      },
    ],
    {
      nativeSkills: new Map([["other", undefined]]),
      skillFiles: new Map([["review", "/tmp/bb-skills/review/SKILL.md"]]),
    },
  );
  assert.deepEqual(body.files, [
    { uri: "file:///tmp/bb-skills/review/SKILL.md", name: "review/SKILL.md" },
  ]);
  assert.equal(body.skills, undefined);
});

test("recognizes only BB's standalone built-in compact command", () => {
  const standalone = [
    {
      type: "text",
      text: "/compact",
      mentions: [
        {
          start: 0,
          end: 8,
          resource: {
            kind: "command",
            label: "compact",
            name: "compact",
            origin: "builtin",
            source: "command",
            trigger: "/",
            argumentHint: null,
          },
        },
      ],
    },
  ];
  assert.equal(isManualCompactionTurn(standalone), true);
  assert.equal(
    isManualCompactionTurn([{ ...standalone[0], text: "/compact please" }]),
    false,
  );
  assert.equal(
    isManualCompactionTurn([
      { ...standalone[0] },
      { type: "localFile", path: "/tmp/a.txt" },
    ]),
    false,
  );
});

test("constructs a complete BB compaction turn", () => {
  assert.deepEqual(
    manualCompactionStartDeltas("request_1", "turn_1", "msg_456").map(
      (delta) => delta.kind,
    ),
    ["turn.open", "input.accepted", "item.open"],
  );
  const completed = manualCompactionOutcomeDeltas({
    providerTurnId: "turn_1",
    messageId: "msg_456",
    status: "completed",
  });
  assert.deepEqual(
    completed.map((delta) => delta.kind),
    ["item.close", "context.compacted", "turn.boundary"],
  );
  const failed = manualCompactionOutcomeDeltas({
    providerTurnId: "turn_1",
    messageId: "msg_456",
    status: "failed",
    error: "no context",
  });
  assert.deepEqual(
    failed.map((delta) => delta.kind),
    ["item.close", "turn.boundary"],
  );
  assert.deepEqual(failed.at(-1), {
    kind: "turn.boundary",
    status: "failed",
    error: { message: "no context" },
    providerTurnId: "turn_1",
  });
});

test("retains through a checkpoint by acting on the following turn", () => {
  const ids = ["msg_1", "msg_2", "msg_3", "msg_4"];
  assert.equal(nextMessageIdAfterCheckpoint(ids, "msg_1"), "msg_2");
  assert.equal(nextMessageIdAfterCheckpoint(ids, "msg_4"), undefined);
  assert.equal(nextMessageIdAfterCheckpoint(ids, "msg_missing"), undefined);
  assert.deepEqual(forkBoundaryRetainingThrough(ids, "msg_1"), {
    before: "msg_2",
  });
  assert.deepEqual(forkBoundaryRetainingThrough(ids, "msg_4"), {});
  assert.deepEqual(forkBoundaryRetainingThrough(ids, undefined), {});
  assert.deepEqual(forkBoundaryRetainingThrough(ids, "msg_missing"), {
    before: "msg_missing",
  });
  assert.equal(revertTargetRetainingThrough(ids, "msg_1"), "msg_2");
  assert.equal(revertTargetRetainingThrough(ids, "msg_4"), undefined);
  assert.equal(revertTargetRetainingThrough(ids, "msg_missing"), "msg_missing");

  // User checkpoints retain the whole turn, including the assistant reply.
  const turnMessages = [
    { id: "msg_u1", type: "user" },
    { id: "msg_a1", type: "assistant" },
    { id: "msg_u2", type: "user" },
    { id: "msg_a2", type: "assistant" },
  ];
  assert.equal(nextMessageIdAfterCheckpoint(turnMessages, "msg_u1"), "msg_u2");
  assert.deepEqual(forkBoundaryRetainingThrough(turnMessages, "msg_u1"), {
    before: "msg_u2",
  });
  assert.equal(revertTargetRetainingThrough(turnMessages, "msg_u1"), "msg_u2");
  assert.deepEqual(forkBoundaryRetainingThrough(turnMessages, "msg_u2"), {});
  assert.equal(revertTargetRetainingThrough(turnMessages, "msg_u2"), undefined);
});

test("confirms steered input so BB clears Steer pending", () => {
  assert.deepEqual(steerAcceptedDelta("client_1", "turn_1"), {
    kind: "input.accepted",
    clientRequestId: "client_1",
    providerTurnId: "turn_1",
  });
});

test("maps background shells and subagents to visible task rows", () => {
  const shell = backgroundTaskItem({
    familyId: backgroundTaskKey("call_shell"),
    taskType: backgroundTaskTaskType("bash"),
    description: backgroundTaskDescription("bash", { command: "npm test" }),
    outputFile: "/tmp/shell.out",
  });
  assert.deepEqual(shell, {
    type: "backgroundTask",
    familyId: "bg:call_shell",
    taskType: "local_bash",
    description: "npm test",
    status: "pending",
    taskStatus: "running",
    skipTranscript: false,
    foreground: false,
    outputFile: "/tmp/shell.out",
  });

  const agent = backgroundTaskItem({
    familyId: backgroundTaskKey("call_agent"),
    taskType: backgroundTaskTaskType("subagent"),
    description: backgroundTaskDescription("subagent", {
      agent: "explore",
      description: "List files",
    }),
  });
  assert.equal(agent.taskType, LOCAL_AGENT_TASK_TYPE);
  assert.equal(agent.description, "explore: List files");
  assert.equal(agent.skipTranscript, false);
  assert.equal(agent.foreground, false);
  assert.equal("outputFile" in agent, false);
});

test("parses shell and subagent completion synthetics with tag fallbacks", () => {
  assert.deepEqual(
    parseBackgroundCompletion({
      text: '<shell id="job_1" state="completed" command="npm test">\nok\n</shell>',
      metadata: {
        source: "shell",
        shellID: "shell_1",
        jobID: "job_1",
        state: "completed",
        exit: 0,
      },
    }),
    {
      kind: "shell",
      id: "job_1",
      shellId: "shell_1",
      jobId: "job_1",
      state: "completed",
      text: "ok",
      exit: 0,
    },
  );

  assert.deepEqual(
    parseBackgroundCompletion({
      text: '<subagent sessionID="ses_child" state="error" description="List files">\nboom\n</subagent>',
      metadata: { source: "subagent" },
    }),
    {
      kind: "subagent",
      id: "ses_child",
      state: "error",
      text: "boom",
    },
  );

  assert.deepEqual(
    parseBackgroundCompletion({
      text: "<task_result>done</task_result>",
      metadata: { childID: "ses_child" },
    }),
    {
      kind: "subagent",
      id: "ses_child",
      childId: "ses_child",
      state: "completed",
      text: "<task_result>done</task_result>",
    },
  );

  assert.equal(parseBackgroundCompletion({ text: "plain" }), undefined);
});

test("emits backgroundTask usage only when all three fields are available", () => {
  assert.equal(backgroundTaskUsage(undefined, 100, 200), undefined);
  assert.deepEqual(
    backgroundTaskUsage(
      { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
      100,
      250,
    ),
    { totalTokens: 15, toolUses: 0, durationMs: 150 },
  );
  assert.deepEqual(
    backgroundTaskUsage(
      { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      250,
      100,
    ),
    { totalTokens: 1, toolUses: 0, durationMs: 0 },
  );
});
