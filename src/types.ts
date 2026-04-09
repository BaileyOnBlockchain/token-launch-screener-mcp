/**
 * Token Launch Screener MCP — Type Definitions
 *
 * Central type file for all data structures flowing through the screener.
 * Keep this the single source of truth — no inline type definitions elsewhere.
 */

// ─── Output Schema ────────────────────────────────────────────────────────────

/** Final structured output returned by the screen_new_token tool */
export interface TokenScreenResult {
  // ── Identity
  contract_address: string;
  chain: string;
  screened_at: string; // ISO 8601

  // ── Token metadata
  token_name: string;
  token_symbol: string;
  decimals: number;

  // ── Contract provenance
  contract_age_hours: number;
  deployer_address: string;
  deployer_previous_contracts: number;
  deployer_flagged: boolean; // true = serial launcher detected

  // ── Liquidity
  liquidity_usd: number;
  liquidity_locked: boolean;
  lock_duration_days: number | null; // null = unknown

  // ── Security (GoPlus)
  is_honeypot: boolean;
  buy_tax_percent: number;
  sell_tax_percent: number;
  is_mintable: boolean;
  is_proxy: boolean;
  has_blacklist: boolean;
  owner_can_change_balance: boolean;

  // ── Early buyer intelligence
  first_buyers_count: number;
  sniper_count: number;
  bundler_count: number;
  sniper_held_percent: number; // % of early buyer set identified as snipers

  // ── Verdict
  risk_score: RiskScore;
  risk_flags: string[];
  summary: string; // Human-readable one-block verdict
}

export type RiskScore = "SAFE" | "CAUTION" | "LIKELY_RUG";

// ─── DexScreener ─────────────────────────────────────────────────────────────

export interface DexScreenerPair {
  chainId: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    symbol: string;
  };
  priceUsd: string;
  liquidity?: {
    usd: number;
  };
  pairCreatedAt?: number; // Unix ms
  txns?: {
    h24: {
      buys: number;
      sells: number;
    };
  };
}

// ─── GoPlus Security ─────────────────────────────────────────────────────────

export interface GoPlusTokenSecurity {
  is_honeypot: string;        // "0" | "1"
  buy_tax: string;            // decimal, e.g. "0.05" = 5%
  sell_tax: string;
  is_mintable: string;        // "0" | "1"
  is_proxy: string;
  is_blacklisted: string;
  owner_change_balance: string;
  creator_address: string;
  creator_percent: string;
  holder_count: string;
  lp_holder_count: string;
  lp_total_supply: string;
  is_open_source: string;
  can_take_back_ownership: string;
  token_name: string;
  token_symbol: string;
  decimals: string;
}

// ─── Etherscan V2 ────────────────────────────────────────────────────────────

export interface EtherscanTx {
  from: string;
  to: string;
  timeStamp: string; // Unix seconds string
  hash: string;
  contractAddress: string;
  functionName: string;
}

export interface ContractCreationResult {
  contractCreator: string;
  txHash: string;
  contractAddress: string;
  timestamp?: string;
}
