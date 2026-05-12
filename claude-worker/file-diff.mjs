import fs from "node:fs/promises";
import path from "node:path";

const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_DIFF_LINES = 1400;
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
    diff: renderWholeFileDiff(filePath, oldExists ? oldContent : "", newExists ? newContent : "", {
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

function renderWholeFileDiff(filePath, oldContent, newContent, { oldExists = true, newExists = true } = {}) {
  if (oldExists && newExists && oldContent === newContent) return "";
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const lines = [`diff --git a/${filePath} b/${filePath}`];
  if (!oldExists) lines.push("new file mode 100644");
  if (!newExists) lines.push("deleted file mode 100644");
  lines.push(oldExists ? `--- a/${filePath}` : "--- /dev/null");
  lines.push(newExists ? `+++ b/${filePath}` : "+++ /dev/null");
  lines.push(`@@ -${rangeHeader(oldLines.length, oldExists)} +${rangeHeader(newLines.length, newExists)} @@`);
  lines.push(...oldLines.map((line) => `-${line}`));
  lines.push(...newLines.map((line) => `+${line}`));

  if (lines.length > MAX_DIFF_LINES) {
    return [
      ...lines.slice(0, MAX_DIFF_LINES - 1),
      `# Diff truncated by agent-relay: ${lines.length - MAX_DIFF_LINES + 1} lines omitted`,
    ].join("\n") + "\n";
  }
  return lines.join("\n") + "\n";
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
