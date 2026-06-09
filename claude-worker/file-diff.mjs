import fs from "node:fs/promises";
import path from "node:path";

const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_DIFF_LINES = 1400;
// Lines of unchanged context emitted around each change in a unified hunk.
const DIFF_CONTEXT_LINES = 3;
// Upper bound on the LCS DP table (rows * cols). Above this we fall back to a
// whole-file replacement diff to avoid pathological O(n*m) cost/memory on huge
// files (still bounded downstream by MAX_DIFF_LINES).
const MAX_LCS_CELLS = 4_000_000;
const FILE_EDIT_TOOLS = new Set(["edit", "multiedit", "write", "notebookedit"]);

export function fileChangeFromToolInput(toolName, input) {
  if (!isFileEditTool(toolName)) return null;
  const filePath = filePathFromInput(input);
  if (!filePath) return null;

  const normalizedName = normalizeToolName(toolName);
  if (normalizedName === "write") {
    const content = typeof input?.content === "string" ? input.content : "";
    return buildFileChange(filePath, null, content);
  }

  if (normalizedName === "multiedit" && Array.isArray(input?.edits)) {
    const oldContent = input.edits
      .map((edit) => (typeof edit?.old_string === "string" ? edit.old_string : ""))
      .join("\n");
    const newContent = input.edits
      .map((edit) => (typeof edit?.new_string === "string" ? edit.new_string : ""))
      .join("\n");
    return buildFileChange(filePath, oldContent, newContent);
  }

  if (typeof input?.old_string === "string" || typeof input?.new_string === "string") {
    return buildFileChange(
      filePath,
      typeof input.old_string === "string" ? input.old_string : "",
      typeof input.new_string === "string" ? input.new_string : ""
    );
  }

  return {
    path: filePath,
    change_type: "modify",
    diff: "",
  };
}

export function fileChangeTool({ toolName, input, resultPreview = null, fileChange = null }) {
  const change = fileChange ?? fileChangeFromToolInput(toolName, input);
  if (!change) return null;
  const title = summarizeFileChange(toolName, change.path);
  return {
    item_type: "fileChange",
    name: toolName || "Edit",
    title,
    detail: title,
    query: null,
    path: change.path,
    url: null,
    command: null,
    input_preview: null,
    result_preview: resultPreview,
    diff: change.diff || null,
    file_changes: [change],
  };
}

export function createFileDiffTracker(cwd) {
  const calls = new Map();
  const root = cwd || process.cwd();

  return {
    async capture(event) {
      if (event?.type !== "tool_call_requested" || !isFileEditTool(event.name)) {
        return event;
      }
      const filePath = filePathFromInput(event.args);
      if (!filePath || !event.id) return event;
      const absolutePath = path.resolve(root, filePath);
      calls.set(event.id, {
        filePath,
        absolutePath,
        input: event.args ?? {},
        toolName: event.name,
        before: await readTextSnapshot(absolutePath),
      });
      return event;
    },

    async enrichResult(event) {
      if (event?.type !== "tool_call_result" || !event.id) return event;
      const call = calls.get(event.id);
      if (!call) return event;
      calls.delete(event.id);

      const after = await readTextSnapshot(call.absolutePath);
      const fileChange =
        call.before.skipped || after.skipped
          ? {
              path: call.filePath,
              change_type: changeType(call.before.exists, after.exists),
              diff: "",
            }
          : buildFileChange(
              call.filePath,
              call.before.exists ? call.before.content : null,
              after.exists ? after.content : null
            );
      const fallbackChange = fileChangeFromToolInput(call.toolName, call.input);
      const tool = fileChangeTool({
        toolName: call.toolName,
        input: call.input,
        resultPreview: event.content ?? null,
        fileChange: fileChange?.diff || !fallbackChange ? fileChange : fallbackChange,
      });
      return tool ? { ...event, tool } : event;
    },
  };
}

function isFileEditTool(toolName) {
  return FILE_EDIT_TOOLS.has(normalizeToolName(toolName));
}

function normalizeToolName(toolName) {
  return String(toolName || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function filePathFromInput(input) {
  for (const key of ["file_path", "path", "notebook_path"]) {
    if (typeof input?.[key] === "string" && input[key].trim()) {
      return input[key];
    }
  }
  return "";
}

async function readTextSnapshot(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return { exists: false, content: "", skipped: true };
    if (stat.size > MAX_SNAPSHOT_BYTES) return { exists: true, content: "", skipped: true };
    return { exists: true, content: await fs.readFile(filePath, "utf8"), skipped: false };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, content: "", skipped: false };
    return { exists: false, content: "", skipped: true };
  }
}

function buildFileChange(filePath, oldContent, newContent) {
  const oldExists = oldContent !== null && oldContent !== undefined;
  const newExists = newContent !== null && newContent !== undefined;
  return {
    path: filePath,
    change_type: changeType(oldExists, newExists),
    diff: renderFileDiff(filePath, oldExists ? oldContent : "", newExists ? newContent : "", {
      oldExists,
      newExists,
    }),
  };
}

