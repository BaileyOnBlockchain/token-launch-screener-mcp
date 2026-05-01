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

import { TokenScreenResult, RiskScore } from "../types.js";
import {
  getDexScreenerData,
  getGoPlusTokenSecurity,
  getContractCreationTx,
  getDeployerPreviousContracts,
  getEarlyBuyers,
  flagSniperWallets,
  resolveChainId,
  hasExplorerKey,
} from "../services/apis.js";

// ─── Risk Thresholds ──────────────────────────────────────────────────────────

const THRESHOLDS = {
  MIN_LIQUIDITY_USD:         5_000,   // Below this = illiquid / easy rug
  HIGH_TAX_PERCENT:          10,      // Buy or sell tax above this = suspicious
  EXTREME_TAX_PERCENT:       25,      // Likely designed to prevent selling
  SERIAL_LAUNCHER_THRESHOLD: 3,       // Deployer with >3 contracts = pattern risk
  HIGH_SNIPER_PERCENT:       30,      // >30% early buyers are snipers = caution
  EXTREME_SNIPER_PERCENT:    50,      // >50% with serial deployer = likely rug
  NEW_CONTRACT_HOURS:        24,      // < 24h old = elevated risk
  FLAGS_FOR_CAUTION:         3,       // 3+ flags triggers CAUTION minimum
} as const;

// ─── Main Screener ────────────────────────────────────────────────────────────

/**
 * Runs the full token screening pipeline and returns a structured risk verdict.
 * All external calls are parallelised. Partial data is handled gracefully.
 *
 * @param contractAddress - EVM contract address (0x...)
 * @param chain           - Chain name ("base", "ethereum") or raw chain ID
 */
export async function screenToken(
  contractAddress: string,
  chain: string
): Promise<TokenScreenResult> {
  const chainId = resolveChainId(chain);
  const riskFlags: string[] = [];

  // ── Phase 1: Fetch all primary data sources in parallel ──────────────────
  const [dexData, goplusData, creationData] = await Promise.all([
    getDexScreenerData(contractAddress),
    getGoPlusTokenSecurity(chainId, contractAddress),
    getContractCreationTx(chainId, contractAddress),
  ]);

  // ── Token Identity ────────────────────────────────────────────────────────
  const tokenName   = goplusData?.token_name   ?? dexData?.baseToken?.name   ?? "Unknown";
  const tokenSymbol = goplusData?.token_symbol ?? dexData?.baseToken?.symbol ?? "???";
  const decimals    = parseInt(goplusData?.decimals ?? "18");

  // ── Contract Age ──────────────────────────────────────────────────────────
  let deployerAddress  = goplusData?.creator_address ?? "";
  let contractAgeHours = 0;

  if (creationData) {
    if (creationData.deployer) deployerAddress = creationData.deployer;
    contractAgeHours = Math.max(
      0,
      Math.round((Date.now() - creationData.timestamp) / 3_600_000)
    );
  } else if (dexData?.pairCreatedAt) {
    // Fallback: use pair creation time from DexScreener as a proxy
    contractAgeHours = Math.max(
      0,
      Math.round((Date.now() - dexData.pairCreatedAt) / 3_600_000)
    );
  }

  if (contractAgeHours < THRESHOLDS.NEW_CONTRACT_HOURS && contractAgeHours > 0) {
    riskFlags.push(`Contract is only ${contractAgeHours}h old`);
  }

  // ── Phase 2: Deployer History (requires Etherscan coverage) ───────────────
  let deployerPreviousContracts = 0;
  let deployerFlagged = false;

  if (deployerAddress && hasExplorerKey(chainId)) {
    deployerPreviousContracts = await getDeployerPreviousContracts(
      chainId,
      deployerAddress
    );

    if (deployerPreviousContracts > THRESHOLDS.SERIAL_LAUNCHER_THRESHOLD) {
      deployerFlagged = true;
      riskFlags.push(
        `Deployer has launched ${deployerPreviousContracts} previous contracts (serial launcher pattern)`
      );
    }
  }

  // ── Liquidity ─────────────────────────────────────────────────────────────
  const liquidityUsd    = dexData?.liquidity?.usd ?? 0;
  const liquidityLocked = (parseInt(goplusData?.lp_holder_count ?? "0")) > 0;
  const lockDurationDays: number | null = null; // Requires on-chain locker ABI — v2 feature

  if (liquidityUsd < THRESHOLDS.MIN_LIQUIDITY_USD) {
    riskFlags.push(`Low liquidity: $${liquidityUsd.toLocaleString()} (min recommended: $5,000)`);
  }
  if (!liquidityLocked) {
    riskFlags.push("Liquidity is not locked — deployer can pull at any time");
  }

  // ── Security Checks (GoPlus) ──────────────────────────────────────────────
  const isHoneypot           = goplusData?.is_honeypot         === "1";
  const buyTax               = parseFloat(goplusData?.buy_tax  ?? "0") * 100;
  const sellTax              = parseFloat(goplusData?.sell_tax ?? "0") * 100;
  const isMintable           = goplusData?.is_mintable         === "1";
  const isProxy              = goplusData?.is_proxy            === "1";
  const hasBlacklist         = goplusData?.is_blacklisted      === "1";
  const ownerCanChangeBalance = goplusData?.owner_change_balance === "1";

  if (isHoneypot)            riskFlags.push("HONEYPOT DETECTED — tokens cannot be sold");
  if (ownerCanChangeBalance) riskFlags.push("Owner can arbitrarily modify wallet balances");
  if (sellTax > THRESHOLDS.HIGH_TAX_PERCENT)
    riskFlags.push(`High sell tax: ${sellTax.toFixed(1)}%`);
  if (buyTax > THRESHOLDS.HIGH_TAX_PERCENT)
    riskFlags.push(`High buy tax: ${buyTax.toFixed(1)}%`);
  if (isMintable)
    riskFlags.push("Token is mintable — total supply can be inflated post-launch");
  if (hasBlacklist)
    riskFlags.push("Blacklist function present — wallets can be frozen");

  // ── Phase 3: Early Buyer / Sniper Analysis ────────────────────────────────
  const earlyBuyers = hasExplorerKey(chainId)
    ? await getEarlyBuyers(chainId, contractAddress)
    : [];

  const { snipers, bundlers } =
    earlyBuyers.length > 0
      ? await flagSniperWallets(chainId, earlyBuyers)
      : { snipers: [], bundlers: [] };

  const sniperHeldPercent =
    earlyBuyers.length > 0
      ? Math.round((snipers.length / earlyBuyers.length) * 100)
      : 0;

  if (sniperHeldPercent > THRESHOLDS.HIGH_SNIPER_PERCENT) {
    riskFlags.push(
      `${sniperHeldPercent}% of early buyers are fresh wallets (sniper pattern)`
    );
  }

  // ── Risk Scoring ──────────────────────────────────────────────────────────
  const riskScore = computeRiskScore({
    isHoneypot,
    ownerCanChangeBalance,
    sellTax,
    sniperHeldPercent,
    deployerFlagged,
    riskFlagCount: riskFlags.length,
    liquidityLocked,
  });

  const summary = buildSummary(
    tokenName, tokenSymbol, riskScore, riskFlags,
    liquidityUsd, contractAgeHours, snipers.length, earlyBuyers.length
  );

  return {
    contract_address:            contractAddress,
    chain,
    screened_at:                 new Date().toISOString(),
    token_name:                  tokenName,
    token_symbol:                tokenSymbol,
    decimals,
    contract_age_hours:          contractAgeHours,
    deployer_address:            deployerAddress,
    deployer_previous_contracts: deployerPreviousContracts,
    deployer_flagged:            deployerFlagged,
    liquidity_usd:               liquidityUsd,
    liquidity_locked:            liquidityLocked,
    lock_duration_days:          lockDurationDays,
    is_honeypot:                 isHoneypot,
    buy_tax_percent:             buyTax,
    sell_tax_percent:            sellTax,
    is_mintable:                 isMintable,
    is_proxy:                    isProxy,
    has_blacklist:               hasBlacklist,
    owner_can_change_balance:    ownerCanChangeBalance,
    first_buyers_count:          earlyBuyers.length,
    sniper_count:                snipers.length,
    bundler_count:               bundlers.length,
    sniper_held_percent:         sniperHeldPercent,
    risk_score:                  riskScore,
    risk_flags:                  riskFlags,
    summary,
  };
}

