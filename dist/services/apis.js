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
import axios from "axios";
// ─── Constants ────────────────────────────────────────────────────────────────
const TIMEOUT_MS = 10000;
const SNIPER_SAMPLE_SIZE = 20; // Max wallets to deep-check (keeps latency under 30s)
/** Etherscan V2 unified endpoint — one key covers Ethereum mainnet */
const ETHERSCAN_V2 = "https://api.etherscan.io/v2/api";
/** Human-readable chain name → numeric chain ID */
const CHAIN_ID_MAP = {
    ethereum: "1",
    eth: "1",
    base: "8453",
    bsc: "56",
    bnb: "56",
    polygon: "137",
    matic: "137",
    arbitrum: "42161",
    arb: "42161",
    optimism: "10",
    op: "10",
    avalanche: "43114",
    avax: "43114",
};
// ─── Utility ──────────────────────────────────────────────────────────────────
/**
 * Resolves a chain name or raw ID to a numeric chain ID string.
 * e.g. "base" → "8453", "137" → "137"
 */
export function resolveChainId(chain) {
    return CHAIN_ID_MAP[chain.toLowerCase()] ?? chain;
}
// ─── DexScreener ─────────────────────────────────────────────────────────────
/**
 * Fetches the highest-liquidity trading pair for a token from DexScreener.
 * Returns null if the token has no pairs or the request fails.
 */
export async function getDexScreenerData(contractAddress) {
    try {
        const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`, { timeout: TIMEOUT_MS });
        const pairs = res.data?.pairs;
        if (!pairs?.length)
            return null;
        // Return the pair with the deepest liquidity — most relevant for risk assessment
        return pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    }
    catch {
        return null;
    }
}
// ─── GoPlus Security API ──────────────────────────────────────────────────────
/**
 * Fetches on-chain security analysis from GoPlus Labs.
 * Covers: honeypot detection, buy/sell tax, mintability, blacklist, ownership.
 * No API key required — completely free.
 */
export async function getGoPlusTokenSecurity(chainId, contractAddress) {
    try {
        const res = await axios.get(`https://api.gopluslabs.io/api/v1/token_security/${chainId}`, {
            params: { contract_addresses: contractAddress.toLowerCase() },
            timeout: TIMEOUT_MS,
        });
        // GoPlus returns code 1 for success
        if (res.data.code !== 1)
            return null;
        return res.data.result[contractAddress.toLowerCase()] ?? null;
    }
    catch {
        return null;
    }
}
// ─── Etherscan V2 ─────────────────────────────────────────────────────────────
//
// Note: Etherscan V2 free tier covers Ethereum mainnet (chainId 1).
// For other chains (Base, BSC, etc.) an upgraded plan is required.
// The screener handles partial data gracefully — GoPlus + DexScreener
// still provide core risk signals without Etherscan chain coverage.
/**
 * Retrieves the contract deployer address and deployment timestamp.
 */
export async function getContractCreationTx(chainId, contractAddress, apiKey) {
    try {
        const res = await axios.get(ETHERSCAN_V2, {
            params: {
                chainid: chainId,
                module: "contract",
                action: "getcontractcreation",
                contractaddresses: contractAddress,
                apikey: apiKey,
            },
            timeout: TIMEOUT_MS,
        });
        const record = res.data?.result?.[0];
        if (!record)
            return null;
        return {
            deployer: record.contractCreator ?? "",
            // Etherscan V2 getcontractcreation doesn't include timestamp directly —
            // we derive rough age from pairCreatedAt in DexScreener instead
            timestamp: record.timestamp ? parseInt(record.timestamp) * 1000 : Date.now(),
        };
    }
    catch {
        return null;
    }
}
/**
 * Counts how many contracts the deployer has previously deployed.
 * High count (>3) is a strong serial-launcher signal.
 */
export async function getDeployerPreviousContracts(chainId, deployerAddress, apiKey) {
    try {
        const res = await axios.get(ETHERSCAN_V2, {
            params: {
                chainid: chainId,
                module: "account",
                action: "txlist",
                address: deployerAddress,
                sort: "asc",
                apikey: apiKey,
                page: 1,
                offset: 100,
            },
            timeout: TIMEOUT_MS,
        });
        const txs = res.data?.result ?? [];
        // Contract creation txs have an empty "to" field
        return txs.filter((tx) => !tx.to || tx.to === "").length;
    }
    catch {
        return 0;
    }
}
/**
 * Returns the first 50 unique buyer wallet addresses from token transfer history.
 * Earlier wallets = higher sniper suspicion.
 */
export async function getEarlyBuyers(chainId, contractAddress, apiKey) {
    try {
        const res = await axios.get(ETHERSCAN_V2, {
            params: {
                chainid: chainId,
                module: "account",
                action: "tokentx",
                contractaddress: contractAddress,
                sort: "asc",
                apikey: apiKey,
                page: 1,
                offset: 200,
            },
            timeout: TIMEOUT_MS,
        });
        const txs = res.data?.result ?? [];
        const buyers = new Set();
        for (const tx of txs) {
            // Exclude the contract itself from buyer set
            if (tx.to && tx.to.toLowerCase() !== contractAddress.toLowerCase()) {
                buyers.add(tx.to.toLowerCase());
            }
            if (buyers.size >= 50)
                break;
        }
        return Array.from(buyers);
    }
    catch {
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
export async function flagSniperWallets(chainId, wallets, apiKey) {
    const snipers = [];
    const bundlers = [];
    const sample = wallets.slice(0, SNIPER_SAMPLE_SIZE);
    await Promise.allSettled(sample.map(async (wallet) => {
        try {
            const res = await axios.get(ETHERSCAN_V2, {
                params: {
                    chainid: chainId,
                    module: "account",
                    action: "txlist",
                    address: wallet,
                    sort: "asc",
                    apikey: apiKey,
                    page: 1,
                    offset: 20,
                },
                timeout: 5000,
            });
            const txCount = res.data?.result?.length ?? 0;
            if (txCount < 5)
                snipers.push(wallet);
            else if (txCount < 15)
                bundlers.push(wallet);
        }
        catch {
            // Skip individual wallet — don't fail the whole batch
        }
    }));
    return { snipers, bundlers };
}
//# sourceMappingURL=apis.js.map