function changeType(oldExists, newExists) {
  if (!oldExists && newExists) return "add";
  if (oldExists && !newExists) return "delete";
  return "modify";
}

function renderFileDiff(filePath, oldContent, newContent, { oldExists = true, newExists = true } = {}) {
  if (oldExists && newExists && oldContent === newContent) return "";
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);

  const header = [`diff --git a/${filePath} b/${filePath}`];
  if (!oldExists) header.push("new file mode 100644");
  if (!newExists) header.push("deleted file mode 100644");
  header.push(oldExists ? `--- a/${filePath}` : "--- /dev/null");
  header.push(newExists ? `+++ b/${filePath}` : "+++ /dev/null");

  let body;
  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    // Guard against pathological diff cost on very large files: fall back to a
    // whole-file replacement (every old line removed, every new line added).
    body = [
      `@@ -${rangeHeader(oldLines.length, oldExists)} +${rangeHeader(newLines.length, newExists)} @@`,
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
    ];
  } else {
    body = buildUnifiedHunks(computeLineOps(oldLines, newLines));
  }

  // No line-level changes (e.g. only a trailing-newline difference) → no diff.
  if (!body.length) return "";

  const lines = [...header, ...body];
  if (lines.length > MAX_DIFF_LINES) {
    return [
      ...lines.slice(0, MAX_DIFF_LINES - 1),
      `# Diff truncated by agent-relay: ${lines.length - MAX_DIFF_LINES + 1} lines omitted`,
    ].join("\n") + "\n";
  }
  return lines.join("\n") + "\n";
}

// Classic LCS line diff: returns an ordered list of {type, line} ops where type
// is "equal" | "del" | "add". Compares lines with strict equality.
function computeLineOps(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  // dp[i][j] = length of the LCS of oldLines[i..] and newLines[j..].
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: "equal", line: oldLines[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", line: oldLines[i] });
      i += 1;
    } else {
      ops.push({ type: "add", line: newLines[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: "del", line: oldLines[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: "add", line: newLines[j] });
    j += 1;
  }
  return ops;
}

// Turn an ordered op list into unified-diff hunk lines with DIFF_CONTEXT_LINES
// of context around each change region. Adjacent change regions whose context
// windows touch are coalesced into a single hunk.
function buildUnifiedHunks(ops) {
  const changeIndexes = [];
  for (let k = 0; k < ops.length; k += 1) {
    if (ops[k].type !== "equal") changeIndexes.push(k);
  }
  if (!changeIndexes.length) return [];

  const context = DIFF_CONTEXT_LINES;
  const lastIndex = ops.length - 1;
  const hunks = [];
  let start = Math.max(0, changeIndexes[0] - context);
  let end = Math.min(lastIndex, changeIndexes[0] + context);
  for (let x = 1; x < changeIndexes.length; x += 1) {
    const idx = changeIndexes[x];
    if (idx - context <= end + 1) {
      end = Math.min(lastIndex, idx + context);
    } else {
      hunks.push([start, end]);
      start = Math.max(0, idx - context);
      end = Math.min(lastIndex, idx + context);
    }
  }
  hunks.push([start, end]);

  // Prefix sums of consumed old/new lines so hunk headers get 1-based starts.
  const oldPrefix = new Array(ops.length + 1).fill(0);
  const newPrefix = new Array(ops.length + 1).fill(0);
  for (let k = 0; k < ops.length; k += 1) {
    const { type } = ops[k];
    oldPrefix[k + 1] = oldPrefix[k] + (type === "equal" || type === "del" ? 1 : 0);
    newPrefix[k + 1] = newPrefix[k] + (type === "equal" || type === "add" ? 1 : 0);
  }

  const lines = [];
  for (const [s, e] of hunks) {
    const oldCount = oldPrefix[e + 1] - oldPrefix[s];
    const newCount = newPrefix[e + 1] - newPrefix[s];
    const oldStart = oldCount > 0 ? oldPrefix[s] + 1 : oldPrefix[s];
    const newStart = newCount > 0 ? newPrefix[s] + 1 : newPrefix[s];
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let k = s; k <= e; k += 1) {
      const op = ops[k];
      if (op.type === "equal") lines.push(` ${op.line}`);
      else if (op.type === "del") lines.push(`-${op.line}`);
      else lines.push(`+${op.line}`);
    }
  }
  return lines;
}

function splitLines(content) {
  if (!content) return [];
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  return normalized ? normalized.split("\n") : [];
}

function rangeHeader(lineCount, exists) {
  if (!exists || lineCount === 0) return "0,0";
  return lineCount === 1 ? "1" : `1,${lineCount}`;
}

function summarizeFileChange(toolName, filePath) {
  const basename = path.basename(filePath || "file");
  const normalizedName = normalizeToolName(toolName);
  if (normalizedName === "write") return `Wrote ${basename}`;
  return `Edited ${basename}`;
}
