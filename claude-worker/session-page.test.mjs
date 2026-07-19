import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readSessionCwdFromFile, readSessionMessagePage } from "./session-page.mjs";

test("cold transcript page parses only the tail chain instead of the whole session", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sealwire-claude-page-"));
  const filePath = path.join(dir, "session.jsonl");
  const lines = [];
  let parentUuid = null;
  for (let index = 0; index < 10_000; index += 1) {
    const uuid = `message-${index}`;
    lines.push(JSON.stringify({
      isSidechain: false,
      message: {
        content: `message ${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
      },
      parentUuid,
      sessionId: "session-1",
      timestamp: `2026-06-13T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      type: index % 2 === 0 ? "user" : "assistant",
      uuid,
    }));
    parentUuid = uuid;
  }
  await writeFile(filePath, `${lines.join("\n")}\n`);

  const page = await readSessionMessagePage({
    filePath,
    rawMessageLimit: 24,
    targetBytes: Number.MAX_SAFE_INTEGER,
  });

  assert.equal(page.messages.length, 24);
  assert.equal(page.messages[0].uuid, "message-9976");
  assert.equal(page.messages.at(-1).uuid, "message-9999");
  assert.equal(page.parsedLineCount, 24);
  assert.ok(
    page.bytesRead < (await stat(filePath)).size / 2,
    `cold page read ${page.bytesRead} bytes from a ${(await stat(filePath)).size}-byte session`
  );
  assert.ok(page.nextCursor > 0);

  const older = await readSessionMessagePage({
    beforeByte: page.nextCursor,
    filePath,
    rawMessageLimit: 24,
    targetBytes: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(older.messages[0].uuid, "message-9952");
  assert.equal(older.messages.at(-1).uuid, "message-9975");
  assert.equal(older.parsedLineCount, 24);
});

test("provider cursor follows a parent written after its child without returning an empty loop", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sealwire-claude-page-order-"));
  const filePath = path.join(dir, "session.jsonl");
  const records = Array.from({ length: 10_000 }, (_, index) => ({
    type: "progress",
    uuid: `noise-${index}`,
    payload: "x".repeat(128),
  }));
  records.push(
    message("a", null),
    message("c", "b"),
    message("b", "a"),
    message("d", "c"),
  );
  await writeFile(filePath, `${records.map(JSON.stringify).join("\n")}\n`);

  const tail = await readSessionMessagePage({
    filePath,
    rawMessageLimit: 2,
    targetBytes: Number.MAX_SAFE_INTEGER,
  });
  assert.deepEqual(tail.messages.map((entry) => entry.uuid), ["c", "d"]);
  assert.ok(tail.nextCursor > 0);
  assert.equal(tail.nextExpectedUuid, "b");
  assert.ok(
    tail.bytesRead < (await stat(filePath)).size / 2,
    `forward parent lookup read ${tail.bytesRead} bytes from a ${(await stat(filePath)).size}-byte session`
  );

  const older = await readSessionMessagePage({
    beforeByte: tail.nextCursor,
    filePath,
    rawMessageLimit: 2,
    targetBytes: Number.MAX_SAFE_INTEGER,
  });
  assert.deepEqual(older.messages.map((entry) => entry.uuid), ["a", "b"]);
  assert.equal(older.nextCursor, null);
});

test("session cwd can be recovered from a local jsonl record when SDK list omits it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sealwire-claude-cwd-"));
  const filePath = path.join(dir, "session.jsonl");
  await writeFile(
    filePath,
    [
      JSON.stringify({ type: "noise", payload: "x".repeat(200_000) }),
      JSON.stringify({
        cwd: "/Users/luchi/git/agent-relay",
        sessionId: "session-1",
        type: "user",
      }),
    ].join("\n") + "\n",
  );

  assert.equal(
    await readSessionCwdFromFile({ filePath }),
    "/Users/luchi/git/agent-relay",
  );
});

function message(uuid, parentUuid) {
  return {
    isSidechain: false,
    message: { content: uuid, role: "assistant" },
    parentUuid,
    sessionId: "session-1",
    timestamp: "2026-06-13T00:00:00.000Z",
    type: "assistant",
    uuid,
  };
}
