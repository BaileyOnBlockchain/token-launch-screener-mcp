/**
 * Token Launch Screener — MCP Server Entry Point
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContextMiddleware } from "@ctxprotocol/sdk";
import express, { Request, Response } from "express";
import { z } from "zod";
import { screenToken } from "./tools/screen_token.js";

// ─── Server Initialisation ────────────────────────────────────────────────────

const server = new McpServer({
  name: "token-launch-screener-mcp-server",
  version: "1.0.0",
});

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY ?? "";

// ─── Input Schema ─────────────────────────────────────────────────────────────

const screenInputSchema = {
  contract_address: z
    .string()
    .regex(
      /^0x[a-fA-F0-9]{40}$/,
      "Must be a valid EVM address: '0x' followed by exactly 40 hex characters"
    )
    .describe(
      "EVM token contract address to screen. Example: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    ),
  chain: z
    .string()
    .describe(
      "Target chain. Accepts name or ID: ethereum (1), base (8453), bsc (56), polygon (137), arbitrum (42161), optimism (10). Default: base"
    ),
};

// ─── Tool Registration ────────────────────────────────────────────────────────

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

RETURNS:
{
  contract_address, chain, screened_at, token_name, token_symbol, decimals,
  contract_age_hours, deployer_address, deployer_previous_contracts, deployer_flagged,
  liquidity_usd, liquidity_locked, is_honeypot, buy_tax_percent, sell_tax_percent,
  is_mintable, has_blacklist, owner_can_change_balance, first_buyers_count,
  sniper_count, bundler_count, sniper_held_percent,
  risk_score: "SAFE" | "CAUTION" | "LIKELY_RUG", risk_flags: string[], summary: string
}

USE WHEN: "Is 0xabc safe to ape?", "Quick rug check on [address]", "Screen this token on base"
SKIP FOR: Tokens older than 7 days`,
    inputSchema: screenInputSchema,
    outputSchema: {
      type: "object" as const,
      properties: {
        contract_address:            { type: "string" },
        chain:                       { type: "string" },
        screened_at:                 { type: "string" },
        token_name:                  { type: "string" },
        token_symbol:                { type: "string" },
        decimals:                    { type: "number" },
        contract_age_hours:          { type: "number" },
        deployer_address:            { type: "string" },
        deployer_previous_contracts: { type: "number" },
        deployer_flagged:            { type: "boolean" },
        liquidity_usd:               { type: "number" },
        liquidity_locked:            { type: "boolean" },
        lock_duration_days:          { type: ["number", "null"] },
        is_honeypot:                 { type: "boolean" },
        buy_tax_percent:             { type: "number" },
        sell_tax_percent:            { type: "number" },
        is_mintable:                 { type: "boolean" },
        is_proxy:                    { type: "boolean" },
        has_blacklist:               { type: "boolean" },
        owner_can_change_balance:    { type: "boolean" },
        first_buyers_count:          { type: "number" },
        sniper_count:                { type: "number" },
        bundler_count:               { type: "number" },
        sniper_held_percent:         { type: "number" },
        risk_score: {
          type: "string",
          enum: ["SAFE", "CAUTION", "LIKELY_RUG"],
        },
        risk_flags: { type: "array", items: { type: "string" } },
        summary:    { type: "string" },
      },
      required: ["contract_address", "chain", "risk_score", "risk_flags", "summary"],
    },
    annotations: {
      readOnlyHint:    true,
      destructiveHint: false,
      idempotentHint:  false,
      openWorldHint:   true,
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
            "⚠️  ETHERSCAN_API_KEY is not set.",
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
      return {
        content: [{
          type: "text" as const,
          text: result.summary + "\n\n" + JSON.stringify(result, null, 2),
        }],
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

// ─── HTTP Transport ───────────────────────────────────────────────────────────

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json());

  // Context Protocol auth middleware — required for paid requests
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

  app.post("/mcp", async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse:  true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT ?? "3000");
  app.listen(port, () => {
    console.log(`🔍 Token Launch Screener MCP running`);
    console.log(`   Endpoint : http://localhost:${port}/mcp`);
    console.log(`   Health   : http://localhost:${port}/health`);
    console.log(`   Etherscan: ${ETHERSCAN_API_KEY ? "✓ configured" : "✗ NOT SET"}`);
  });
}

// ─── stdio Transport ──────────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Token Launch Screener MCP running on stdio");
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

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
