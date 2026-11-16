const CURRENCY_RATES: Record<'USD' | 'EUR' | 'GBP', { symbol: string; rate: number }> = {
  USD: { symbol: '$', rate: 1 },
  EUR: { symbol: '€', rate: 0.92 },
  GBP: { symbol: '£', rate: 0.79 },
};

export function formatFiat(
  usdAmount: number,
  currency: 'USD' | 'EUR' | 'GBP' = 'USD',
  compact = false
): string {
  const { symbol, rate } = CURRENCY_RATES[currency];
  const converted = usdAmount * rate;

  if (!Number.isFinite(converted)) return `${symbol}0.00`;

  if (compact && Math.abs(converted) >= 1_000_000_000) {
    return `${symbol}${(converted / 1_000_000_000).toFixed(2)}B`;
  }
  if (compact && Math.abs(converted) >= 1_000_000) {
    return `${symbol}${(converted / 1_000_000).toFixed(2)}M`;
  }

  const abs = Math.abs(converted);
  const decimals = abs > 0 && abs < 0.01 ? 4 : abs < 1 ? 3 : 2;
  return `${converted < 0 ? '-' : ''}${symbol}${Math.abs(converted).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

export function formatCryptoAmount(amount: number, maxDecimals = 6): string {
  if (!Number.isFinite(amount) || amount === 0) return '0';
  if (amount > 0 && amount < 0.000001) return '<0.000001';
  if (amount >= 10000) {
    return amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  });
}

export function formatPercent(pct: number): string {
  if (!Number.isFinite(pct)) return '0.00%';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

export function formatRelativeTime(timestampMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
