#!/usr/bin/env node

const agentUrl = (process.env.DBVISUALS_AGENT_URL || "").replace(/\/$/, "");
const token = process.env.DBVISUALS_AGENT_TOKEN || "";

const tools = [
  {
    name: "dbvisuals_session",
    description: "Get the active dbVisuals SQLRooms session metadata.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dbvisuals_list_tables",
    description: "List tables and views visible to the dbVisuals agent.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dbvisuals_describe_table",
    description: "Describe a table or view by name, optionally with schema/catalog.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        schema: { type: "string" },
        catalog: { type: "string" },
      },
      required: ["table"],
    },
  },
  {
    name: "dbvisuals_query_sql",
    description: "Run a bounded read-only SQL query and return JSON rows.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string" },
        limit: { type: "number" },
      },
      required: ["sql"],
    },
  },
  {
    name: "dbvisuals_materialize_sql",
    description: "Materialize a SQL query as a table or view when write mode is enabled.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string" },
        name: { type: "string" },
        kind: { type: "string", enum: ["table", "view"] },
        overwrite: { type: "boolean" },
      },
      required: ["sql", "name"],
    },
  },
  {
    name: "dbvisuals_create_visualization",
    description: "Render a deck.gl, DeckJsonMap-style, Mosaic, or mosaic.gl visualization from a JSON spec and bounded SQL data query.",
    inputSchema: {
      type: "object",
      properties: {
        engine: { type: "string", enum: ["deckgl", "deck_json", "mosaic", "mosaic_gl"] },
        name: { type: "string" },
        spec: { type: "object" },
        datasets: { type: "object" },
        data_sql: { type: "string" },
        data_name: { type: "string" },
        limit: { type: "number" },
        width: { type: "string" },
        height: { type: "string" },
        persist: { type: "boolean" },
      },
      required: ["engine", "spec"],
    },
  },
  {
    name: "dbvisuals_execute_r",
    description: "Execute R code in the isolated SQLRooms child process when enabled.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
      },
      required: ["code"],
    },
  },
];

const toolRoutes = {
  dbvisuals_session: { method: "GET", path: "session" },
  dbvisuals_list_tables: { method: "GET", path: "tables" },
  dbvisuals_describe_table: { method: "POST", path: "describe" },
  dbvisuals_query_sql: { method: "POST", path: "query" },
  dbvisuals_materialize_sql: { method: "POST", path: "materialize" },
  dbvisuals_create_visualization: { method: "POST", path: "visualization" },
  dbvisuals_execute_r: { method: "POST", path: "execute-r" },
};

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  readMessages();
});

async function handle(message) {
  if (!message || !message.method) return;
  if (message.method.startsWith("notifications/")) return;

  try {
    if (message.method === "initialize") {
      return send(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "dbvisuals-mcp", version: "0.1.0" },
      });
    }
    if (message.method === "tools/list") {
      return send(message.id, { tools });
    }
    if (message.method === "tools/call") {
      const name = message.params && message.params.name;
      const args = (message.params && message.params.arguments) || {};
      const route = toolRoutes[name];
      if (!route) throw new Error(`Unknown tool: ${name}`);
      const data = await callAgent(route, args);
      return send(message.id, {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      });
    }
    sendError(message.id, -32601, `Unknown method: ${message.method}`);
  } catch (error) {
    sendError(message.id, -32000, error.message);
  }
}

async function callAgent(route, args) {
  if (!agentUrl || !token) {
    throw new Error(
      "Set DBVISUALS_AGENT_URL and DBVISUALS_AGENT_TOKEN before starting the MCP shim.",
    );
  }

  const init = {
    method: route.method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (route.method !== "GET") init.body = JSON.stringify(args || {});

  const response = await fetch(`${agentUrl}/${route.path}`, init);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { success: false, error: text };
  }
  if (!response.ok) {
    throw new Error(data.error || `dbVisuals agent request failed with ${response.status}`);
  }
  return data;
}

function readMessages() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = Buffer.alloc(0);
      return;
    }

    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return;

    const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.slice(bodyEnd);
    handle(JSON.parse(body));
  }
}

function send(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function write(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
