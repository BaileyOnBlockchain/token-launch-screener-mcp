/**
 * Token Launch Screener MCP — Type Definitions
 *
 * Central type file for all data structures flowing through the screener.
 * Keep this the single source of truth — no inline type definitions elsewhere.
 */
/** Final structured output returned by the screen_new_token tool */
export interface TokenScreenResult {
    contract_address: string;
    chain: string;
    screened_at: string;
    token_name: string;
    token_symbol: string;
    decimals: number;
    contract_age_hours: number;
    deployer_address: string;
    deployer_previous_contracts: number;
    deployer_flagged: boolean;
    liquidity_usd: number;
    liquidity_locked: boolean;
    lock_duration_days: number | null;
    is_honeypot: boolean;
    buy_tax_percent: number;
    sell_tax_percent: number;
    is_mintable: boolean;
    is_proxy: boolean;
    has_blacklist: boolean;
    owner_can_change_balance: boolean;
    first_buyers_count: number;
    sniper_count: number;
    bundler_count: number;
    sniper_held_percent: number;
    risk_score: RiskScore;
    risk_flags: string[];
    summary: string;
}
export type RiskScore = "SAFE" | "CAUTION" | "LIKELY_RUG";
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
    pairCreatedAt?: number;
    txns?: {
        h24: {
            buys: number;
            sells: number;
        };
    };
}
export interface GoPlusTokenSecurity {
    is_honeypot: string;
    buy_tax: string;
    sell_tax: string;
    is_mintable: string;
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
export interface EtherscanTx {
    from: string;
    to: string;
    timeStamp: string;
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
//# sourceMappingURL=types.d.ts.map