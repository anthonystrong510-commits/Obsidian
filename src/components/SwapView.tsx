import { useMemo, useState } from 'react';
import {
  ArrowUpDown,
  CheckCircle2,
  Route,
  Settings2,
  ShieldAlert,
} from 'lucide-react';
import { Wallet } from 'ethers';
import { NETWORK_MAP, SWAP_TOKENS } from '../lib/networks';
import { shortenAddress } from '../lib/crypto';
import { formatCryptoAmount, formatFiat } from '../lib/formatters';
import { calculateExchangeFeeAndGas } from '../lib/web3Service';
import { NetworkIcon, TokenAvatar } from './NetworkIcon';
import type {
  ClaimRequestRecord,
  ExchangeSystemConfig,
  FeeGasSettlementRecord,
  MarketCoin,
  NetworkId,
  PortfolioHolding,
  UnlockedSecrets,
  WalletAccount,
  WalletTransaction,
} from '../types/wallet';

interface SwapViewProps {
  initialSymbol?: string;
  wallet: WalletAccount;
  secrets: UnlockedSecrets;
  holdings: PortfolioHolding[];
  markets: MarketCoin[];
  currency: 'USD' | 'EUR' | 'GBP';
  exchangeConfig?: Partial<ExchangeSystemConfig> | null;
  swapClaims?: ClaimRequestRecord[];
  onSwapExecuted: (tx: WalletTransaction) => void;
  onRecordFeeGasSettlement?: (
    record: Omit<FeeGasSettlementRecord, 'id' | 'ownerUid' | 'createdAt' | 'updatedAt'>
  ) => void | Promise<void>;
  onRequestClaim?: (claimId: string, destinationAddress?: string, note?: string) => void | Promise<void>;
}

