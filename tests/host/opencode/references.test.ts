import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakeOpenCodeApi } from "../../support/opencode-client.fixture.ts";
import { OpenCodeServer } from "../../support/host-api.js";
import { encodeReferenceId } from "../../../src/shared/references.ts";

test("returns listed references and checks paths for attachments", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-references-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = new OpenCodeServer();
  Object.assign(server, {
    api: createFakeOpenCodeApi({
      reference: {
        list: async () => ({
          data: [
            { name: "docs", path: directory, description: "Product docs" },
            { name: "secret", path: directory, hidden: true },
            { name: "gone", path: join(directory, "missing") },
          ],
        }),
      },
    }),
  });

  const listed = await server.references("/repo");
  assert.deepEqual(listed, [
    { name: "docs", path: directory, description: "Product docs" },
    { name: "secret", path: directory, hidden: true },
    { name: "gone", path: join(directory, "missing") },
  ]);
  assert.deepEqual(await server.reference("/repo", "docs"), listed[0]);
  assert.deepEqual(await server.reference("/repo", "gone"), listed[2]);

  const docsTarget = {
    hostId: "host_1",
    directory: "/repo",
    alias: "docs",
  };
  const goneTarget = {
    hostId: "host_1",
    directory: "/repo",
    alias: "gone",
  };
  const docsId = `reference:${encodeReferenceId(docsTarget)}`;
  const goneId = `reference:${encodeReferenceId(goneTarget)}`;
  assert.deepEqual(
    [
      ...(await server.referenceFiles(
        "/repo",
        new Map([
          [docsId, docsTarget],
          [goneId, goneTarget],
        ]),
      )),
    ],
    [[docsId, { alias: "docs", path: directory, description: "Product docs" }]],
  );
});
