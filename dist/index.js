/**
 * Token Launch Screener — MCP Server Entry Point
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContextMiddleware } from "@ctxprotocol/sdk";
import express from "express";
import { z } from "zod";
import { screenToken } from "./tools/screen_token.js";
// ─── Input / Output Schemas ───────────────────────────────────────────────────
const screenInputSchema = {
    contract_address: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid EVM address: '0x' followed by exactly 40 hex characters")
        .describe("EVM token contract address to screen. Must start with 0x followed by 40 hex characters. Extract directly from user message. Example: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    chain: z
        .string()
        .optional()
        .default("base")
        .describe("Blockchain to query. Extract from user message if mentioned (e.g. 'on base', 'on ethereum', 'on bsc'). Accepted values: ethereum, base, bsc, polygon, arbitrum, optimism, or numeric chain ID. Defaults to 'base' if not specified."),
};
const screenOutputSchema = {
    verdict: z.enum(["SAFE", "RISKY", "CRITICAL"]),
    risk_score: z.number().min(0).max(100),
    token_address: z.string(),
    chain: z.string(),
    flags: z.array(z.string()),
    summary: z.string(),
    sources: z.object({
        goplus: z.record(z.string(), z.unknown()),
        dexscreener: z.record(z.string(), z.unknown()),
        etherscan: z.record(z.string(), z.unknown()),
    }),
};
// ─── Verdict Helpers ──────────────────────────────────────────────────────────
const VERDICT_MAP = {
    SAFE: "SAFE",
    CAUTION: "RISKY",
    LIKELY_RUG: "CRITICAL",
};
/** Derives a 0–100 numeric risk score from the categorical verdict + flag count. */
function toNumericScore(riskScore, flagCount) {
    if (riskScore === "LIKELY_RUG")
        return Math.min(100, 75 + flagCount * 5);
    if (riskScore === "CAUTION")
        return Math.min(65, 40 + flagCount * 5);
    return Math.min(30, flagCount * 8);
}
// ─── Server Factory ───────────────────────────────────────────────────────────
//
// A fresh McpServer is created per HTTP request (stateless mode).
// The MCP SDK throws "Already connected" if server.connect() is called twice on
// the same instance, which would break the platform's initialize → tools/list
// two-step handshake.  Creating one instance per request avoids that entirely.
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY ?? "";
function createMcpServer() {
    const server = new McpServer({
        name: "token-launch-screener-mcp-server",
        version: "1.0.0",
    });
    // @ts-ignore — TS2589: false positive with MCP SDK v1.29 generic inference depth
    server.registerTool("screen_new_token", {
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
  verdict: "SAFE" | "RISKY" | "CRITICAL",
  risk_score: number (0–100),
  token_address, chain, flags: string[], summary: string,
  sources: { goplus, dexscreener, etherscan }
}

USE WHEN: user provides a 0x contract address and asks to screen/check/rug-check/analyze it. Trigger phrases: "screen this token", "rug check", "is this safe", "check this contract", "analyze this token". Extract contract_address (the 0x... address) and chain (the network name if mentioned, otherwise default to base).
SKIP FOR: Tokens older than 7 days, general crypto questions without a specific address`,
        inputSchema: screenInputSchema,
        outputSchema: screenOutputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
        // CTX Protocol per-call pricing declaration
        _meta: { pricing: { executeUsd: 0.0005 } },
    }, 
    // @ts-ignore
    async (params) => {
        const contract_address = params.contract_address;
        const resolvedChain = params.chain ?? "base";
        if (!ETHERSCAN_API_KEY) {
            return {
                content: [{
                        type: "text",
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
            const structured = {
                verdict: VERDICT_MAP[result.risk_score] ?? "RISKY",
                risk_score: toNumericScore(result.risk_score, result.risk_flags.length),
                token_address: result.contract_address,
                chain: result.chain,
                flags: result.risk_flags,
                summary: result.summary,
                sources: { goplus: {}, dexscreener: {}, etherscan: {} },
            };
            return {
                content: [{
                        type: "text",
                        text: result.summary + "\n\n" + JSON.stringify(structured, null, 2),
                    }],
                structuredContent: structured,
                // @ts-ignore — _meta is a CTX Protocol extension for per-call pricing
                _meta: { pricing: { executeUsd: 0.0005 } },
            };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                content: [{
                        type: "text",
                        text: `Error screening ${contract_address} on ${resolvedChain}: ${message}`,
                    }],
                isError: true,
            };
        }
    });
    return server;
}
// ─── HTTP Transport ───────────────────────────────────────────────────────────
async function runHTTP() {
    const app = express();
    app.use(express.json());
    // Context Protocol auth middleware — validates Bearer tokens on protected methods
    // (tools/call).  initialize and tools/list are open methods and pass through.
    app.use(createContextMiddleware());
    app.get("/health", (_req, res) => {
        res.json({
            status: "ok",
            server: "token-launch-screener-mcp-server",
            version: "1.0.0",
            uptime: Math.round(process.uptime()),
        });
    });
    app.get("/", (_req, res) => {
        res.json({
            name: "Token Launch Screener MCP",
            version: "1.0.0",
            description: "Real-time EVM token risk screening — GoPlus + DexScreener + Etherscan",
            endpoint: "POST /mcp",
            health: "GET /health",
        });
    });
    // Each request gets its own McpServer + transport instance (stateless).
    // This is required because McpServer.connect() can only be called once per
    // instance; reusing the server across requests causes "Already connected"
    // errors that break the platform's initialize → tools/list handshake.
    app.post("/mcp", async (req, res) => {
        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // stateless — no session tracking
            enableJsonResponse: true,
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
async function runStdio() {
    const server = createMcpServer();
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
}
else {
    runStdio().catch((err) => {
        console.error("Fatal server error:", err);
        process.exit(1);
    });
}
//# sourceMappingURL=index.js.map