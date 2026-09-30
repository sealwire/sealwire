These MCP result fixtures were captured using the installed providers against
local scripted model endpoints, with separate temporary configuration directories
and the production `orchestrator-mcp.mjs` proxy. Session and turn IDs were replaced
with test identifiers; no account data or credentials are included.

- `claude-mcp-delegate-events.json`: worker NDJSON from Claude Agent SDK 0.3.281.
  The SDK's `user.tool_use_result._meta` produces the last event. The model and
  PostToolUse hook receive the text content without that metadata.
- `codex-mcp-delegate-result.json`: the completed `mcpToolCall` item from Codex
  app-server 0.156.1. The model receives the text content, while `result._meta`
  carries the ask ID for the relay.

The worker suite also runs the installed Claude SDK against a local model
endpoint in `claude-worker/mcp-sdk.test.mjs`, exercising two parallel calls.