// ─── Risk Score Computation ───────────────────────────────────────────────────

interface RiskInputs {
  isHoneypot:           boolean;
  ownerCanChangeBalance: boolean;
  sellTax:              number;
  sniperHeldPercent:    number;
  deployerFlagged:      boolean;
  riskFlagCount:        number;
  liquidityLocked:      boolean;
}

function computeRiskScore(inputs: RiskInputs): RiskScore {
  const {
    isHoneypot, ownerCanChangeBalance, sellTax,
    sniperHeldPercent, deployerFlagged,
    riskFlagCount, liquidityLocked,
  } = inputs;

  // Hard fails → immediate LIKELY_RUG regardless of other signals
  if (isHoneypot)                                                 return "LIKELY_RUG";
  if (ownerCanChangeBalance)                                      return "LIKELY_RUG";
  if (sellTax > THRESHOLDS.EXTREME_TAX_PERCENT)                  return "LIKELY_RUG";
  if (sniperHeldPercent > THRESHOLDS.EXTREME_SNIPER_PERCENT && deployerFlagged) return "LIKELY_RUG";

  // Soft fails → CAUTION
  if (riskFlagCount >= THRESHOLDS.FLAGS_FOR_CAUTION)             return "CAUTION";
  if (!liquidityLocked)                                           return "CAUTION";
  if (sniperHeldPercent > THRESHOLDS.HIGH_SNIPER_PERCENT)        return "CAUTION";
  if (deployerFlagged)                                            return "CAUTION";

  return "SAFE";
}

// ─── Human-Readable Summary ───────────────────────────────────────────────────

function buildSummary(
  name: string,
  symbol: string,
  score: RiskScore,
  flags: string[],
  liquidity: number,
  ageHours: number,
  sniperCount: number,
  buyerCount: number
): string {
  const emoji = { SAFE: "✅", CAUTION: "⚠️", LIKELY_RUG: "🚨" }[score];
  const ageStr = ageHours > 0
    ? ageHours < 24 ? `${ageHours}h` : `${Math.round(ageHours / 24)}d`
    : "age unknown";

  const lines: string[] = [
    `${emoji} ${name} (${symbol}) — ${score}`,
    `Liquidity: $${liquidity.toLocaleString()} | Age: ${ageStr} | Snipers: ${sniperCount}/${buyerCount} early buyers`,
  ];

  if (flags.length > 0) {
    lines.push("", "Risk flags:");
    flags.forEach((f) => lines.push(`  • ${f}`));
  } else {
    lines.push("", "No significant risk flags detected.");
  }

  return lines.join("\n");
}
