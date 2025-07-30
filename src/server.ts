// src/github-code-search-mcp-http.ts
import express, { Request, Response } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Octokit } from "octokit";
import type { Endpoints } from "@octokit/types";

// ---------- GitHub client ----------
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("GITHUB_TOKEN env var not set"); process.exit(1);
}
const octokit = new Octokit({ auth: TOKEN });

// ---------- MCP Server & Tool ----------
const server = new McpServer({ name: "github-code-search", version: "2.0.0" });

type SearchCodeData = Endpoints["GET /search/code"]["response"]["data"];
const inputSchema = z.object({
  q: z.string().min(1).describe("Search query, e.g. `repo:octokit/rest.js path:src`"),                           
  sort: z.enum(["indexed"]).optional(),              
  order: z.enum(["asc", "desc"]).optional(),
  per_page: z.number().int().min(1).max(25).optional(),
  page: z.number().int().min(1).optional(),
  max_items: z.number().int().min(1).max(100).optional(),
  max_pages: z.number().int().min(1).optional(),
  text_match: z.boolean().optional()
});

server.registerTool(
  "search-code",
  {
    title: "GitHub Code Search",
    description: "Search GitHub code with qualifiers (Streamable HTTP).",
    inputSchema: inputSchema.shape
  },
  async (args) => {
    const {
      q, sort, order,
      per_page = 100, page = 1,
      max_items = 1000, max_pages,
      text_match
    } = inputSchema.parse(args);

    const hdr: Record<string, string> = {
      "X-GitHub-Api-Version": "2022-11-28",
      "Accept": text_match
        ? "application/vnd.github.v3.text-match+json"
        : "application/vnd.github+json"
    };

    const collected: any[] = [];
    let current = page, fetchedPages = 0, total = 0, incomplete = false;

    while (true) {
      if (max_pages && fetchedPages >= max_pages) break;

      const { data, headers } = await octokit.request("GET /search/code", {
        q, sort, order, per_page, page: current, headers: hdr
      }) as { data: SearchCodeData, headers: { link?: string } };

      if (fetchedPages === 0) total = data.total_count;
      incomplete ||= (data as any).incomplete_results ?? false;
      collected.push(...data.items);
      fetchedPages++;

      if (!data.items.length) break;                          // finished
      if (collected.length >= max_items) break;               // user / API cap
      if (collected.length >= 1000) { collected.length = 1000; break; }

      // pagination via Link header (next rel) :contentReference[oaicite:4]{index=4}
      const next = headers.link?.match(/<([^>]+)>;\s*rel="next"/);
      if (!next) break;
      current += 1;
    }

    return {
      content: [
        {
          type: "text",
          text:
            `total_count=${ total } — returned ${ collected.length } items ` +
            `via ${ fetchedPages } page(s)`
        },
        { type: "text", text: JSON.stringify({ total, incomplete, items: collected }, null, 2) },
        ...collected.slice(0, 50).map(item => ({
          type: "resource_link" as const,
          uri: item.html_url,
          name: `${ item.repository?.full_name }:${ item.path }`,
          mimeType: "text/html",
          description: "View on GitHub"
        }))
      ]
    };
  }
);

// ---------- Express + Streamable HTTP (SSE) ----------
const app = express();
app.use(express.json());

// CORS so browsers can read `mcp-session-id` header :contentReference[oaicite:5]{index=5}
app.use(cors({
  origin: "*",
  allowedHeaders: ["content-type", "mcp-session-id", "mcp-client-version"],
  exposedHeaders: ["mcp-session-id", "mcp-server-version"]
}));

// session‑aware transport map
const transports: Record<string, StreamableHTTPServerTransport> = {};

function newTransport(): StreamableHTTPServerTransport {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      transports[sid] = transport;
    },
  });

  return transport;
}


// tiny helper so we can reuse it in POST and GET:
function ensureTransport(sessionId?: string) {
  if (sessionId && transports[sessionId]) return transports[sessionId];

  // create a new one *and* remember it ─ pattern from SDK issues #330 / #420
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: sid => { transports[sid] = transport; },
    onsessionclosed: sid => { delete transports[sid]; }   // avoids leaks
  });
  server.connect(transport);            // async but fire‑and‑forget here
  return transport;
}

app.post("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  const transport = ensureTransport(sid);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  // GET may be the very first call if someone opens the SSE stream manually:
  const sid = req.headers["mcp-session-id"] as string | undefined;
  const transport = ensureTransport(sid);
  await transport.handleRequest(req, res);   // body = undefined on GET
});

const handleSession = async (req: Request, res: Response) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  const transport = sid && transports[sid];
  if (!transport) { res.status(400).send("Invalid session"); return; }
  await transport.handleRequest(req, res);
};

app.get("/mcp", handleSession);    // SSE stream endpoint :contentReference[oaicite:6]{index=6}
app.delete("/mcp", handleSession);

app.use((req, _res, next) => {
  console.log(`${req.method} ${req.path} sid=${req.headers["mcp-session-id"] ?? "-"}`);
  next();
});

app.listen(3000, () => console.log("MCP Streamable‑HTTP server on :3000"));
