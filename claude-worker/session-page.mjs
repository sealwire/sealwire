import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_RAW_MESSAGE_LIMIT = 96;
const DEFAULT_TARGET_BYTES = 14_000;
const READ_CHUNK_BYTES = 64 * 1024;
const READ_LINE_CHUNK_BYTES = 4 * 1024;
const PARENT_SEARCH_CHUNK_BYTES = 4 * 1024;
const SESSION_ID_PATTERN = /^[0-9a-f-]{16,}$/i;

export async function findLocalSessionFile({
  cwd = "",
  homeDir = os.homedir(),
  sessionId,
}) {
  if (!SESSION_ID_PATTERN.test(sessionId || "")) {
    return null;
  }
  const projectsDir = path.join(homeDir, ".claude", "projects");
  if (cwd) {
    const projectKey = cwd.replaceAll(path.sep, "-");
    const candidate = path.join(projectsDir, projectKey, `${sessionId}.jsonl`);
    if (await isFile(candidate)) {
      return candidate;
    }
  }

  let projects;
  try {
    projects = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const project of projects) {
    if (!project.isDirectory()) {
      continue;
    }
    const candidate = path.join(projectsDir, project.name, `${sessionId}.jsonl`);
    if (await isFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function readSessionMessagePage({
  beforeByte = null,
  filePath,
  rawMessageLimit = DEFAULT_RAW_MESSAGE_LIMIT,
  targetBytes = DEFAULT_TARGET_BYTES,
}) {
  const handle = await open(filePath, "r");
  try {
    const fileSize = (await handle.stat()).size;
    const reader = {
      bytesRead: 0,
      async read(buffer, offset, length, position) {
        const result = await handle.read(buffer, offset, length, position);
        this.bytesRead += result.bytesRead;
        return result;
      },
    };
    const offsets = new Map();
    let nextOffset = Number.isSafeInteger(beforeByte) ? beforeByte : null;
    let nextExpectedUuid = null;
    let parsedLineCount = 0;

    if (nextOffset == null) {
      const latest = await findLatestConversationRecord(reader, fileSize, offsets);
      if (!latest) {
        return emptyPage();
      }
      nextOffset = latest.start;
      nextExpectedUuid = latest.record.uuid;
    } else {
      const cursorLine = await readLineAtStart(reader, nextOffset, fileSize);
      const cursorRecord = cursorLine ? parseRecord(cursorLine.bytes) : null;
      if (!cursorRecord?.uuid) {
        throw new Error(`Claude session cursor ${nextOffset} no longer matches a message`);
      }
      nextExpectedUuid = cursorRecord.uuid;
    }

    const selectedNewestFirst = [];
    const visited = new Set();
    while (nextOffset != null && nextExpectedUuid) {
      if (visited.has(nextExpectedUuid)) {
        throw new Error(`Claude session parent cycle at ${nextExpectedUuid}`);
      }
      visited.add(nextExpectedUuid);

      const line = await readLineAtStart(reader, nextOffset, fileSize);
      if (!line || line.start !== nextOffset) {
        throw new Error(`Claude session cursor ${nextOffset} is not a record boundary`);
      }
      const record = parseRecord(line.bytes);
      parsedLineCount += 1;
      if (record?.uuid !== nextExpectedUuid) {
        throw new Error(`Claude session cursor ${nextOffset} no longer matches its message`);
      }
      offsets.set(record.uuid, line.start);
      if (isConversationMessage(record)) {
        selectedNewestFirst.push(toSessionMessage(record));
      }

      nextExpectedUuid = record?.parentUuid || null;
      if (!nextExpectedUuid) {
        nextOffset = null;
        break;
      }
      nextOffset = await findRecordOffsetByUuid(
        reader,
        fileSize,
        nextExpectedUuid,
        line.start,
        line.end,
        offsets
      );
      if (nextOffset == null) {
        throw new Error(`Claude session parent ${nextExpectedUuid} was not found`);
      }

      if (
        selectedNewestFirst.length >= rawMessageLimit
        || (
          selectedNewestFirst.length >= 8
          && Buffer.byteLength(JSON.stringify(selectedNewestFirst), "utf8") >= targetBytes
        )
      ) {
        break;
      }
    }

    return {
      messages: selectedNewestFirst.reverse(),
      nextCursor: nextOffset,
      nextExpectedUuid,
      parsedLineCount,
      bytesRead: reader.bytesRead,
    };
  } finally {
    await handle.close();
  }
}

async function findLatestConversationRecord(reader, fileSize, offsets) {
  for await (const line of linesBackward(reader, fileSize)) {
    cacheUuidOffset(line, offsets);
    const record = parseRecord(line.bytes);
    if (isConversationMessage(record)) {
      return { ...line, record };
    }
  }
  return null;
}

async function findRecordOffsetByUuid(
  reader,
  fileSize,
  targetUuid,
  currentStart,
  currentEnd,
  offsets
) {
  const cached = offsets.get(targetUuid);
  if (cached != null) {
    return cached;
  }

  const backward = linesBackward(
    reader,
    currentStart,
    PARENT_SEARCH_CHUNK_BYTES
  )[Symbol.asyncIterator]();
  const forward = linesForward(
    reader,
    Math.min(currentEnd + 1, fileSize),
    fileSize,
    PARENT_SEARCH_CHUNK_BYTES
  )[Symbol.asyncIterator]();
  let backwardDone = currentStart <= 0;
  let forwardDone = currentEnd + 1 >= fileSize;
  let backwardFloor = currentStart;
  let forwardCeiling = currentEnd + 1;
  while (!backwardDone || !forwardDone) {
    if (!backwardDone) {
      backwardFloor = Math.max(0, backwardFloor - PARENT_SEARCH_CHUNK_BYTES);
      while (!backwardDone) {
        const result = await backward.next();
        backwardDone = result.done;
        if (result.done) break;
        if (cacheUuidOffset(result.value, offsets) === targetUuid) {
          return result.value.start;
        }
        if (result.value.start <= backwardFloor) break;
      }
    }
    if (!forwardDone) {
      forwardCeiling = Math.min(
        fileSize,
        forwardCeiling + PARENT_SEARCH_CHUNK_BYTES
      );
      while (!forwardDone) {
        const result = await forward.next();
        forwardDone = result.done;
        if (result.done) break;
        if (cacheUuidOffset(result.value, offsets) === targetUuid) {
          return result.value.start;
        }
        if (result.value.end >= forwardCeiling) break;
      }
    }
  }
  return null;
}

async function readLineAtStart(reader, start, fileSize) {
  let position = start;
  const chunks = [];
  let total = 0;
  while (position < fileSize) {
    const length = Math.min(READ_LINE_CHUNK_BYTES, fileSize - position);
    const chunk = Buffer.allocUnsafe(length);
    const { bytesRead } = await reader.read(chunk, 0, length, position);
    if (bytesRead === 0) break;
    const data = chunk.subarray(0, bytesRead);
    const newline = data.indexOf(0x0a);
    const segment = newline >= 0 ? data.subarray(0, newline) : data;
    chunks.push(segment);
    total += segment.length;
    if (newline >= 0) {
      return {
        start,
        end: start + total,
        bytes: Buffer.concat(chunks, total),
      };
    }
    position += bytesRead;
  }
  return total > 0
    ? { start, end: start + total, bytes: Buffer.concat(chunks, total) }
    : null;
}

async function* linesBackward(reader, endExclusive, chunkBytes = READ_CHUNK_BYTES) {
  let position = Math.max(0, endExclusive);
  let suffix = Buffer.alloc(0);
  while (position > 0) {
    const start = Math.max(0, position - chunkBytes);
    const chunk = Buffer.allocUnsafe(position - start);
    const { bytesRead } = await reader.read(chunk, 0, chunk.length, start);
    const data = Buffer.concat([chunk.subarray(0, bytesRead), suffix]);
    let lineEnd = data.length;
    for (let index = bytesRead - 1; index >= 0; index -= 1) {
      if (data[index] !== 0x0a) continue;
      const lineStart = index + 1;
      yield {
        start: start + lineStart,
        end: start + lineEnd,
        bytes: data.subarray(lineStart, lineEnd),
      };
      lineEnd = index;
    }
    suffix = data.subarray(0, lineEnd);
    position = start;
  }
  if (suffix.length > 0) {
    yield { start: 0, end: suffix.length, bytes: suffix };
  }
}

async function* linesForward(
  reader,
  start,
  fileSize,
  chunkBytes = READ_CHUNK_BYTES
) {
  let position = Math.max(0, start);
  let prefix = Buffer.alloc(0);
  let lineStart = position;
  while (position < fileSize) {
    const length = Math.min(chunkBytes, fileSize - position);
    const chunk = Buffer.allocUnsafe(length);
    const { bytesRead } = await reader.read(chunk, 0, length, position);
    if (bytesRead === 0) break;
    const data = Buffer.concat([prefix, chunk.subarray(0, bytesRead)]);
    const dataStart = lineStart;
    let segmentStart = 0;
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== 0x0a) continue;
      yield {
        start: dataStart + segmentStart,
        end: dataStart + index,
        bytes: data.subarray(segmentStart, index),
      };
      segmentStart = index + 1;
    }
    prefix = data.subarray(segmentStart);
    lineStart = dataStart + segmentStart;
    position += bytesRead;
  }
  if (prefix.length > 0) {
    yield { start: lineStart, end: lineStart + prefix.length, bytes: prefix };
  }
}

function cacheUuidOffset(line, offsets) {
  const text = line.bytes.toString("utf8");
  const match = /"uuid"\s*:\s*"([^"]+)"/.exec(text);
  const uuid = match?.[1] || null;
  if (uuid) {
    offsets.set(uuid, line.start);
  }
  return uuid;
}

function parseRecord(bytes) {
  const line = bytes.toString("utf8").trim();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function emptyPage() {
  return {
    messages: [],
    nextCursor: null,
    nextExpectedUuid: null,
    parsedLineCount: 0,
    bytesRead: 0,
  };
}

function isConversationMessage(record) {
  return (
    (record?.type === "user" || record?.type === "assistant")
    && record?.isSidechain !== true
    && typeof record?.uuid === "string"
  );
}

function toSessionMessage(record) {
  return {
    type: record.type,
    uuid: record.uuid,
    session_id: record.sessionId || "",
    message: record.message,
    parent_tool_use_id: record.parent_tool_use_id ?? null,
    timestamp: record.timestamp,
  };
}

async function isFile(candidate) {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}
