import {
  fileChangeFromToolInput,
  fileChangeTool,
} from "./file-diff.mjs";

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text") return block.text || "";
      if (block?.type === "tool_result") {
        return typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function previewJson(value, max = 1000) {
  let text;
  try {
    text = JSON.stringify(value ?? {});
  } catch {
    text = String(value ?? "");
  }
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

function toolTitle(name) {
  if (!name) return "Tool call";
  return name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function mapToolCall(block, msg, status = "running") {
  const fileChange = fileChangeFromToolInput(block.name, block.input);
  const tool =
    fileChangeTool({
      toolName: block.name,
      input: block.input ?? {},
      fileChange,
    }) ?? {
      item_type: "toolCall",
      name: block.name || "unknown",
      title: toolTitle(block.name),
      detail: null,
      query: null,
      path: typeof block.input?.file_path === "string" ? block.input.file_path : null,
      url: typeof block.input?.url === "string" ? block.input.url : null,
      command: typeof block.input?.command === "string" ? block.input.command : null,
      input_preview: previewJson(block.input ?? {}),
      result_preview: null,
      diff: null,
      file_changes: [],
    };

  return {
    type: "tool_call_requested",
    id: block.id,
    name: block.name,
    args: block.input ?? {},
    item_id: `tool:${block.id}`,
    turn_id: msg.uuid || block.id,
    status,
    tool,
  };
}

export function mapSdkMessage(msg) {
  switch (msg.type) {
    case "system": {
      if (msg.subtype === "init") {
        return {
          type: "session_started",
          provider: "claude_code",
          provider_session_id: msg.session_id,
          model: msg.model,
          cwd: msg.cwd,
          tools: msg.tools || [],
        };
      }
      if (msg.subtype === "session_state_changed") {
        if (msg.state === "idle") return { type: "done" };
        return { type: "status_changed", state: msg.state };
      }
      return null;
    }

    case "assistant": {
      const events = [];
      const blocks = msg.message?.content ?? [];
      let text = "";
      for (const block of blocks) {
        switch (block.type) {
          case "text":
            text += block.text || "";
            break;
          case "tool_use":
            events.push(mapToolCall(block, msg));
            break;
          case "tool_result":
            events.push({
              type: "tool_call_result",
              id: block.tool_use_id,
              content:
                typeof block.content === "string"
                  ? block.content
                  : JSON.stringify(block.content),
            });
            break;
          default:
            break;
        }
      }
      if (text) {
        events.unshift({
          type: "assistant_message",
          item_id: `assistant:${msg.uuid}`,
          turn_id: msg.uuid,
          text,
          status: msg.error ? "failed" : "completed",
        });
      }
      return events.length === 1 ? events[0] : events;
    }

    case "user": {
      const events = [];
      const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
      for (const block of blocks) {
        if (block?.type !== "tool_result") continue;
        events.push({
          type: "tool_call_result",
          id: block.tool_use_id,
          turn_id: msg.uuid || block.tool_use_id,
          content:
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content ?? ""),
        });
      }
      return events.length === 0 ? null : events.length === 1 ? events[0] : events;
    }

    case "result":
      return { type: "done", usage: msg.usage };

    default:
      return null;
  }
}

export function mapSessionInfo(session) {
  return {
    id: session.sessionId,
    name: session.customTitle || session.summary || session.firstPrompt || null,
    preview: session.summary || session.firstPrompt || "",
    cwd: session.cwd || "",
    updated_at: Math.floor((session.lastModified || session.createdAt || Date.now()) / 1000),
    source: "claude_code",
    status: "idle",
    model_provider: "anthropic",
    provider: "claude_code",
  };
}

export function mapSessionMessages(messages) {
  const entries = [];
  const toolEntryById = new Map();

  function upsertToolResult(toolUseId, content) {
    if (!toolUseId) return;
    const itemId = `tool:${toolUseId}`;
    const resultPreview = typeof content === "string"
      ? content
      : JSON.stringify(content ?? "");
    const existingIndex = toolEntryById.get(itemId);
    if (existingIndex != null) {
      const existing = entries[existingIndex];
      existing.status = "completed";
      existing.tool = {
        ...existing.tool,
        result_preview: resultPreview,
      };
      return;
    }
    entries.push({
      item_id: itemId,
      kind: "tool_call",
      text: null,
      status: "completed",
      turn_id: toolUseId,
      tool: {
        item_type: "toolCall",
        name: "tool",
        title: "Tool",
        detail: null,
        query: null,
        path: null,
        url: null,
        command: null,
        input_preview: null,
        result_preview: resultPreview,
        diff: null,
        file_changes: [],
      },
    });
    toolEntryById.set(itemId, entries.length - 1);
  }

  for (const [index, item] of messages.entries()) {
    const message = item.message ?? {};
    const itemId = item.uuid || `${item.type}:${index}`;
    if (item.type === "user") {
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const block of blocks) {
        if (block?.type === "tool_result") {
          upsertToolResult(block.tool_use_id, block.content);
        }
      }
      const text = blocks.some((block) => block?.type === "tool_result")
        ? blocks
            .filter((block) => block?.type === "text")
            .map((block) => block.text || "")
            .join("\n")
        : textFromContent(message.content);
      if (text) {
        entries.push({
          item_id: `user:${itemId}`,
          kind: "user_text",
          text,
          status: "completed",
          turn_id: itemId,
          tool: null,
        });
      }
      continue;
    }

    if (item.type === "assistant") {
      const blocks = message.content ?? [];
      const text = textFromContent(blocks);
      if (text) {
        entries.push({
          item_id: `assistant:${itemId}`,
          kind: "agent_text",
          text,
          status: "completed",
          turn_id: itemId,
          tool: null,
        });
      }
      for (const block of Array.isArray(blocks) ? blocks : []) {
        if (block?.type !== "tool_use") continue;
        const event = mapToolCall(block, { uuid: itemId }, "completed");
        entries.push({
          item_id: event.item_id,
          kind: "tool_call",
          text: null,
          status: "completed",
          turn_id: itemId,
          tool: event.tool,
        });
        toolEntryById.set(event.item_id, entries.length - 1);
      }
    }
  }
  return entries;
}
