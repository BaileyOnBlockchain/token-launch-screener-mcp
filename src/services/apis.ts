/**
 * Token Launch Screener MCP — External API Clients
 *
 * Three data sources, all with graceful fallback on failure:
 *   • DexScreener  – liquidity, pair creation time, price
 *   • GoPlus       – honeypot check, tax, ownership flags (no API key required)
 *   • Block Explorers – deployer history, early buyers, sniper detection
 *
 * Each chain uses its own Etherscan-compatible explorer API (same format, different
 * base URL and API key). Ethereum uses Etherscan V2; Base uses BaseScan; BSC uses
 * BscScan; etc.
 *
 * Design principle: every function returns null / [] / 0 on error rather than
 * throwing. The screener builds its verdict from whatever data is available.
 */

import axios, { AxiosResponse } from "axios";
import {
  DexScreenerPair,
  GoPlusTokenSecurity,
  EtherscanTx,
  ContractCreationResult,
} from "../types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 10_000;
const SNIPER_SAMPLE_SIZE = 20; // Max wallets to deep-check (keeps latency under 30s)

// ─── Chain Explorer Configuration ────────────────────────────────────────────

interface ExplorerEntry {
  url:         string;
  envKey:      string;
  // Etherscan V2 is a unified multi-chain endpoint that requires ?chainid=N.
  // Chain-specific explorers (BaseScan, BscScan, etc.) don't accept chainid.
  passChainId: boolean;
}

/**
 * Maps numeric chain IDs to their block explorer config.
 * Etherscan V2 is a unified endpoint that covers all 60+ EVM chains with one
 * API key — just pass the correct chainid parameter per request.
 */
const CHAIN_EXPLORER_MAP: Record<string, ExplorerEntry> = {
  "1":     { url: "https://api.etherscan.io/v2/api", envKey: "ETHERSCAN_API_KEY", passChainId: true },
  "8453":  { url: "https://api.etherscan.io/v2/api", envKey: "ETHERSCAN_API_KEY", passChainId: true },
  "56":    { url: "https://api.etherscan.io/v2/api", envKey: "ETHERSCAN_API_KEY", passChainId: true },
  "137":   { url: "https://api.etherscan.io/v2/api", envKey: "ETHERSCAN_API_KEY", passChainId: true },
  "42161": { url: "https://api.etherscan.io/v2/api", envKey: "ETHERSCAN_API_KEY", passChainId: true },
  "10":    { url: "https://api.etherscan.io/v2/api", envKey: "ETHERSCAN_API_KEY", passChainId: true },
  "43114": { url: "https://api.etherscan.io/v2/api", envKey: "ETHERSCAN_API_KEY", passChainId: true },
};

/** Human-readable chain name → numeric chain ID */
const CHAIN_ID_MAP: Record<string, string> = {
  ethereum: "1",
  eth:      "1",
  base:     "8453",
  bsc:      "56",
  bnb:      "56",
  polygon:  "137",
  matic:    "137",
  arbitrum: "42161",
  arb:      "42161",
  optimism: "10",
  op:       "10",
  avalanche:"43114",
  avax:     "43114",
};

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Resolves a chain name or raw ID to a numeric chain ID string.
 * e.g. "base" → "8453", "137" → "137"
 */
export function resolveChainId(chain: string): string {
  return CHAIN_ID_MAP[chain.toLowerCase()] ?? chain;
}

interface ResolvedExplorer {
  url:         string;
  key:         string;
  passChainId: boolean;
}

/** Looks up the explorer URL + API key for the given chain ID. Returns null if no key is configured. */
function resolveExplorer(chainId: string): ResolvedExplorer | null {
  const entry = CHAIN_EXPLORER_MAP[chainId];
  if (!entry) return null;
  const key = process.env[entry.envKey] ?? "";
  if (!key) return null;
  return { url: entry.url, key, passChainId: entry.passChainId };
}

/** Returns true if a block explorer API key is configured for this chain. */
export function hasExplorerKey(chainId: string): boolean {
  return resolveExplorer(chainId) !== null;
}

/** Returns the chain IDs that have explorer API keys set in the environment. */
export function getConfiguredChains(): string[] {
  return Object.entries(CHAIN_EXPLORER_MAP)
    .filter(([, entry]) => !!process.env[entry.envKey])
    .map(([chainId]) => chainId);
}

// ─── DexScreener ─────────────────────────────────────────────────────────────

/**
 * Fetches the highest-liquidity trading pair for a token from DexScreener.
 * Returns null if the token has no pairs or the request fails.
 */
export async function getDexScreenerData(
  contractAddress: string
): Promise<DexScreenerPair | null> {
  try {
    const res: AxiosResponse<{ pairs: DexScreenerPair[] }> = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`,
      { timeout: TIMEOUT_MS }
    );

    const pairs = res.data?.pairs;
    if (!pairs?.length) return null;

    // Return the pair with the deepest liquidity — most relevant for risk assessment
    return pairs.sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
    )[0];
  } catch {
    return null;
  }
}

// ─── GoPlus Security API ──────────────────────────────────────────────────────

/**
 * Fetches on-chain security analysis from GoPlus Labs.
 * Covers: honeypot detection, buy/sell tax, mintability, blacklist, ownership.
 * No API key required — completely free.
 */
export async function getGoPlusTokenSecurity(
  chainId: string,
  contractAddress: string
): Promise<GoPlusTokenSecurity | null> {
  try {
    const res: AxiosResponse<{
      result: Record<string, GoPlusTokenSecurity>;
      code: number;
      message: string;
    }> = await axios.get(
      `https://api.gopluslabs.io/api/v1/token_security/${chainId}`,
      {
        params: { contract_addresses: contractAddress.toLowerCase() },
        timeout: TIMEOUT_MS,
      }
    );

    // GoPlus returns code 1 for success
    if (res.data.code !== 1) return null;

    return res.data.result[contractAddress.toLowerCase()] ?? null;
  } catch {
    return null;
  }
}

