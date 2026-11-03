import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { experimental_captureBridgeJsonRpcOutput } from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  handleRuntimeResponse,
  requestRuntime,
} from "../../support/host-api.js";

test("interaction requests wait past the old deadline for a late answer", async () => {
  const output = experimental_captureBridgeJsonRpcOutput();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = requestRuntime(
      "interaction/request",
      { payload: { kind: "user_question" } },
      { signal: new AbortController().signal },
    );
    let settled = false;
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    mock.timers.tick(10 * 60 * 1000 + 1);
    await Promise.resolve();
    assert.equal(settled, false, "request settled before the late answer");

    const request = output.messages[0];
    assert.ok(request);
    assert.ok(request.id !== undefined);
    handleRuntimeResponse({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        kind: "user_answer",
        answers: { q0: { selected: [], freeText: "late answer" } },
      },
    });
    assert.deepEqual(await pending, {
      kind: "user_answer",
      answers: { q0: { selected: [], freeText: "late answer" } },
    });
  } finally {
    mock.timers.reset();
    output.restore();
  }
});