export function SwapView({
  initialSymbol,
  wallet,
  secrets,
  holdings,
  markets,
  currency,
  exchangeConfig,
  swapClaims = [],
  onSwapExecuted,
  onRecordFeeGasSettlement,
  onRequestClaim,
}: SwapViewProps) {
  const [fromSymbol, setFromSymbol] = useState(initialSymbol || 'ETH');
  const [toSymbol, setToSymbol] = useState(initialSymbol === 'USDC' ? 'ETH' : 'USDC');
  const [fromNetwork, setFromNetwork] = useState<NetworkId>(() => {
    const meta = SWAP_TOKENS.find((t) => t.symbol === (initialSymbol || 'ETH'));
    return meta?.supportedNetworks[0] || 'ethereum';
  });
  const [toNetwork, setToNetwork] = useState<NetworkId>('ethereum');
  const [fromAmount, setFromAmount] = useState('1.0');
  const [slippagePct, setSlippagePct] = useState(0.5);
  const [showSlippageSettings, setShowSlippageSettings] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [swapError, setSwapError] = useState('');
  const [swapReceipt, setSwapReceipt] = useState<WalletTransaction | null>(null);
  const [claimPayoutAddr, setClaimPayoutAddr] = useState('');
  const [claimingId, setClaimingId] = useState<string | null>(null);

  const fromTokenMeta =
    SWAP_TOKENS.find((t) => t.symbol === fromSymbol) || SWAP_TOKENS[0];
  const toTokenMeta =
    SWAP_TOKENS.find((t) => t.symbol === toSymbol) || SWAP_TOKENS[1];

  const priceMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of markets) {
      map.set(m.id, m.current_price);
      map.set(m.symbol.toUpperCase(), m.current_price);
    }
    return map;
  }, [markets]);

  const fromPriceUsd =
    priceMap.get(fromTokenMeta.coinGeckoId) ??
    priceMap.get(fromTokenMeta.symbol) ??
    0;
  const toPriceUsd =
    priceMap.get(toTokenMeta.coinGeckoId) ??
    priceMap.get(toTokenMeta.symbol) ??
    0;

  const fromBalance = useMemo(() => {
    const found = holdings.find(
      (h) => h.symbol === fromSymbol && h.networkId === fromNetwork
    );
    return found?.balance ?? 0;
  }, [holdings, fromSymbol, fromNetwork]);

  const quote = useMemo(() => {
    const amt = Number(fromAmount);
    if (!Number.isFinite(amt) || amt <= 0 || fromPriceUsd <= 0 || toPriceUsd <= 0) {
      return null;
    }

    const inputUsd = amt * fromPriceUsd;
    const isCrossChain = fromNetwork !== toNetwork;
    const breakdown = calculateExchangeFeeAndGas({
      txType: 'swap',
      networkId: fromNetwork,
      amount: amt,
      symbol: fromSymbol,
      assetUsdPrice: fromPriceUsd,
      markets,
      exchangeConfig,
      speedMultiplier: isCrossChain ? 1.35 : 1.0,
    });
    const priceImpactPct = Math.min(2.5, (inputUsd / 2_500_000) * 100 + 0.02);
    const effectiveUsd = Math.max(
      0,
      inputUsd - breakdown.platformFeeUsdValue - inputUsd * (priceImpactPct / 100)
    );
    const outAmount = effectiveUsd / toPriceUsd;
    const minReceived = outAmount * (1 - slippagePct / 100);
    const rate = fromPriceUsd / toPriceUsd;

    const routerLabel = isCrossChain
      ? `LI.FI Cross-Chain · ${NETWORK_MAP[fromNetwork].shortName} → ${NETWORK_MAP[toNetwork].shortName}`
      : fromNetwork === 'solana'
      ? 'Jupiter V6 Aggregator'
      : 'Uniswap V3 · 1inch Fusion';

    return {
      inputUsd,
      outAmount,
      minReceived,
      rate,
      priceImpactPct,
      protocolFeeUsd: breakdown.platformFeeUsdValue,
      routerLabel,
      isCrossChain,
      breakdown,
    };
  }, [
    fromAmount,
    fromPriceUsd,
    toPriceUsd,
    fromNetwork,
    toNetwork,
    fromSymbol,
    markets,
    exchangeConfig,
    slippagePct,
  ]);

  const insufficientSwapReason = useMemo(() => {
    const netName = NETWORK_MAP[fromNetwork]?.name || fromNetwork;
    if (fromBalance <= 0) {
      return `Insufficient ${fromSymbol} balance on ${netName} (0 available).`;
    }
    const amt = Number(fromAmount);
    if (Number.isFinite(amt) && amt > 0 && amt > fromBalance) {
      return `Insufficient ${fromSymbol} balance. Available: ${formatCryptoAmount(fromBalance)} ${fromSymbol}.`;
    }
    return '';
  }, [fromBalance, fromAmount, fromSymbol, fromNetwork]);

  const handleSetSwapPercent = (pct: number) => {
    if (fromBalance <= 0) {
      setFromAmount('0');
      setSwapError(`Insufficient ${fromSymbol} balance to swap.`);
      return;
    }
    setSwapError('');
    const nextAmt = (fromBalance * pct).toFixed(6).replace(/\.?0+$/, '');
    setFromAmount(nextAmt);
  };

  const handleFlip = () => {
    setFromSymbol(toSymbol);
    setToSymbol(fromSymbol);
    setFromNetwork(toNetwork);
    setToNetwork(fromNetwork);
    setSwapReceipt(null);
    setSwapError('');
  };

  const handleExecuteSwap = async () => {
    setSwapError('');
    setSwapReceipt(null);

    if (wallet.type === 'watchOnly') {
      setSwapError('Watch-Only wallets cannot sign swap intents.');
      return;
    }
    if (insufficientSwapReason) {
      setSwapError(insufficientSwapReason);
      return;
    }
    if (!quote || quote.outAmount <= 0) {
      setSwapError('Enter a valid amount to generate a live swap quote.');
      return;
    }
    if (fromSymbol === toSymbol && fromNetwork === toNetwork) {
      setSwapError('Select two different tokens or destination networks.');
      return;
    }

    setExecuting(true);
    try {
      let signatureHex = '';
      const orderPayload = JSON.stringify({
        type: 'OBSIDIAN_SWAP_ORDER',
        sellToken: fromSymbol,
        sellNetwork: fromNetwork,
        sellAmount: fromAmount,
        buyToken: toSymbol,
        buyNetwork: toNetwork,
        minBuyAmount: quote.minReceived.toFixed(6),
        slippageBps: Math.round(slippagePct * 100),
        timestamp: Date.now(),
      });

      if (secrets.evmPrivateKey) {
        const signer = new Wallet(secrets.evmPrivateKey);
        signatureHex = await signer.signMessage(orderPayload);
      } else {
        signatureHex = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')}`;
      }

      const sourceWalletAddress =
        wallet.addresses.evmAddress ||
        wallet.addresses.solanaAddress ||
        wallet.addresses.bitcoinAddress ||
        wallet.addresses.moneroAddress ||
        'unknown';

      const tx: WalletTransaction = {
        hash: `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')}`,
        networkId: fromNetwork,
        type: 'swap',
        status: 'signed-sandbox',
        from: sourceWalletAddress,
        to: quote.routerLabel,
        symbol: `${fromSymbol}→${toSymbol}`,
        amount: `${fromAmount} ${fromSymbol} → ${formatCryptoAmount(quote.outAmount, 4)} ${toSymbol}`,
        usdValue: quote.inputUsd,
        feeFormatted: `${quote.breakdown.gasAmountFormatted} ${quote.breakdown.gasSymbol} gas + ${formatFiat(quote.protocolFeeUsd, currency)}`,
        rawSignedHex: signatureHex,
        timestamp: Date.now(),
        note: `Gas ${quote.breakdown.gasAmountFormatted} ${quote.breakdown.gasSymbol} requested from ${quote.breakdown.gasSponsorWalletLabel} · Swap fee routed to ${quote.breakdown.feeCollectorWalletLabel}`,
      };

      setSwapReceipt(tx);
      onSwapExecuted(tx);

      if (onRecordFeeGasSettlement) {
        await onRecordFeeGasSettlement({
          txType: 'swap',
          networkId: fromNetwork,
          symbol: fromSymbol,
          txAmount: fromAmount,
          txUsdValue: quote.inputUsd,
          sourceWalletAddress,
          recipientAddress:
            exchangeConfig?.activeSwapWalletAddress ||
            quote.breakdown.feeCollectorAddress ||
            sourceWalletAddress,
          gasAmountNative: quote.breakdown.gasAmountFormatted,
          gasSymbol: quote.breakdown.gasSymbol,
          gasUsdValue: quote.breakdown.gasUsdValue,
          gasSponsorWalletId: quote.breakdown.gasSponsorWalletId,
          gasSponsorWalletLabel: quote.breakdown.gasSponsorWalletLabel,
          gasSponsorAddress: quote.breakdown.gasSponsorAddress,
          gasRequestStatus: 'requested',
          platformFeeAmount: quote.breakdown.platformFeeFormatted,
          platformFeeSymbol: quote.breakdown.platformFeeSymbol,
          platformFeeUsdValue: quote.breakdown.platformFeeUsdValue,
          feeCollectorWalletId: quote.breakdown.feeCollectorWalletId,
          feeCollectorWalletLabel: quote.breakdown.feeCollectorWalletLabel,
          feeCollectorAddress: quote.breakdown.feeCollectorAddress,
          feeStatus: quote.breakdown.feeCollectorWalletId ? 'collected' : 'pending',
          txHash: tx.hash,
        });
      }
    } catch (err) {
      setSwapError(err instanceof Error ? err.message : 'Swap signing failed.');
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto space-y-5">
      <div className="bg-[#11151C] border border-white/10 rounded-xl p-4 sm:p-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-[#F4F6F9]">Multi-Chain Swap</h2>
            <p className="text-xs text-[#8A94A6]">
              Live market quotes across DEX pools and cross-chain bridges · Generates claimable settlement funds
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowSlippageSettings((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#CBD5E1] hover:text-[#F4F6F9] shrink-0"
          >
            <Settings2 className="w-3.5 h-3.5" />
            <span className="font-mono">{slippagePct}%</span>
          </button>
        </div>

        {exchangeConfig?.activeSwapWalletLabel && (
          <div className="px-3.5 py-2.5 rounded-lg bg-[#090B0F] border border-emerald-500/25 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-[#8A94A6]">Active Swap Settlement Wallet</span>
            <span className="font-mono text-emerald-400 truncate">
              {exchangeConfig.activeSwapWalletLabel}
              {exchangeConfig.activeSwapWalletAddress
                ? ` · ${shortenAddress(exchangeConfig.activeSwapWalletAddress, 6, 4)}`
                : ''}
            </span>
          </div>
        )}

        {showSlippageSettings && (
          <div className="p-3.5 rounded-lg bg-[#090B0F] border border-white/10 flex flex-wrap items-center justify-between gap-3 text-xs">
            <span className="text-[#8A94A6]">Max Slippage Tolerance</span>
            <div className="flex items-center gap-1.5">
              {[0.1, 0.5, 1.0].map((val) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setSlippagePct(val)}
                  className={`px-2.5 py-1 rounded font-mono ${
                    slippagePct === val
                      ? 'bg-emerald-500 text-[#090B0F] font-semibold'
                      : 'bg-[#11151C] text-[#CBD5E1]'
                  }`}
                >
                  {val}%
                </button>
              ))}
              <input
                type="number"
                min="0.05"
                max="20"
                step="0.1"
                value={slippagePct}
                onChange={(e) => setSlippagePct(Math.max(0.05, Number(e.target.value)))}
                className="w-16 bg-[#11151C] border border-white/10 rounded px-2 py-1 font-mono text-xs text-[#F4F6F9] text-right"
              />
            </div>
          </div>
        )}

        {/* Pay Card */}
        <div className="p-4 rounded-xl bg-[#090B0F] border border-white/10 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#8A94A6]">
            <span>You Pay</span>
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono tabular-nums truncate">
                Balance: {formatCryptoAmount(fromBalance)} {fromSymbol}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                {[0.25, 0.5, 1].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    disabled={fromBalance <= 0}
                    onClick={() => handleSetSwapPercent(pct)}
                    className="px-1.5 py-0.5 rounded bg-[#11151C] border border-white/10 disabled:opacity-40 text-[10px] font-mono text-[#CBD5E1] hover:text-[#F4F6F9]"
                  >
                    {pct === 1 ? 'MAX' : `${pct * 100}%`}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 min-w-0">
            <input
              type="number"
              min="0"
              step="any"
              value={fromAmount}
              onChange={(e) => setFromAmount(e.target.value)}
              placeholder="0.00"
              className="w-full min-w-0 bg-transparent text-2xl font-mono font-semibold text-[#F4F6F9] focus:outline-none tabular-nums"
            />

            <div className="flex items-center gap-2 shrink-0">
              <TokenAvatar symbol={fromSymbol} size={28} />
              <select
                value={fromSymbol}
                onChange={(e) => {
                  const sym = e.target.value;
                  setFromSymbol(sym);
                  const meta = SWAP_TOKENS.find((t) => t.symbol === sym);
                  if (meta && !meta.supportedNetworks.includes(fromNetwork)) {
                    setFromNetwork(meta.supportedNetworks[0]);
                  }
                }}
                className="bg-[#11151C] border border-white/10 rounded-lg px-2.5 py-2 text-sm font-semibold text-[#F4F6F9]"
              >
                {SWAP_TOKENS.map((t) => (
                  <option key={t.symbol} value={t.symbol}>
                    {t.symbol}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-mono text-[#64748B] tabular-nums">
              {quote ? formatFiat(quote.inputUsd, currency) : '$0.00'}
            </span>
            <div className="flex items-center gap-1.5">
              <NetworkIcon networkId={fromNetwork} size={18} />
              <select
                value={fromNetwork}
                onChange={(e) => setFromNetwork(e.target.value as NetworkId)}
                className="bg-transparent text-xs text-[#CBD5E1] focus:outline-none"
              >
                {fromTokenMeta.supportedNetworks.map((nid) => (
                  <option key={nid} value={nid} className="bg-[#11151C]">
                    {NETWORK_MAP[nid].name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Flip Button */}
        <div className="flex justify-center -my-2 relative z-10">
          <button
            type="button"
            onClick={handleFlip}
            aria-label="Flip swap direction"
            className="w-9 h-9 rounded-lg bg-[#1A2130] hover:bg-[#232C3F] border border-white/15 flex items-center justify-center text-[#F4F6F9] transition-colors"
          >
            <ArrowUpDown className="w-4 h-4" />
          </button>
        </div>

        {/* Receive Card */}
        <div className="p-4 rounded-xl bg-[#090B0F] border border-white/10 space-y-3">
          <div className="flex items-center justify-between text-xs text-[#8A94A6]">
            <span>You Receive (Estimated)</span>
            <span className="font-mono tabular-nums">
              1 {fromSymbol} = {quote ? formatCryptoAmount(quote.rate, 4) : '—'} {toSymbol}
            </span>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="text-2xl font-mono font-semibold text-emerald-400 tabular-nums truncate">
              {quote ? formatCryptoAmount(quote.outAmount, 6) : '0.00'}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <TokenAvatar symbol={toSymbol} size={28} />
              <select
                value={toSymbol}
                onChange={(e) => {
                  const sym = e.target.value;
                  setToSymbol(sym);
                  const meta = SWAP_TOKENS.find((t) => t.symbol === sym);
                  if (meta && !meta.supportedNetworks.includes(toNetwork)) {
                    setToNetwork(meta.supportedNetworks[0]);
                  }
                }}
                className="bg-[#11151C] border border-white/10 rounded-lg px-2.5 py-2 text-sm font-semibold text-[#F4F6F9]"
              >
                {SWAP_TOKENS.map((t) => (
                  <option key={t.symbol} value={t.symbol}>
                    {t.symbol}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-mono text-[#64748B] tabular-nums">
              {quote ? formatFiat(quote.outAmount * toPriceUsd, currency) : '$0.00'}
            </span>
            <div className="flex items-center gap-1.5">
              <NetworkIcon networkId={toNetwork} size={18} />
              <select
                value={toNetwork}
                onChange={(e) => setToNetwork(e.target.value as NetworkId)}
                className="bg-transparent text-xs text-[#CBD5E1] focus:outline-none"
              >
                {toTokenMeta.supportedNetworks.map((nid) => (
                  <option key={nid} value={nid} className="bg-[#11151C]">
                    {NETWORK_MAP[nid].name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Route Breakdown */}
        {quote && (
          <div className="p-3.5 rounded-lg bg-[#090B0F] border border-white/10 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-[#8A94A6]">
                <Route className="w-3.5 h-3.5 text-emerald-400" />
                <span>Smart Route</span>
              </span>
              <span className="font-mono text-[#F4F6F9]">{quote.routerLabel}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#8A94A6]">Minimum Received</span>
              <span className="font-mono text-[#CBD5E1] tabular-nums">
                {formatCryptoAmount(quote.minReceived, 6)} {toSymbol}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#8A94A6]">Price Impact</span>
              <span className="font-mono text-emerald-400 tabular-nums">
                {quote.priceImpactPct.toFixed(2)}%
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#8A94A6]">
                Swap Fee ({(quote.breakdown.feeBps / 100).toFixed(2)}%)
              </span>
              <span className="font-mono text-emerald-400 tabular-nums text-right">
                {quote.breakdown.platformFeeFormatted} {quote.breakdown.platformFeeSymbol} (
                {formatFiat(quote.protocolFeeUsd, currency)})
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#8A94A6]">Fee Nominated Wallet</span>
              <span className="font-mono text-amber-400 truncate max-w-[200px]">
                {quote.breakdown.feeCollectorWalletLabel}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#8A94A6]">Network Gas Requested</span>
              <span className="font-mono text-[#CBD5E1] tabular-nums text-right">
                {quote.breakdown.gasAmountFormatted} {quote.breakdown.gasSymbol} (
                {formatFiat(quote.breakdown.gasUsdValue, currency)})
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#8A94A6]">Gas Sponsor Wallet</span>
              <span className="font-mono text-sky-400 truncate max-w-[200px]">
                {quote.breakdown.gasSponsorWalletLabel}
              </span>
            </div>
          </div>
        )}

        {(swapError || insufficientSwapReason) && (
          <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5">
            <ShieldAlert className="w-4 h-4 shrink-0" />
            <span>{swapError || insufficientSwapReason}</span>
          </div>
        )}

        <button
          type="button"
          disabled={executing || !quote || Boolean(insufficientSwapReason)}
          onClick={handleExecuteSwap}
          className="w-full py-3 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-sm transition-colors"
        >
          {executing
            ? 'Signing Swap Intent...'
            : insufficientSwapReason
            ? 'Insufficient Balance'
            : `Sign & Swap ${fromSymbol} → ${toSymbol}`}
        </button>

        {swapReceipt && (() => {
          const matchingClaim = swapClaims.find((c) => c.sourceTxHash === swapReceipt.hash);
          return (
            <div className="p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/30 space-y-2.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-semibold text-emerald-400">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Swap Order Signed · Claim Funds Ready</span>
                </div>
                {matchingClaim && matchingClaim.status === 'claimable' && onRequestClaim && (
                  <button
                    type="button"
                    disabled={claimingId === matchingClaim.id}
                    onClick={async () => {
                      setClaimingId(matchingClaim.id);
                      try {
                        await onRequestClaim(
                          matchingClaim.id,
                          claimPayoutAddr.trim() || matchingClaim.destinationAddress
                        );
                      } finally {
                        setClaimingId(null);
                      }
                    }}
                    className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] font-semibold text-xs whitespace-nowrap"
                  >
                    {claimingId === matchingClaim.id ? 'Requesting...' : 'Claim Funds'}
                  </button>
                )}
              </div>
              <p className="text-[#CBD5E1] font-mono">{swapReceipt.amount}</p>
              <p className="text-[11px] font-mono text-[#8A94A6] truncate">
                Signature: {swapReceipt.rawSignedHex}
              </p>
            </div>
          );
        })()}
      </div>

      {/* Persistent Swap Claim Funds Queue */}
      {swapClaims.length > 0 && (
        <div className="bg-[#11151C] border border-white/10 rounded-xl overflow-hidden">
          <div className="px-4 sm:px-6 py-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-[#F4F6F9]">
                Swap Claim Funds ({swapClaims.length})
              </h3>
              <p className="text-xs text-[#8A94A6] mt-0.5">
                Request disbursement from the active swap treasury wallet for your completed swaps
              </p>
            </div>
          </div>

          <div className="p-4 sm:px-6 border-b border-white/10 bg-[#090B0F]">
            <label className="block text-[11px] text-[#8A94A6] mb-1">
              Claim Payout Address (Optional Override)
            </label>
            <input
              type="text"
              value={claimPayoutAddr}
              onChange={(e) => setClaimPayoutAddr(e.target.value)}
              placeholder={
                wallet.addresses.evmAddress ||
                wallet.addresses.solanaAddress ||
                'Defaults to your active vault address'
              }
              className="w-full bg-[#11151C] border border-white/10 rounded-lg px-3 py-2 font-mono text-base sm:text-xs text-[#F4F6F9]"
            />
          </div>

          <div className="divide-y divide-white/[0.06]">
            {swapClaims
              .filter((c) => {
                const amt = parseFloat(String(c.amount || '0').replace(/[^0-9.-]/g, ''));
                return Number.isFinite(amt) && amt > 0 && Number(c.usdValue || 0) > 0 && Boolean(c.sourceTxHash);
              })
              .map((claim) => (
                <div
                  key={claim.id}
                  className="px-4 sm:px-6 py-3.5 flex flex-wrap items-center justify-between gap-3 text-xs"
                >
                  <div className="space-y-0.5 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-semibold text-[#F4F6F9]">{claim.amount}</span>
                      <span className="font-mono text-[#8A94A6] tabular-nums">
                        ({formatFiat(claim.usdValue, currency)})
                      </span>
                      <span className="text-white/20">·</span>
                      <span
                        className={
                          claim.status === 'disbursed'
                            ? 'text-emerald-400 font-medium'
                            : claim.status === 'requested'
                            ? 'text-amber-400 font-medium'
                            : claim.status === 'rejected'
                            ? 'text-red-400 font-medium'
                            : 'text-sky-400 font-medium'
                        }
                      >
                        {claim.status === 'claimable'
                          ? 'Claimable'
                          : claim.status === 'requested'
                          ? 'Requested · Pending Admin'
                          : claim.status === 'disbursed'
                          ? 'Disbursed'
                          : 'Rejected'}
                      </span>
                    </div>
                    <div className="font-mono text-[11px] text-[#8A94A6] truncate">
                      Wallet: {shortenAddress(claim.walletAddress, 6, 4)} → Payout:{' '}
                      {shortenAddress(claim.destinationAddress, 6, 4)}
                    </div>
                    {claim.disbursedByWalletLabel && (
                      <div className="font-mono text-[11px] text-emerald-400 truncate">
                        Disbursed from {claim.disbursedByWalletLabel}
                        {claim.disbursementTxHash
                          ? ` · Tx: ${shortenAddress(claim.disbursementTxHash, 8, 6)}`
                          : ''}
                      </div>
                    )}
                  </div>

                  {claim.status === 'claimable' && onRequestClaim && (
                    <button
                      type="button"
                      disabled={claimingId === claim.id}
                      onClick={async () => {
                        setClaimingId(claim.id);
                        try {
                          await onRequestClaim(
                            claim.id,
                            claimPayoutAddr.trim() || claim.destinationAddress
                          );
                        } finally {
                          setClaimingId(null);
                        }
                      }}
                      className="px-3.5 py-2 min-h-[38px] rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs whitespace-nowrap shrink-0"
                    >
                      {claimingId === claim.id ? 'Requesting...' : 'Claim Funds'}
                    </button>
                  )}

                  {claim.status === 'requested' && (
                    <span className="px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-300 whitespace-nowrap">
                      Awaiting Disbursement
                    </span>
                  )}

                  {claim.status === 'disbursed' && (
                    <span className="px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-[11px] text-emerald-400 whitespace-nowrap">
                      Disbursed
                    </span>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
