/**
 * Token Launch Screener — MCP Server Entry Point
 */

import 'dotenv/config';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContextMiddleware } from "@ctxprotocol/sdk";
import express, { Request, Response } from "express";
import { z } from "zod";
import { screenToken } from "./tools/screen_token.js";

// ─── Input Schema ────────────────────────────────────────────────────────────

const screenInputSchema = {
  contract_address: z
    .string()
    .regex(
      /^0x[a-fA-F0-9]{40}$/,
      "Must be a valid EVM address: '0x' followed by exactly 40 hex characters"
    )
    .describe(
      "EVM token contract address to screen. Must start with 0x followed by 40 hex characters. Extract directly from user message. Example: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    ),
  chain: z
    .string()
    .optional()
    .default("base")
    .describe(
      "Blockchain to query. Extract from user message if mentioned (e.g. 'on base', 'on ethereum', 'on bsc'). Accepted values: ethereum, base, bsc, polygon, arbitrum, optimism, or numeric chain ID. Defaults to 'base' if not specified."
    ),
};

// ─── Output Schema ───────────────────────────────────────────────────────────
// Only primitive Zod types that map 1:1 to JSON Schema primitives.
// No z.record(), z.unknown(), z.any(), or z.passthrough() — these produce
// ambiguous additionalProperties:{} that CTX Protocol's probe cannot validate.

const screenOutputSchema = {
  verdict: z
    .enum(["SAFE", "RISKY", "CRITICAL"])
    .describe("Overall risk verdict for the token"),
  risk_score: z
    .number()
    .min(0)
    .max(100)
    .describe("Numeric risk score from 0 (safe) to 100 (critical)"),
  token_address: z
    .string()
    .describe("The contract address that was screened"),
  chain: z
    .string()
    .describe("The blockchain that was queried"),
  flags: z
    .array(z.string())
    .describe("List of specific risk flags detected during screening"),
  summary: z
    .string()
    .describe("Human-readable risk assessment summary"),
  goplus_source: z
    .string()
    .describe("Raw JSON string of GoPlus security API response data"),
  dexscreener_source: z
    .string()
    .describe("Raw JSON string of DexScreener pair/liquidity API response data"),
  etherscan_source: z
    .string()
    .describe("Raw JSON string of Etherscan deployer/buyer analysis data"),
};

// ─── Verdict Helpers ─────────────────────────────────────────────────────────

const VERDICT_MAP: Record<string, "SAFE" | "RISKY" | "CRITICAL"> = {
  SAFE:       "SAFE",
  CAUTION:    "RISKY",
  LIKELY_RUG: "CRITICAL",
};

/** Derives a 0–100 numeric risk score from the categorical verdict + flag count. */
function toNumericScore(riskScore: string, flagCount: number): number {
  if (riskScore === "LIKELY_RUG") return Math.min(100, 75 + flagCount * 5);
  if (riskScore === "CAUTION")    return Math.min(65,  40 + flagCount * 5);
  return Math.min(30, flagCount * 8);
}

// ─── Server Factory ──────────────────────────────────────────────────────────
//
// A fresh McpServer is created per HTTP request (stateless mode).
// The MCP SDK throws "Already connected" if server.connect() is called twice on
// the same instance, which would break the platform's initialize → tools/list
// two-step handshake.  Creating one instance per request avoids that entirely.

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY ?? "";

function createMcpServer(): McpServer {
  const server = new McpServer({
    name:    "token-launch-screener-mcp-server",
    version: "1.0.0",
  });

  // @ts-ignore — TS2589: false positive with MCP SDK v1.29 generic inference depth
  server.registerTool(
    "screen_new_token",
    {
      title: "Token Launch Risk Screener",
      description: `Real-time due diligence on a newly launched EVM token. Aggregates GoPlus Security, DexScreener, and Etherscan V2 into a single risk verdict in under 30 seconds.

Replaces the manual workflow of checking DexScreener + DEXTools Pro + Token Sniffer + Etherscan separately ($99/month combined). Returns structured, actionable data from one call.

WHAT IT CHECKS:
- Honeypot detection and buy/sell tax (GoPlus — no API key required, very reliable)
- Liquidity size and lock status (DexScreener)
- Contract age and deployer serial-launcher history (Etherscan V2)
- First 50 buyer wallets — flagged for sniper/bundler patterns (Etherscan V2)
- Composite risk verdict: SAFE / CAUTION / LIKELY_RUG

ARGS:
  contract_address (string, required) — EVM contract address starting with 0x
  chain (string, optional)            — Chain name or ID. Default: "base"

USE WHEN: user provides a 0x contract address and asks to screen/check/rug-check/analyze it. Trigger phrases: "screen this token", "rug check", "is this safe", "check this contract", "analyze this token". Extract contract_address (the 0x... address) and chain (the network name if mentioned, otherwise default to base).
SKIP FOR: Tokens older than 7 days, general crypto questions without a specific address`,
      inputSchema:  screenInputSchema,
      outputSchema: screenOutputSchema,
      annotations: {
        readOnlyHint:    true,
        destructiveHint: false,
        idempotentHint:  false,
        openWorldHint:   true,
      },
      // CTX Protocol metadata — surface + eligibility required for probe routing
      _meta: {
        surface:          "execute",
        executeEligible:  true,
        queryEligible:    false,
        latencyClass:     "fast",
        pricing:          { executeUsd: "0.0005" },
      },
    },
    // @ts-ignore
    async (params: any) => {
      const contract_address: string = params.contract_address;
      const resolvedChain: string = params.chain ?? "base";

      if (!ETHERSCAN_API_KEY) {
        return {
          content: [{
            type: "text" as const,
            text: [
              "ETHERSCAN_API_KEY is not set.",
              "",
              "GoPlus and DexScreener data will still be returned, but chain history,",
              "deployer analysis, and sniper detection require an Etherscan V2 key.",
              "",
              "Get a free key at: https://etherscan.io/apikey",
              "Then set: ETHERSCAN_API_KEY=your_key in your .env file and restart.",
            ].join("\n"),
          }],
          isError: true,
        };
      }

      try {
        const result = await screenToken(contract_address, resolvedChain, ETHERSCAN_API_KEY);

        // Build structured output — every field matches screenOutputSchema exactly.
        // Source data is serialised to JSON strings so the schema stays flat
        // (no z.record / z.unknown / z.any needed).
        const structured = {
          verdict:              VERDICT_MAP[result.risk_score] ?? "RISKY",
          risk_score:           toNumericScore(result.risk_score, result.risk_flags.length),
          token_address:        result.contract_address,
          chain:                result.chain,
          flags:                result.risk_flags,
          summary:              result.summary,
          goplus_source:        JSON.stringify({
            is_honeypot:            result.is_honeypot,
            buy_tax_percent:        result.buy_tax_percent,
            sell_tax_percent:       result.sell_tax_percent,
            is_mintable:            result.is_mintable,
            is_proxy:               result.is_proxy,
            has_blacklist:          result.has_blacklist,
            owner_can_change_balance: result.owner_can_change_balance,
          }),
          dexscreener_source:   JSON.stringify({
            liquidity_usd:      result.liquidity_usd,
            liquidity_locked:   result.liquidity_locked,
            lock_duration_days: result.lock_duration_days,
          }),
          etherscan_source:     JSON.stringify({
            contract_age_hours:          result.contract_age_hours,
            deployer_address:            result.deployer_address,
            deployer_previous_contracts: result.deployer_previous_contracts,
            deployer_flagged:            result.deployer_flagged,
            first_buyers_count:          result.first_buyers_count,
            sniper_count:                result.sniper_count,
            bundler_count:               result.bundler_count,
            sniper_held_percent:         result.sniper_held_percent,
          }),
        };

        return {
          content: [{
            type: "text" as const,
            text: result.summary + "\n\n" + JSON.stringify(structured, null, 2),
          }],
          structuredContent: structured,
          // @ts-ignore — _meta is a CTX Protocol extension for per-call pricing
          _meta: { pricing: { executeUsd: 0.0005 } },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text" as const,
            text: `Error screening ${contract_address} on ${resolvedChain}: ${message}`,
          }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// ─── HTTP Transport ──────────────────────────────────────────────────────────

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json());

  // Context Protocol auth middleware — validates Bearer tokens on protected methods
  // (tools/call).  initialize and tools/list are open methods and pass through.
  app.use(createContextMiddleware());

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status:  "ok",
      server:  "token-launch-screener-mcp-server",
      version: "1.0.0",
      uptime:  Math.round(process.uptime()),
    });
  });

  app.get("/", (_req: Request, res: Response) => {
    res.json({
      name:        "Token Launch Screener MCP",
      version:     "1.0.0",
      description: "Real-time EVM token risk screening — GoPlus + DexScreener + Etherscan",
      endpoint:    "POST /mcp",
      health:      "GET /health",
    });
  });

  // Each request gets its own McpServer + transport instance (stateless).
  // This is required because McpServer.connect() can only be called once per
  // instance; reusing the server across requests causes "Already connected"
  // errors that break the platform's initialize → tools/list handshake.
  app.post("/mcp", async (req: Request, res: Response) => {
    // StreamableHTTPServerTransport requires Accept to include both content types.
    // Some clients (including the CTX probe) omit text/event-stream, which causes
    // a -32000 "Not Acceptable" error before the request reaches the tool list.
    if (!req.headers.accept?.includes("text/event-stream")) {
      req.headers.accept = "application/json, text/event-stream";
    }

    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,   // stateless — no session tracking
      enableJsonResponse:  true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT ?? "3000");
  app.listen(port, () => {
    process.stderr.write(`Token Launch Screener MCP running\n`);
    process.stderr.write(`   Endpoint : http://localhost:${port}/mcp\n`);
    process.stderr.write(`   Health   : http://localhost:${port}/health\n`);
    process.stderr.write(`   Etherscan: ${ETHERSCAN_API_KEY ? "configured" : "NOT SET"}\n`);
  });
}

// ─── stdio Transport ─────────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Token Launch Screener MCP running on stdio");
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

const transportMode = process.env.TRANSPORT ?? "http";

if (transportMode === "http") {
  runHTTP().catch((err) => {
    console.error("Fatal server error:", err);
    process.exit(1);
  });
} else {
  runStdio().catch((err) => {
    console.error("Fatal server error:", err);
    process.exit(1);
  });
}
