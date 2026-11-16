import { useEffect, useMemo, useState } from 'react';
import {
  Bell,
  BellRing,
  Check,
  Pause,
  Play,
  Plus,
  Trash2,
  TrendingDown,
  TrendingUp,
  Volume2,
} from 'lucide-react';
import { formatFiat, formatPercent, formatRelativeTime } from '../lib/formatters';
import { TokenAvatar } from './NetworkIcon';
import type { MarketCoin, PriceAlert } from '../types/wallet';

interface AlertsViewProps {
  initialCoinId?: string;
  markets: MarketCoin[];
  alerts: PriceAlert[];
  streamConnected: boolean;
  lastTickAt: number | null;
  currency: 'USD' | 'EUR' | 'GBP';
  onAddAlert: (alert: PriceAlert) => void;
  onToggleAlert: (id: string) => void;
  onDeleteAlert: (id: string) => void;
  onTestChime: () => void;
}

function SparklineSvg({ prices, positive }: { prices?: number[]; positive: boolean }) {
  if (!prices || prices.length < 2) {
    return <div className="h-8 w-24 bg-white/[0.03] rounded" />;
  }
  const w = 96;
  const h = 32;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  const d = prices
    .map((p, idx) => {
      const x = (idx / (prices.length - 1)) * w;
      const y = h - 3 - ((p - min) / range) * (h - 6);
      return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <path
        d={d}
        fill="none"
        stroke={positive ? '#10B981' : '#EF4444'}
        strokeWidth="1.75"
      />
    </svg>
  );
}

export function AlertsView({
  initialCoinId,
  markets,
  alerts,
  streamConnected,
  lastTickAt,
  currency,
  onAddAlert,
  onToggleAlert,
  onDeleteAlert,
  onTestChime,
}: AlertsViewProps) {
  const [selectedCoinId, setSelectedCoinId] = useState(initialCoinId || 'bitcoin');
  const [condition, setCondition] = useState<'above' | 'below' | 'change24h'>('above');
  const [targetValue, setTargetValue] = useState('');
  const [repeat, setRepeat] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [browserNotification, setBrowserNotification] = useState(true);
  const [notifPermission, setNotifPermission] = useState<string>(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  );

  useEffect(() => {
    if (initialCoinId) setSelectedCoinId(initialCoinId);
  }, [initialCoinId]);

  const selectedCoin = useMemo(
    () => markets.find((m) => m.id === selectedCoinId) || markets[0],
    [markets, selectedCoinId]
  );

  // Pre-fill smart target when switching asset or condition
  useEffect(() => {
    if (!selectedCoin) return;
    if (condition === 'above') {
      setTargetValue((selectedCoin.current_price * 1.02).toFixed(selectedCoin.current_price < 2 ? 4 : 2));
    } else if (condition === 'below') {
      setTargetValue((selectedCoin.current_price * 0.98).toFixed(selectedCoin.current_price < 2 ? 4 : 2));
    } else {
      setTargetValue('5');
    }
  }, [selectedCoinId, condition, selectedCoin?.id]);

  const requestPushPermission = async () => {
    if (typeof Notification === 'undefined') return;
    const perm = await Notification.requestPermission();
    setNotifPermission(perm);
  };

  const handleCreate = () => {
    if (!selectedCoin) return;
    const val = Number(targetValue);
    if (!Number.isFinite(val) || val <= 0) return;

    onAddAlert({
      id: crypto.randomUUID(),
      coinId: selectedCoin.id,
      symbol: selectedCoin.symbol,
      name: selectedCoin.name,
      condition,
      targetValue: val,
      active: true,
      repeat,
      soundEnabled,
      browserNotification,
      createdAt: Date.now(),
    });
  };

  const activeAlerts = alerts.filter((a) => a.active);
  const triggeredAlerts = alerts.filter((a) => !a.active && a.triggeredAt);

  return (
    <div className="space-y-8">
      {/* Real-Time Stream Header + Create Alert Form */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 bg-[#11151C] border border-white/10 rounded-xl p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-[#F4F6F9]">
                Create Real-Time Price Alert
              </h2>
              <div className="flex items-center gap-2 text-xs text-[#8A94A6] mt-1">
                <span
                  className={`w-2 h-2 rounded-full ${
                    streamConnected ? 'bg-emerald-400' : 'bg-amber-400'
                  }`}
                />
                <span>
                  {streamConnected ? 'Live SSE Stream Connected' : 'Reconnecting stream...'}
                </span>
                {lastTickAt && (
                  <>
                    <span className="text-white/20">·</span>
                    <span className="font-mono">{formatRelativeTime(lastTickAt)}</span>
                  </>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={onTestChime}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#CBD5E1] hover:text-[#F4F6F9]"
            >
              <Volume2 className="w-3.5 h-3.5" />
              <span>Test Chime</span>
            </button>
          </div>

          <div className="space-y-3.5">
            <div>
              <label className="block text-xs text-[#8A94A6] mb-1.5">Asset</label>
              <select
                value={selectedCoinId}
                onChange={(e) => setSelectedCoinId(e.target.value)}
                className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-[#F4F6F9]"
              >
                {markets.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.symbol} — {m.name} ({formatFiat(m.current_price, currency)})
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-[#8A94A6] mb-1.5">Condition</label>
                <select
                  value={condition}
                  onChange={(e) =>
                    setCondition(e.target.value as 'above' | 'below' | 'change24h')
                  }
                  className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2.5 text-xs text-[#F4F6F9]"
                >
                  <option value="above">Price crosses above</option>
                  <option value="below">Price crosses below</option>
                  <option value="change24h">24h % move exceeds</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-[#8A94A6] mb-1.5">
                  {condition === 'change24h' ? 'Threshold (%)' : 'Target Price (USD)'}
                </label>
                <input
                  type="number"
                  step="any"
                  value={targetValue}
                  onChange={(e) => setTargetValue(e.target.value)}
                  className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2.5 font-mono text-sm text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 pt-1 text-xs text-[#CBD5E1]">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={soundEnabled}
                  onChange={(e) => setSoundEnabled(e.target.checked)}
                  className="rounded border-white/20 bg-[#090B0F] text-emerald-500"
                />
                <span>Audio Chime</span>
              </label>

              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={repeat}
                  onChange={(e) => setRepeat(e.target.checked)}
                  className="rounded border-white/20 bg-[#090B0F] text-emerald-500"
                />
                <span>Repeat Trigger</span>
              </label>

              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={browserNotification}
                  onChange={(e) => setBrowserNotification(e.target.checked)}
                  className="rounded border-white/20 bg-[#090B0F] text-emerald-500"
                />
                <span>Desktop Push</span>
              </label>
            </div>

            {notifPermission === 'default' && (
              <button
                type="button"
                onClick={requestPushPermission}
                className="w-full py-2 px-3 rounded-lg bg-[#090B0F] border border-white/10 hover:border-emerald-500/40 text-xs text-[#CBD5E1]"
              >
                Enable Browser Push Notifications
              </button>
            )}
            {notifPermission === 'granted' && (
              <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
                <Check className="w-3.5 h-3.5" />
                <span>Browser push notifications authorized</span>
              </div>
            )}

            <button
              type="button"
              onClick={handleCreate}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] font-semibold text-sm transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>Arm Price Alert</span>
            </button>
          </div>
        </div>

        {/* Armed & Triggered Alerts Panel */}
        <div className="lg:col-span-7 bg-[#11151C] border border-white/10 rounded-xl overflow-hidden flex flex-col">
          <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-[#F4F6F9]">
                Active Watchlist Triggers
              </h3>
            </div>
            <span className="text-xs font-mono text-[#8A94A6] tabular-nums">
              {activeAlerts.length} armed · {triggeredAlerts.length} triggered
            </span>
          </div>

          {alerts.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center py-14 px-6 text-center">
              <BellRing className="w-7 h-7 text-[#525D70] mb-2" />
              <p className="text-sm text-[#CBD5E1]">No price alerts armed</p>
              <p className="text-xs text-[#64748B] mt-1 max-w-sm">
                Create an alert on the left. Live price ticks evaluate every 8 seconds over the SSE stream.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-white/[0.06] overflow-y-auto max-h-96">
              {alerts.map((alert) => {
                const liveCoin = markets.find((m) => m.id === alert.coinId);
                return (
                  <div
                    key={alert.id}
                    className="px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 text-xs hover:bg-white/[0.02]"
                  >
                    <div className="flex items-center gap-3">
                      <TokenAvatar symbol={alert.symbol} size={30} />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-[#F4F6F9]">
                            {alert.symbol}
                          </span>
                          <span className="text-[#8A94A6]">
                            {alert.condition === 'above'
                              ? 'Crosses Above'
                              : alert.condition === 'below'
                              ? 'Crosses Below'
                              : '24h Move ≥'}
                          </span>
                          <span className="font-mono font-semibold text-[#F4F6F9] tabular-nums">
                            {alert.condition === 'change24h'
                              ? `${alert.targetValue}%`
                              : `$${alert.targetValue.toLocaleString()}`}
                          </span>
                        </div>
                        <div className="text-[11px] text-[#64748B] mt-0.5 tabular-nums">
                          <span>
                            Live:{' '}
                            {liveCoin
                              ? formatFiat(liveCoin.current_price, currency)
                              : '—'}
                          </span>
                          <span className="mx-1.5">·</span>
                          <span
                            className={
                              alert.active
                                ? 'text-emerald-400'
                                : alert.triggeredAt
                                ? 'text-amber-400'
                                : 'text-[#64748B]'
                            }
                          >
                            {alert.active
                              ? 'Armed'
                              : alert.triggeredAt
                              ? `Triggered ${formatRelativeTime(alert.triggeredAt)}`
                              : 'Paused'}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onToggleAlert(alert.id)}
                        className="p-1.5 rounded bg-[#090B0F] border border-white/10 text-[#CBD5E1] hover:text-[#F4F6F9]"
                        aria-label={alert.active ? 'Pause alert' : 'Arm alert'}
                      >
                        {alert.active ? (
                          <Pause className="w-3.5 h-3.5" />
                        ) : (
                          <Play className="w-3.5 h-3.5 text-emerald-400" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteAlert(alert.id)}
                        className="p-1.5 rounded bg-[#090B0F] border border-white/10 text-[#8A94A6] hover:text-red-400"
                        aria-label="Delete alert"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Live Market Radar Grid */}
      <div className="bg-[#11151C] border border-white/10 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[#F4F6F9]">Live Market Radar</h3>
            <p className="text-xs text-[#8A94A6] mt-0.5">
              Click any asset to pre-populate a real-time price alert target
            </p>
          </div>
          <span className="text-xs text-[#8A94A6] tabular-nums">
            {markets.length} tracked markets
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 text-[11px] font-medium text-[#8A94A6]">
                <th className="py-3 px-5">Asset</th>
                <th className="py-3 px-4 text-right">Live Price</th>
                <th className="py-3 px-4 text-right">24h Change</th>
                <th className="py-3 px-4 text-right">24h Range</th>
                <th className="py-3 px-4 text-right">7D Trend</th>
                <th className="py-3 px-5 text-right">Alert</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-xs">
              {markets.map((coin) => {
                const pos = coin.price_change_percentage_24h >= 0;
                return (
                  <tr
                    key={coin.id}
                    className="h-12 hover:bg-white/[0.025] transition-colors"
                  >
                    <td className="py-2.5 px-5">
                      <div className="flex items-center gap-3">
                        <TokenAvatar symbol={coin.symbol} size={28} />
                        <div>
                          <div className="font-medium text-[#F4F6F9]">{coin.symbol}</div>
                          <div className="text-[11px] text-[#8A94A6]">{coin.name}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono font-medium text-[#F4F6F9] tabular-nums">
                      {formatFiat(coin.current_price, currency)}
                    </td>
                    <td
                      className={`py-2.5 px-4 text-right font-mono tabular-nums ${
                        pos ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      <span className="inline-flex items-center gap-1">
                        {pos ? (
                          <TrendingUp className="w-3.5 h-3.5" />
                        ) : (
                          <TrendingDown className="w-3.5 h-3.5" />
                        )}
                        {formatPercent(coin.price_change_percentage_24h)}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-[11px] text-[#8A94A6] tabular-nums">
                      {formatFiat(coin.low_24h, currency)} – {formatFiat(coin.high_24h, currency)}
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <div className="inline-flex justify-end">
                        <SparklineSvg
                          prices={coin.sparkline_in_7d?.price}
                          positive={pos}
                        />
                      </div>
                    </td>
                    <td className="py-2.5 px-5 text-right">
                      <button
                        type="button"
                        onClick={() => setSelectedCoinId(coin.id)}
                        className="px-2.5 py-1 rounded bg-[#090B0F] border border-white/10 hover:border-emerald-500/50 text-[11px] text-[#CBD5E1]"
                      >
                        Set Alert
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
