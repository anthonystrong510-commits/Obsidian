import type { NetworkId } from '../types/wallet';
import { NETWORK_MAP } from '../lib/networks';

interface NetworkIconProps {
  networkId: NetworkId;
  size?: number;
  className?: string;
}

export function NetworkIcon({ networkId, size = 24, className = '' }: NetworkIconProps) {
  const net = NETWORK_MAP[networkId];
  const color = net?.color || '#64748B';

  return (
    <span
      className={`inline-flex items-center justify-center rounded-md shrink-0 font-mono font-semibold text-[10px] tracking-tight border border-white/10 ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: `${color}1A`,
        color,
      }}
      aria-hidden="true"
    >
      {net?.shortName.slice(0, 3) || 'NET'}
    </span>
  );
}

interface TokenAvatarProps {
  symbol: string;
  size?: number;
}

const TOKEN_COLORS: Record<string, string> = {
  BTC: '#F7931A',
  WBTC: '#F09242',
  ETH: '#627EEA',
  SepoliaETH: '#94A3B8',
  SOL: '#14F195',
  BNB: '#F3BA2F',
  POL: '#8247E5',
  AVAX: '#E84142',
  ARB: '#28A0F0',
  OP: '#FF0420',
  USDC: '#2775CA',
  USDT: '#26A17B',
  DAI: '#F5AC37',
  LINK: '#375BD2',
  UNI: '#FF007A',
  AAVE: '#B6509E',
  XMR: '#FF6600',
};

export function TokenAvatar({ symbol, size = 32 }: TokenAvatarProps) {
  const color = TOKEN_COLORS[symbol] || '#94A3B8';
  return (
    <span
      className="inline-flex items-center justify-center rounded-lg shrink-0 font-mono font-semibold text-xs border border-white/10"
      style={{
        width: size,
        height: size,
        backgroundColor: `${color}1F`,
        color,
      }}
      aria-hidden="true"
    >
      {symbol.slice(0, 3)}
    </span>
  );
}
