#!/usr/bin/env node
// Orchestrator MCP stdio proxy — no local tool list or schemas.
// Forwards tools/list and tools/call to the relay (`orchestrator_tools.rs`).
// Fresh list each turn so availability tracks live runs/questions.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const RELAY_URL = process.env.SEALWIRE_RELAY_URL || "http://127.0.0.1:8787";
const DEVICE_ID = process.env.SEALWIRE_DEVICE_ID || null;
// Set for a team seat instead of a device. Picks the read-only toolset and
// scopes every answer to that run.
const SEAT_RUN_ID = process.env.SEALWIRE_SEAT_RUN_ID || null;
// Set for an ordinary session that may bring in another agent. Unguessable, and
// only ever present inside the subprocess the relay launched — a thread id would
// prove nothing, since any client can read the whole thread list.
const ASK_TOKEN = process.env.SEALWIRE_ASK_TOKEN || null;
const API_TOKEN = process.env.RELAY_API_TOKEN || null;

function headers() {
  const value = { "content-type": "application/json" };
  if (API_TOKEN) value.authorization = `Bearer ${API_TOKEN}`;
  return value;
}

async function relayJson(path, init) {
  const response = await fetch(`${RELAY_URL}${path}`, { ...init, headers: headers() });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.error?.message || body?.message || `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return body;
}

const server = new Server(
  { name: "sealwire", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const params = new URLSearchParams();
  if (SEAT_RUN_ID) params.set("seat_run_id", SEAT_RUN_ID);
  if (ASK_TOKEN) params.set("ask_token", ASK_TOKEN);
  const query = params.toString();
  const path = query ? `/api/orchestrator/tools?${query}` : "/api/orchestrator/tools";
  const body = await relayJson(path, { method: "GET" });
  const tools = body?.data?.tools ?? body?.tools ?? [];
  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema ?? tool.inputSchema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};
  try {
    // Refused calls are 200 + isError (model can correct); don't throw those.
    return await relayJson(`/api/orchestrator/tools/${encodeURIComponent(name)}/call`, {
      method: "POST",
      body: JSON.stringify({
        arguments: args,
        device_id: DEVICE_ID,
        seat_run_id: SEAT_RUN_ID,
        ask_token: ASK_TOKEN,
      }),
    });
  } catch (error) {
    // Transport failure → tool result, not a session fault.
    return {
      content: [{ type: "text", text: `sealwire relay unreachable: ${error.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