// ─── Block Explorer APIs ──────────────────────────────────────────────────────
//
// All four functions below use the Etherscan-compatible API format shared by
// BaseScan, BscScan, PolygonScan, Arbiscan, etc. The correct endpoint and API
// key are resolved automatically from the chain ID via CHAIN_EXPLORER_MAP.

/**
 * Retrieves the contract deployer address and deployment timestamp.
 */
export async function getContractCreationTx(
  chainId: string,
  contractAddress: string
): Promise<{ deployer: string; timestamp: number } | null> {
  const explorer = resolveExplorer(chainId);
  if (!explorer) return null;

  try {
    const params: Record<string, string | number> = {
      module:            "contract",
      action:            "getcontractcreation",
      contractaddresses: contractAddress,
      apikey:            explorer.key,
    };
    if (explorer.passChainId) params.chainid = chainId;

    const res: AxiosResponse<{ result: ContractCreationResult[] }> =
      await axios.get(explorer.url, { params, timeout: TIMEOUT_MS });

    const record = res.data?.result?.[0];
    if (!record) return null;

    return {
      deployer: record.contractCreator ?? "",
      // getcontractcreation doesn't include timestamp on all explorers —
      // we derive rough age from pairCreatedAt in DexScreener as fallback
      timestamp: record.timestamp ? parseInt(record.timestamp) * 1000 : Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Counts how many contracts the deployer has previously deployed.
 * High count (>3) is a strong serial-launcher signal.
 */
export async function getDeployerPreviousContracts(
  chainId: string,
  deployerAddress: string
): Promise<number> {
  const explorer = resolveExplorer(chainId);
  if (!explorer) return 0;

  try {
    const params: Record<string, string | number> = {
      module:  "account",
      action:  "txlist",
      address: deployerAddress,
      sort:    "asc",
      apikey:  explorer.key,
      page:    1,
      offset:  100,
    };
    if (explorer.passChainId) params.chainid = chainId;

    const res: AxiosResponse<{ result: EtherscanTx[] }> =
      await axios.get(explorer.url, { params, timeout: TIMEOUT_MS });

    const txs = res.data?.result ?? [];
    // Contract creation txs have an empty "to" field
    return txs.filter((tx) => !tx.to || tx.to === "").length;
  } catch {
    return 0;
  }
}

/**
 * Returns the first 50 unique buyer wallet addresses from token transfer history.
 * Earlier wallets = higher sniper suspicion.
 */
export async function getEarlyBuyers(
  chainId: string,
  contractAddress: string
): Promise<string[]> {
  const explorer = resolveExplorer(chainId);
  if (!explorer) return [];

  try {
    const params: Record<string, string | number> = {
      module:          "account",
      action:          "tokentx",
      contractaddress: contractAddress,
      sort:            "asc",
      apikey:          explorer.key,
      page:            1,
      offset:          200,
    };
    if (explorer.passChainId) params.chainid = chainId;

    const res: AxiosResponse<{ result: EtherscanTx[] }> =
      await axios.get(explorer.url, { params, timeout: TIMEOUT_MS });

    const txs = res.data?.result ?? [];
    const buyers = new Set<string>();

    for (const tx of txs) {
      // Exclude the contract itself from buyer set
      if (tx.to && tx.to.toLowerCase() !== contractAddress.toLowerCase()) {
        buyers.add(tx.to.toLowerCase());
      }
      if (buyers.size >= 50) break;
    }

    return Array.from(buyers);
  } catch {
    return [];
  }
}

/**
 * Heuristic sniper/bundler detection based on wallet transaction history.
 *
 * Snipers:  < 5 lifetime transactions (brand-new wallet = classic sniper setup)
 * Bundlers: 5–14 lifetime transactions (low-volume wallet = likely multi-wallet bundler)
 *
 * Checks up to SNIPER_SAMPLE_SIZE wallets in parallel to stay within latency budget.
 */
export async function flagSniperWallets(
  chainId: string,
  wallets: string[]
): Promise<{ snipers: string[]; bundlers: string[] }> {
  const explorer = resolveExplorer(chainId);
  if (!explorer) return { snipers: [], bundlers: [] };

  const snipers: string[] = [];
  const bundlers: string[] = [];

  const sample = wallets.slice(0, SNIPER_SAMPLE_SIZE);

  await Promise.allSettled(
    sample.map(async (wallet) => {
      try {
        const params: Record<string, string | number> = {
          module:  "account",
          action:  "txlist",
          address: wallet,
          sort:    "asc",
          apikey:  explorer.key,
          page:    1,
          offset:  20,
        };
        if (explorer.passChainId) params.chainid = chainId;

        const res: AxiosResponse<{ result: EtherscanTx[] }> =
          await axios.get(explorer.url, { params, timeout: 5_000 });

        const txCount = res.data?.result?.length ?? 0;
        if (txCount < 5) snipers.push(wallet);
        else if (txCount < 15) bundlers.push(wallet);
      } catch {
        // Skip individual wallet — don't fail the whole batch
      }
    })
  );

  return { snipers, bundlers };
}
