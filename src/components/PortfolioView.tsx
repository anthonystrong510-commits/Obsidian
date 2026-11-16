import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  BellPlus,
  ExternalLink,
  Plus,
  RefreshCw,
  Search,
  Wallet,
} from 'lucide-react';
import { NETWORKS, NETWORK_MAP } from '../lib/networks';
import { formatCryptoAmount, formatFiat, formatPercent, formatRelativeTime } from '../lib/formatters';
import { fetchCoinHistory, fetchCustomErc20Metadata } from '../lib/web3Service';
import { isAddress } from 'ethers';
import { NetworkIcon, TokenAvatar } from './NetworkIcon';
import type {
  MarketCoin,
  NetworkId,
  PortfolioHolding,
  TokenConfig,
  WalletAccount,
  WalletTransaction,
} from '../types/wallet';

interface PortfolioViewProps {
  wallet: WalletAccount;
  holdings: PortfolioHolding[];
  markets: MarketCoin[];
  transactions: WalletTransaction[];
  currency: 'USD' | 'EUR' | 'GBP';
  loadingPortfolio: boolean;
  onRefresh: () => void;
  onNavigateSend: (networkId?: NetworkId, symbol?: string) => void;
  onNavigateReceive: (networkId?: NetworkId) => void;
  onNavigateSwap: (symbol?: string) => void;
  onNavigateAlert: (coinId?: string) => void;
  onAddCustomToken: (token: TokenConfig) => void;
}

type Timeframe = '1' | '7' | '30' | '365';

