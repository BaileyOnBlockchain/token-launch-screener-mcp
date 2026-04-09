/**
 * Token Launch Screener — MCP Server Entry Point
 *
 * Exposes a single MCP tool: screen_new_token
 *
 * Aggregates GoPlus Security, DexScreener, and Etherscan V2 into one
 * composite risk verdict for newly launched EVM tokens. Replaces the manual
 * workflow of checking 4–5 sites before entering a position.
 *
 * Transport: Streamable HTTP (default) or stdio (set TRANSPORT=stdio)
 * Port:      3000 (override with PORT env var)
 *
 * Environment variables:
 *   ETHERSCAN_API_KEY  - Required. Etherscan V2 API key (etherscan.io/apikey)
 *   PORT               - Optional. HTTP port (default: 3000)
 *   TRANSPORT          - Optional. "http" | "stdio" (default: "http")
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
// @ts-ignore — TS2589: MCP SDK v1.29 generic inference depth false positive
server.registerTool(
  "screen_new_token",
  {
    title: "Token Launch Risk Screener",
    description: `Real-time due diligence on a newly launched EVM token. Aggregates GoPlus Security, DexScreener, and Etherscan V2 into a single risk verdict in under 30 seconds.

Replaces the manual workflow of checking DexScreener + DEXTools Pro + Token Sniffer + Etherscan separately ($99/month combined). Returns structured, actionable data from one call.

WHAT IT CHECKS:
• Honeypot detection and buy/sell tax (GoPlus — no API key required, very reliable)
• Liquidity size and lock status (DexScreener)
• Contract age and deployer serial-launcher history (Etherscan V2)
• First 50 buyer wallets — flagged for sniper/bundler patterns (Etherscan V2)
• Composite risk verdict: SAFE / CAUTION / LIKELY_RUG

ARGS:
  contract_address (string, required) — EVM contract address starting with 0x
  chain (string, optional)            — Chain name or ID. Default: "base"

RETURNS:
{
  contract_address:            string,
  chain:                       string,
  screened_at:                 string,   // ISO 8601 timestamp
  token_name:                  string,
  token_symbol:                string,
  decimals:                    number,
  contract_age_hours:          number,
  deployer_address:            string,
  deployer_previous_contracts: number,
  deployer_flagged:            boolean,  // true = serial launcher detected
  liquidity_usd:               number,
  liquidity_locked:            boolean,
  is_honeypot:                 boolean,
  buy_tax_percent:             number,
  sell_tax_percent:            number,
  is_mintable:                 boolean,
  has_blacklist:               boolean,
  owner_can_change_balance:    boolean,
  first_buyers_count:          number,
  sniper_count:                number,
  bundler_count:               number,
  sniper_held_percent:         number,   // % of early buyers flagged as snipers
  risk_score:                  "SAFE" | "CAUTION" | "LIKELY_RUG",
  risk_flags:                  string[], // Plain-English list of triggered flags
  summary:                     string    // Human-readable one-block verdict
}

USE WHEN: "Is 0xabc safe to ape?", "Quick rug check on [address]", "Screen this token on base", "Sniper check [contract]"
SKIP FOR: Tokens older than 7 days (use a fundamentals tool instead)`,
    inputSchema: screenInputSchema,
    annotations: {
      readOnlyHint:    true,
      destructiveHint: false,
      idempotentHint:  false,
      openWorldHint:   true,
    },
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  /** Health check — used by Railway / Render / Fly.io for uptime monitoring */
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

  /** MCP endpoint — stateless per-request transport */
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
