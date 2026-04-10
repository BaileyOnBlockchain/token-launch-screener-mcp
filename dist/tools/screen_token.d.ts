/**
 * Token Launch Screener MCP — Core Screening Logic
 *
 * Orchestrates all three data sources (DexScreener, GoPlus, Etherscan) in
 * parallel, applies risk heuristics, and produces a single structured verdict.
 *
 * Risk model:
 *   LIKELY_RUG – one or more definitive red flags (honeypot, owner drains, etc.)
 *   CAUTION     – multiple warning signals without hard proof of malice
 *   SAFE        – no significant flags detected
 */
import { TokenScreenResult } from "../types.js";
/**
 * Runs the full token screening pipeline and returns a structured risk verdict.
 * All external calls are parallelised. Partial data is handled gracefully.
 *
 * @param contractAddress - EVM contract address (0x...)
 * @param chain           - Chain name ("base", "ethereum") or raw chain ID
 * @param etherscanKey    - Etherscan V2 API key
 */
export declare function screenToken(contractAddress: string, chain: string, etherscanKey: string): Promise<TokenScreenResult>;
//# sourceMappingURL=screen_token.d.ts.map