export function PortfolioView({
  wallet,
  holdings,
  markets,
  transactions,
  currency,
  loadingPortfolio,
  onRefresh,
  onNavigateSend,
  onNavigateReceive,
  onNavigateSwap,
  onNavigateAlert,
  onAddCustomToken,
}: PortfolioViewProps) {
  const [selectedNetwork, setSelectedNetwork] = useState<NetworkId | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [hideZeroBalances, setHideZeroBalances] = useState(false);
  const [timeframe, setTimeframe] = useState<Timeframe>('7');
  const [chartPoints, setChartPoints] = useState<Array<[number, number]>>([]);
  const [chartCoinId, setChartCoinId] = useState<string>('ethereum');
  const [loadingChart, setLoadingChart] = useState(false);

  // Add Custom ERC-20 Token Modal
  const [showAddToken, setShowAddToken] = useState(false);
  const [customNet, setCustomNet] = useState<NetworkId>('ethereum');
  const [customAddress, setCustomAddress] = useState('');
  const [customTokenError, setCustomTokenError] = useState('');
  const [addingToken, setAddingToken] = useState(false);

  const totalUsd = useMemo(
    () => holdings.reduce((sum, h) => sum + h.valueUsd, 0),
    [holdings]
  );

  const weighted24hChange = useMemo(() => {
    if (totalUsd <= 0) {
      const eth = markets.find((m) => m.id === 'ethereum');
      return eth?.price_change_percentage_24h ?? 0;
    }
    const weighted = holdings.reduce(
      (sum, h) => sum + (h.valueUsd / totalUsd) * h.change24h,
      0
    );
    return weighted;
  }, [holdings, totalUsd, markets]);

  const networkTotals = useMemo(() => {
    const map = new Map<NetworkId, number>();
    for (const h of holdings) {
      map.set(h.networkId, (map.get(h.networkId) ?? 0) + h.valueUsd);
    }
    return map;
  }, [holdings]);

  const filteredHoldings = useMemo(() => {
    return holdings.filter((h) => {
      if (selectedNetwork !== 'all' && h.networkId !== selectedNetwork) return false;
      if (hideZeroBalances && h.balance <= 0) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          h.symbol.toLowerCase().includes(q) ||
          h.name.toLowerCase().includes(q) ||
          h.networkName.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [holdings, selectedNetwork, hideZeroBalances, searchQuery]);

  // Determine dominant asset or user-selected benchmark for historical chart
  useEffect(() => {
    const topHolding = holdings.find((h) => h.valueUsd > 0 && h.coinGeckoId);
    if (topHolding) {
      setChartCoinId(topHolding.coinGeckoId);
    }
  }, [holdings]);

  useEffect(() => {
    let active = true;
    setLoadingChart(true);
    fetchCoinHistory(chartCoinId, timeframe)
      .then((pts) => {
        if (active) setChartPoints(pts);
      })
      .finally(() => {
        if (active) setLoadingChart(false);
      });
    return () => {
      active = false;
    };
  }, [chartCoinId, timeframe]);

  // Build normalized SVG path for portfolio/benchmark chart
  const chartSvg = useMemo(() => {
    if (chartPoints.length < 2) return null;
    const width = 680;
    const height = 160;
    const prices = chartPoints.map((p) => p[1]);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;

    const coords = chartPoints.map((p, i) => {
      const x = (i / (chartPoints.length - 1)) * width;
      const y = height - 12 - ((p[1] - min) / range) * (height - 24);
      return { x, y, price: p[1], ts: p[0] };
    });

    const linePath = coords
      .map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
      .join(' ');
    const areaPath = `${linePath} L ${width} ${height} L 0 ${height} Z`;
    const first = prices[0];
    const last = prices[prices.length - 1];
    const deltaPct = first > 0 ? ((last - first) / first) * 100 : 0;

    return { width, height, linePath, areaPath, min, max, last, deltaPct };
  }, [chartPoints]);

  const handleAddTokenSubmit = async () => {
    setCustomTokenError('');
    if (!isAddress(customAddress.trim())) {
      setCustomTokenError('Enter a valid EVM ERC-20 contract address.');
      return;
    }
    setAddingToken(true);
    try {
      const meta = await fetchCustomErc20Metadata(customNet, customAddress.trim());
      onAddCustomToken(meta);
      setCustomAddress('');
      setShowAddToken(false);
    } catch {
      setCustomTokenError('Unable to read ERC-20 contract metadata on this network.');
    } finally {
      setAddingToken(false);
    }
  };

  const chartCoinMeta = markets.find((m) => m.id === chartCoinId);

  return (
    <div className="space-y-8">
      {/* Top Hero Row: Balance Summary + Historical Chart */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
        <div className="xl:col-span-5 bg-[#11151C] border border-white/10 rounded-xl p-6 flex flex-col justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 text-xs text-[#8A94A6]">
              <span>
                {wallet.name} · {wallet.type === 'watchOnly' ? 'Watch-Only' : `${wallet.wordCount || 'Key'} Vault`}
              </span>
              <button
                type="button"
                onClick={onRefresh}
                disabled={loadingPortfolio}
                className="inline-flex items-center gap-1.5 text-xs text-[#8A94A6] hover:text-[#F4F6F9] transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingPortfolio ? 'animate-spin' : ''}`} />
                <span>{loadingPortfolio ? 'Syncing RPC...' : 'Sync Chains'}</span>
              </button>
            </div>

            <div className="text-4xl font-display font-bold tracking-tight text-[#F4F6F9] tabular-nums">
              {formatFiat(totalUsd, currency)}
            </div>

            <div className="flex items-center gap-3 text-xs tabular-nums">
              <span
                className={
                  weighted24hChange >= 0 ? 'text-emerald-400 font-medium' : 'text-red-400 font-medium'
                }
              >
                {formatPercent(weighted24hChange)} (24h)
              </span>
              <span className="text-white/20">·</span>
              <span className="text-[#8A94A6]">
                {holdings.filter((h) => h.balance > 0).length} active positions across {NETWORKS.length} networks
              </span>
            </div>
          </div>

          {/* Primary Actions */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <button
              type="button"
              onClick={() => onNavigateSend()}
              className="flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] font-semibold text-xs transition-colors whitespace-nowrap"
            >
              <ArrowUpRight className="w-4 h-4" />
              <span>Send</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigateReceive()}
              className="flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-lg bg-[#1A2130] hover:bg-[#232C3F] text-[#F4F6F9] font-medium text-xs border border-white/10 transition-colors whitespace-nowrap"
            >
              <ArrowDownLeft className="w-4 h-4" />
              <span>Receive</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigateSwap()}
              className="flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-lg bg-[#1A2130] hover:bg-[#232C3F] text-[#F4F6F9] font-medium text-xs border border-white/10 transition-colors whitespace-nowrap"
            >
              <ArrowLeftRight className="w-4 h-4" />
              <span>Swap</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigateAlert(chartCoinId)}
              className="flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-lg bg-[#1A2130] hover:bg-[#232C3F] text-[#F4F6F9] font-medium text-xs border border-white/10 transition-colors whitespace-nowrap"
            >
              <BellPlus className="w-4 h-4" />
              <span>Alert</span>
            </button>
          </div>
        </div>

        {/* Market & Portfolio Benchmark Chart */}
        <div className="xl:col-span-7 bg-[#11151C] border border-white/10 rounded-xl p-6 flex flex-col justify-between">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-3">
              <select
                value={chartCoinId}
                onChange={(e) => setChartCoinId(e.target.value)}
                aria-label="Select asset chart"
                className="bg-[#090B0F] border border-white/10 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
              >
                {markets.slice(0, 10).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.symbol})
                  </option>
                ))}
              </select>
              {chartCoinMeta && (
                <div className="text-xs tabular-nums flex items-center gap-2">
                  <span className="font-mono text-[#F4F6F9]">
                    {formatFiat(chartCoinMeta.current_price, currency)}
                  </span>
                  {chartSvg && (
                    <span
                      className={
                        chartSvg.deltaPct >= 0 ? 'text-emerald-400' : 'text-red-400'
                      }
                    >
                      {formatPercent(chartSvg.deltaPct)}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-1 p-1 bg-[#090B0F] border border-white/10 rounded-lg">
              {(
                [
                  { id: '1', label: '24H' },
                  { id: '7', label: '7D' },
                  { id: '30', label: '30D' },
                  { id: '365', label: '1Y' },
                ] as Array<{ id: Timeframe; label: string }>
              ).map((tf) => (
                <button
                  key={tf.id}
                  type="button"
                  onClick={() => setTimeframe(tf.id)}
                  className={`px-2.5 py-1 text-xs font-mono rounded transition-colors whitespace-nowrap ${
                    timeframe === tf.id
                      ? 'bg-[#1D2432] text-[#F4F6F9]'
                      : 'text-[#8A94A6] hover:text-[#F4F6F9]'
                  }`}
                >
                  {tf.label}
                </button>
              ))}
            </div>
          </div>

          <div className="relative h-40 w-full">
            {loadingChart && !chartSvg ? (
              <div className="h-full w-full rounded-lg bg-[#090B0F]/60 animate-pulse" />
            ) : chartSvg ? (
              <svg
                viewBox={`0 0 ${chartSvg.width} ${chartSvg.height}`}
                className="w-full h-full overflow-visible"
                preserveAspectRatio="none"
              >
                <defs>
                  <linearGradient id="obsidianChartFill" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor={chartSvg.deltaPct >= 0 ? '#10B981' : '#EF4444'}
                      stopOpacity="0.22"
                    />
                    <stop
                      offset="100%"
                      stopColor={chartSvg.deltaPct >= 0 ? '#10B981' : '#EF4444'}
                      stopOpacity="0"
                    />
                  </linearGradient>
                </defs>
                <path d={chartSvg.areaPath} fill="url(#obsidianChartFill)" />
                <path
                  d={chartSvg.linePath}
                  fill="none"
                  stroke={chartSvg.deltaPct >= 0 ? '#10B981' : '#EF4444'}
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-[#64748B]">
                Live historical market data unavailable
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Network Filter Bar */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
            <button
              type="button"
              onClick={() => setSelectedNetwork('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
                selectedNetwork === 'all'
                  ? 'bg-[#1D2432] border-white/20 text-[#F4F6F9]'
                  : 'bg-[#11151C] border-white/10 text-[#8A94A6] hover:text-[#F4F6F9]'
              }`}
            >
              All Networks · {formatFiat(totalUsd, currency)}
            </button>
            {NETWORKS.map((net) => {
              const netVal = networkTotals.get(net.id) ?? 0;
              return (
                <button
                  key={net.id}
                  type="button"
                  onClick={() => setSelectedNetwork(net.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
                    selectedNetwork === net.id
                      ? 'bg-[#1D2432] border-white/20 text-[#F4F6F9]'
                      : 'bg-[#11151C] border-white/10 text-[#8A94A6] hover:text-[#F4F6F9]'
                  }`}
                >
                  <NetworkIcon networkId={net.id} size={18} />
                  <span>{net.shortName}</span>
                  {netVal > 0 && (
                    <span className="font-mono text-[11px] text-[#CBD5E1]">
                      {formatFiat(netVal, currency)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Holdings Table Container */}
        <div className="bg-[#11151C] border border-white/10 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold text-[#F4F6F9]">Multi-Chain Assets</h3>
              <span className="text-xs text-[#64748B] tabular-nums">
                {filteredHoldings.length} assets
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-[#64748B] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter token or chain..."
                  className="bg-[#090B0F] border border-white/10 rounded-lg pl-8 pr-3 py-1.5 text-xs text-[#F4F6F9] placeholder-[#525D70] focus:outline-none focus:border-emerald-500/60 w-44 sm:w-56"
                />
              </div>

              <label className="flex items-center gap-2 text-xs text-[#8A94A6] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={hideZeroBalances}
                  onChange={(e) => setHideZeroBalances(e.target.checked)}
                  className="rounded border-white/20 bg-[#090B0F] text-emerald-500 focus:ring-emerald-500"
                />
                <span>Hide empty</span>
              </label>

              <button
                type="button"
                onClick={() => setShowAddToken((v) => !v)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 hover:border-white/20 text-xs text-[#CBD5E1] whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Import Token</span>
              </button>
            </div>
          </div>

          {showAddToken && (
            <div className="px-5 py-4 bg-[#0D1017] border-b border-white/10 flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-[11px] text-[#8A94A6] mb-1">EVM Network</label>
                <select
                  value={customNet}
                  onChange={(e) => setCustomNet(e.target.value as NetworkId)}
                  className="bg-[#090B0F] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-[#F4F6F9]"
                >
                  {NETWORKS.filter((n) => n.family === 'evm').map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-1 min-w-[240px]">
                <label className="block text-[11px] text-[#8A94A6] mb-1">
                  ERC-20 Contract Address
                </label>
                <input
                  type="text"
                  value={customAddress}
                  onChange={(e) => setCustomAddress(e.target.value)}
                  placeholder="0x..."
                  className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-1.5 font-mono text-xs text-[#F4F6F9]"
                />
              </div>
              <button
                type="button"
                disabled={addingToken}
                onClick={handleAddTokenSubmit}
                className="px-3.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] font-semibold text-xs whitespace-nowrap"
              >
                {addingToken ? 'Reading Contract...' : 'Add ERC-20'}
              </button>
              {customTokenError && (
                <span className="text-xs text-red-400 w-full">{customTokenError}</span>
              )}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/10 text-[11px] font-medium text-[#8A94A6]">
                  <th className="py-3 px-5">Asset</th>
                  <th className="py-3 px-4">Network</th>
                  <th className="py-3 px-4 text-right">Spot Price</th>
                  <th className="py-3 px-4 text-right">24h Change</th>
                  <th className="py-3 px-4 text-right">Balance</th>
                  <th className="py-3 px-4 text-right">Value</th>
                  <th className="py-3 px-5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06] text-xs">
                {loadingPortfolio && filteredHoldings.length === 0 ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="h-11">
                      <td colSpan={7} className="px-5 py-2.5">
                        <div className="h-5 bg-white/5 rounded animate-pulse" />
                      </td>
                    </tr>
                  ))
                ) : filteredHoldings.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 px-5 text-center text-[#8A94A6]">
                      <Wallet className="w-6 h-6 mx-auto mb-2 text-[#525D70]" />
                      <p className="text-sm text-[#CBD5E1]">No matching assets found</p>
                      <p className="text-xs text-[#64748B] mt-1">
                        Clear filters or deposit crypto via Receive to populate balances on-chain.
                      </p>
                    </td>
                  </tr>
                ) : (
                  filteredHoldings.map((item) => (
                    <tr
                      key={item.id}
                      className="h-11 hover:bg-white/[0.025] transition-colors"
                    >
                      <td className="py-2.5 px-5">
                        <div className="flex items-center gap-3">
                          <TokenAvatar symbol={item.symbol} size={30} />
                          <div>
                            <div className="font-medium text-[#F4F6F9]">{item.symbol}</div>
                            <div className="text-[11px] text-[#8A94A6]">{item.name}</div>
                          </div>
                        </div>
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="inline-flex items-center gap-2 text-[#CBD5E1]">
                          <NetworkIcon networkId={item.networkId} size={20} />
                          <span>{item.networkName}</span>
                        </div>
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[#CBD5E1]">
                        {item.priceUsd > 0 ? formatFiat(item.priceUsd, currency) : 'Testnet'}
                      </td>
                      <td
                        className={`py-2.5 px-4 text-right font-mono tabular-nums ${
                          item.change24h >= 0 ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {item.priceUsd > 0 ? formatPercent(item.change24h) : '—'}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[#F4F6F9]">
                        {formatCryptoAmount(item.balance)} {item.symbol}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums font-medium text-[#F4F6F9]">
                        {formatFiat(item.valueUsd, currency)}
                      </td>
                      <td className="py-2.5 px-5 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onNavigateSend(item.networkId, item.symbol)}
                            className="px-2 py-1 rounded bg-[#090B0F] border border-white/10 hover:border-emerald-500/40 text-[11px] text-[#CBD5E1] hover:text-[#F4F6F9]"
                          >
                            Send
                          </button>
                          <button
                            type="button"
                            onClick={() => onNavigateSwap(item.symbol)}
                            className="px-2 py-1 rounded bg-[#090B0F] border border-white/10 hover:border-emerald-500/40 text-[11px] text-[#CBD5E1] hover:text-[#F4F6F9]"
                          >
                            Swap
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Recent On-Chain & Signed Activity */}
      <div className="bg-[#11151C] border border-white/10 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[#F4F6F9]">
              On-Chain & Signed Transaction Ledger
            </h3>
            <p className="text-xs text-[#8A94A6] mt-0.5">
              Indexed across Ethereum, Arbitrum, Optimism, Base, Polygon, Sepolia, and Solana
            </p>
          </div>
          <span className="text-xs font-mono text-[#8A94A6] tabular-nums">
            {transactions.length} records
          </span>
        </div>

        {transactions.length === 0 ? (
          <div className="py-10 px-5 text-center text-xs text-[#8A94A6]">
            No transactions detected yet for this address. Send, swap, or receive assets to inspect live ledger activity.
          </div>
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {transactions.slice(0, 12).map((tx) => {
              const net = NETWORK_MAP[tx.networkId];
              return (
                <div
                  key={`${tx.hash}-${tx.timestamp}`}
                  className="px-5 py-3 flex flex-wrap items-center justify-between gap-3 text-xs hover:bg-white/[0.02]"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <NetworkIcon networkId={tx.networkId} size={26} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium capitalize text-[#F4F6F9]">
                          {tx.type} {tx.symbol}
                        </span>
                        <span className="text-[#64748B]">·</span>
                        <span className="text-[#8A94A6]">{net?.name}</span>
                        <span className="text-[#64748B]">·</span>
                        <span
                          className={
                            tx.status === 'confirmed'
                              ? 'text-emerald-400'
                              : tx.status === 'failed'
                              ? 'text-red-400'
                              : 'text-amber-400'
                          }
                        >
                          {tx.status === 'signed-sandbox' ? 'Signed (Sandbox)' : tx.status}
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-[#64748B] truncate max-w-md mt-0.5">
                        {tx.hash}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 tabular-nums">
                    <div className="text-right">
                      <div className="font-mono text-[#F4F6F9]">
                        {tx.amount} {tx.symbol}
                      </div>
                      <div className="text-[11px] text-[#64748B]">
                        {formatRelativeTime(tx.timestamp)}
                      </div>
                    </div>
                    {tx.status !== 'signed-sandbox' && net && (
                      <a
                        href={`${net.explorerUrl}/tx/${tx.hash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="p-1.5 rounded bg-[#090B0F] border border-white/10 text-[#8A94A6] hover:text-[#F4F6F9]"
                        aria-label="View on block explorer"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
