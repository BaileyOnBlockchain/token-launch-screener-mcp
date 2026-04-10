/**
 * Token Launch Screener MCP — External API Clients
 *
 * Three data sources, all with graceful fallback on failure:
 *   • DexScreener  – liquidity, pair creation time, price
 *   • GoPlus       – honeypot check, tax, ownership flags (no API key required)
 *   • Etherscan V2 – deployer history, early buyers, sniper detection
 *
 * Design principle: every function returns null / [] / 0 on error rather than
 * throwing. The screener builds its verdict from whatever data is available.
 */
import { DexScreenerPair, GoPlusTokenSecurity } from "../types.js";
/**
 * Resolves a chain name or raw ID to a numeric chain ID string.
 * e.g. "base" → "8453", "137" → "137"
 */
export declare function resolveChainId(chain: string): string;
/**
 * Fetches the highest-liquidity trading pair for a token from DexScreener.
 * Returns null if the token has no pairs or the request fails.
 */
export declare function getDexScreenerData(contractAddress: string): Promise<DexScreenerPair | null>;
/**
 * Fetches on-chain security analysis from GoPlus Labs.
 * Covers: honeypot detection, buy/sell tax, mintability, blacklist, ownership.
 * No API key required — completely free.
 */
export declare function getGoPlusTokenSecurity(chainId: string, contractAddress: string): Promise<GoPlusTokenSecurity | null>;
/**
 * Retrieves the contract deployer address and deployment timestamp.
 */
export declare function getContractCreationTx(chainId: string, contractAddress: string, apiKey: string): Promise<{
    deployer: string;
    timestamp: number;
} | null>;
/**
 * Counts how many contracts the deployer has previously deployed.
 * High count (>3) is a strong serial-launcher signal.
 */
export declare function getDeployerPreviousContracts(chainId: string, deployerAddress: string, apiKey: string): Promise<number>;
/**
 * Returns the first 50 unique buyer wallet addresses from token transfer history.
 * Earlier wallets = higher sniper suspicion.
 */
export declare function getEarlyBuyers(chainId: string, contractAddress: string, apiKey: string): Promise<string[]>;
/**
 * Heuristic sniper/bundler detection based on wallet transaction history.
 *
 * Snipers:  < 5 lifetime transactions (brand-new wallet = classic sniper setup)
 * Bundlers: 5–14 lifetime transactions (low-volume wallet = likely multi-wallet bundler)
 *
 * Checks up to SNIPER_SAMPLE_SIZE wallets in parallel to stay within latency budget.
 */
export declare function flagSniperWallets(chainId: string, wallets: string[], apiKey: string): Promise<{
    snipers: string[];
    bundlers: string[];
}>;
//# sourceMappingURL=apis.d.ts.map