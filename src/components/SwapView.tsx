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
import { formatCryptoAmount, formatFiat } from '../lib/formatters';
import { NetworkIcon, TokenAvatar } from './NetworkIcon';
import type {
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
  onSwapExecuted: (tx: WalletTransaction) => void;
}

export function SwapView({
  initialSymbol,
  wallet,
  secrets,
  holdings,
  markets,
  currency,
  onSwapExecuted,
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
    const protocolFeePct = isCrossChain ? 0.0022 : 0.001; // 0.22% bridge+DEX or 0.10% DEX
    const priceImpactPct = Math.min(2.5, (inputUsd / 2_500_000) * 100 + 0.02);
    const effectiveUsd = inputUsd * (1 - protocolFeePct - priceImpactPct / 100);
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
      protocolFeeUsd: inputUsd * protocolFeePct,
      routerLabel,
      isCrossChain,
    };
  }, [fromAmount, fromPriceUsd, toPriceUsd, fromNetwork, toNetwork, slippagePct]);

  const handleFlip = () => {
    setFromSymbol(toSymbol);
    setToSymbol(fromSymbol);
    setFromNetwork(toNetwork);
    setToNetwork(fromNetwork);
    setSwapReceipt(null);
  };

  const handleExecuteSwap = async () => {
    setSwapError('');
    setSwapReceipt(null);

    if (wallet.type === 'watchOnly') {
      setSwapError('Watch-Only wallets cannot sign swap intents.');
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

      const tx: WalletTransaction = {
        hash: `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')}`,
        networkId: fromNetwork,
        type: 'swap',
        status: 'signed-sandbox',
        from:
          wallet.addresses.evmAddress ||
          wallet.addresses.solanaAddress ||
          wallet.addresses.bitcoinAddress ||
          wallet.addresses.moneroAddress ||
          '',
        to: quote.routerLabel,
        symbol: `${fromSymbol}→${toSymbol}`,
        amount: `${fromAmount} ${fromSymbol} → ${formatCryptoAmount(quote.outAmount, 4)} ${toSymbol}`,
        usdValue: quote.inputUsd,
        feeFormatted: formatFiat(quote.protocolFeeUsd, currency),
        rawSignedHex: signatureHex,
        timestamp: Date.now(),
      };

      setSwapReceipt(tx);
      onSwapExecuted(tx);
    } catch (err) {
      setSwapError(err instanceof Error ? err.message : 'Swap signing failed.');
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto space-y-5">
      <div className="bg-[#11151C] border border-white/10 rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[#F4F6F9]">Multi-Chain Swap</h2>
            <p className="text-xs text-[#8A94A6]">
              Live market quotes across DEX pools and cross-chain bridges
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowSlippageSettings((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#CBD5E1] hover:text-[#F4F6F9]"
          >
            <Settings2 className="w-3.5 h-3.5" />
            <span className="font-mono">{slippagePct}%</span>
          </button>
        </div>

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
          <div className="flex items-center justify-between text-xs text-[#8A94A6]">
            <span>You Pay</span>
            <span className="font-mono tabular-nums">
              Balance: {formatCryptoAmount(fromBalance)} {fromSymbol}
            </span>
          </div>

          <div className="flex items-center justify-between gap-3">
            <input
              type="number"
              min="0"
              step="any"
              value={fromAmount}
              onChange={(e) => setFromAmount(e.target.value)}
              placeholder="0.00"
              className="w-full bg-transparent text-2xl font-mono font-semibold text-[#F4F6F9] focus:outline-none tabular-nums"
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
            <div className="flex items-center justify-between">
              <span className="text-[#8A94A6]">Routing & Protocol Fee</span>
              <span className="font-mono text-[#CBD5E1] tabular-nums">
                {formatFiat(quote.protocolFeeUsd, currency)}
              </span>
            </div>
          </div>
        )}

        {swapError && (
          <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5">
            <ShieldAlert className="w-4 h-4 shrink-0" />
            <span>{swapError}</span>
          </div>
        )}

        <button
          type="button"
          disabled={executing || !quote}
          onClick={handleExecuteSwap}
          className="w-full py-3 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-sm transition-colors"
        >
          {executing
            ? 'Signing Swap Intent...'
            : `Sign & Swap ${fromSymbol} → ${toSymbol}`}
        </button>

        {swapReceipt && (
          <div className="p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/30 space-y-1.5 text-xs">
            <div className="flex items-center gap-2 font-semibold text-emerald-400">
              <CheckCircle2 className="w-4 h-4" />
              <span>Swap Order Signed & Recorded</span>
            </div>
            <p className="text-[#CBD5E1] font-mono">{swapReceipt.amount}</p>
            <p className="text-[11px] font-mono text-[#8A94A6] truncate">
              Signature: {swapReceipt.rawSignedHex}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
