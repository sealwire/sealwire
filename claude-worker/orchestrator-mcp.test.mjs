import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "orchestrator-mcp.mjs");

// A stand-in relay. The point of these tests is the BRIDGE — that it speaks MCP
// correctly and forwards faithfully — so the relay is a stub whose recorded
// requests are the assertion.
function startStubRelay(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization ?? null,
        body: body ? JSON.parse(body) : null,
      });
      const result = handler(req, body ? JSON.parse(body) : null);
      res.writeHead(result.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, seen, port: server.address().port });
    });
  });
}

async function connect(port, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...process.env,
      SEALWIRE_RELAY_URL: `http://127.0.0.1:${port}`,
      SEALWIRE_DEVICE_ID: "device-1",
      ...env,
    },
  });
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

const TOOLS_BODY = {
  data: {
    tools: [
      {
        name: "propose_task",
        description: "Stage a task for the user to confirm.",
        input_schema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: false,
        },
      },
    ],
  },
};

test("the bridge completes an MCP handshake and lists what the relay offers", async () => {
  const { server, port } = await startStubRelay(() => ({ body: TOOLS_BODY }));
  const { client, transport } = await connect(port);
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 1);
    assert.equal(listed.tools[0].name, "propose_task");
    // snake_case on the wire from Rust, camelCase in MCP. Getting this wrong
    // yields a tool the model can see but never call correctly.
    assert.equal(listed.tools[0].inputSchema.type, "object");
    assert.deepEqual(listed.tools[0].inputSchema.required, ["title"]);
  } finally {
    await transport.close();
    server.close();
  }
});

test("the tool list is re-fetched per call, never cached", async () => {
  // Availability is a function of live state — a run ends, a card is staged — so
  // a list cached at startup is stale within a turn.
  let calls = 0;
  const { server, port } = await startStubRelay(() => {
    calls += 1;
    return { body: TOOLS_BODY };
  });
  const { client, transport } = await connect(port);
  try {
    await client.listTools();
    await client.listTools();
    assert.equal(calls, 2, "each tools/list must ask the relay again");
  } finally {
    await transport.close();
    server.close();
  }
});

test("a tool call is forwarded with its arguments and the device id", async () => {
  const { server, seen, port } = await startStubRelay((req) => {
    if (req.url === "/api/orchestrator/tools") return { body: TOOLS_BODY };
    return {
      body: { content: [{ type: "text", text: "Staged proposal orch_prop_x." }], isError: false },
    };
  });
  const { client, transport } = await connect(port);
  try {
    const result = await client.callTool({
      name: "propose_task",
      arguments: { title: "Add a parser" },
    });
    assert.equal(result.isError, false);
    assert.equal(result.content[0].text, "Staged proposal orch_prop_x.");

    const call = seen.find((entry) => entry.url.includes("/call"));
    assert.equal(call.url, "/api/orchestrator/tools/propose_task/call");
    assert.equal(call.method, "POST");
    assert.deepEqual(call.body.arguments, { title: "Add a parser" });
    assert.equal(call.body.device_id, "device-1");
  } finally {
    await transport.close();
    server.close();
  }
});

for (const [name, field, id] of [["delegate", "delegate_ask_id", "ask-one"], ["review", "review_id", "review-one"]]) {
  test(`${name} keeps its structured ID through one MCP call`, async () => {
    const { server, seen, port } = await startStubRelay(() => ({
      body: {
        content: [{ type: "text", text: "Delegated." }],
        structuredContent: { [field]: id },
        isError: false,
      },
    }));
    const { client, transport } = await connect(port, { SEALWIRE_ASK_TOKEN: "test-token" });
    try {
      const result = await client.callTool({ name, arguments: { message: "inspect" } });
      assert.deepEqual(result.structuredContent, { [field]: id });
      assert.equal(seen.filter((entry) => entry.url === `/api/orchestrator/tools/${name}/call`).length, 1);
    } finally {
      await transport.close();
      server.close();
    }
  });
}

test("a refused call reaches the model as a readable result, not a thrown error", async () => {
  // The distinction that matters: a model shown a REASON corrects itself; a model
  // shown a transport failure retries the identical call.
  const { server, port } = await startStubRelay((req) => {
    if (req.url === "/api/orchestrator/tools") return { body: TOOLS_BODY };
    return { body: { content: [{ type: "text", text: "'title' is required" }], isError: true } };
  });
  const { client, transport } = await connect(port);
  try {
    const result = await client.callTool({ name: "propose_task", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /title/);
  } finally {
    await transport.close();
    server.close();
  }
});

test("an unreachable relay is reported as a tool error, not a session fault", async () => {
  const { server, port } = await startStubRelay(() => ({ body: TOOLS_BODY }));
  // Point the bridge at a port nothing is listening on.
  const dead = port + 1;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...process.env,
      SEALWIRE_RELAY_URL: `http://127.0.0.1:${dead}`,
      SEALWIRE_DEVICE_ID: "device-1",
    },
  });
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: "propose_task", arguments: { title: "x" } });
    assert.equal(result.isError, true, "the turn must survive a relay that is down");
    assert.match(result.content[0].text, /unreachable/);
  } finally {
    await transport.close();
    server.close();
  }
});

test("the API token is sent only when the relay is configured to want one", async () => {
  const { server, seen, port } = await startStubRelay(() => ({ body: TOOLS_BODY }));
  {
    const { client, transport } = await connect(port);
    await client.listTools();
    await transport.close();
    assert.equal(
      seen.at(-1).authorization,
      null,
      "a loopback relay with no token must not be sent a bogus header"
    );
  }
  {
    const { client, transport } = await connect(port, { RELAY_API_TOKEN: "s3cret" });
    await client.listTools();
    await transport.close();
    assert.equal(seen.at(-1).authorization, "Bearer s3cret");
  }
  server.close();
});
