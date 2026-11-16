export type NetworkId =
  | 'ethereum'
  | 'arbitrum'
  | 'optimism'
  | 'base'
  | 'polygon'
  | 'bsc'
  | 'avalanche'
  | 'solana'
  | 'bitcoin'
  | 'monero'
  | 'sepolia';

export type NetworkFamily = 'evm' | 'solana' | 'bitcoin' | 'monero';

export type WalletPresetId =
  | 'standard'
  | 'metamask'
  | 'phantom'
  | 'ledger'
  | 'trust'
  | 'coinbase'
  | 'electrum';

export interface TokenConfig {
  symbol: string;
  name: string;
  decimals: number;
  address: string;
  coinGeckoId: string;
  networkId: NetworkId;
  isCustom?: boolean;
}

export interface NetworkConfig {
  id: NetworkId;
  name: string;
  shortName: string;
  family: NetworkFamily;
  chainId?: number;
  symbol: string;
  decimals: number;
  coinGeckoId: string;
  explorerUrl: string;
  color: string;
  isTestnet?: boolean;
  defaultDerivationPath: string;
  tokens: TokenConfig[];
}

export interface DerivedAddresses {
  evmAddress: string;
  evmPrivateKey?: string;
  evmPath: string;
  solanaAddress: string;
  solanaSecretBase58?: string;
  solanaPath: string;
  bitcoinAddress: string;
  bitcoinPrivateKeyHex?: string;
  bitcoinPath: string;
  moneroAddress: string;
  moneroPath: string;
}

export interface WalletAccount {
  id: string;
  name: string;
  type: 'mnemonic' | 'privateKey' | 'watchOnly';
  wordCount?: 12 | 18 | 24;
  preset?: WalletPresetId;
  accountIndex: number;
  addresses: DerivedAddresses;
  encryptedSecret?: string;
  createdAt: number;
}

export interface UnlockedSecrets {
  mnemonic?: string;
  passphrase?: string;
  evmPrivateKey?: string;
  solanaSecretBase58?: string;
  bitcoinPrivateKeyHex?: string;
  moneroSpendKeyHex?: string;
  moneroViewKeyHex?: string;
}

export interface MarketCoin {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  price_change_percentage_24h: number;
  market_cap: number;
  total_volume: number;
  high_24h: number;
  low_24h: number;
  sparkline_in_7d?: { price: number[] };
  last_updated: string;
  source: string;
}

export interface PortfolioHolding {
  id: string;
  networkId: NetworkId;
  networkName: string;
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  coinGeckoId: string;
  balance: number;
  balanceRaw: string;
  priceUsd: number;
  change24h: number;
  valueUsd: number;
  isNative: boolean;
  isCustom?: boolean;
}

export interface WalletTransaction {
  hash: string;
  networkId: NetworkId;
  type: 'send' | 'receive' | 'swap' | 'sweep' | 'on-chain';
  status: 'confirmed' | 'pending' | 'signed-sandbox' | 'failed';
  from: string;
  to: string;
  symbol: string;
  amount: string;
  usdValue?: number;
  feeFormatted?: string;
  rawSignedHex?: string;
  timestamp: number;
  note?: string;
}

export interface PriceAlert {
  id: string;
  coinId: string;
  symbol: string;
  name: string;
  condition: 'above' | 'below' | 'change24h';
  targetValue: number;
  active: boolean;
  repeat: boolean;
  soundEnabled: boolean;
  browserNotification: boolean;
  createdAt: number;
  triggeredAt?: number;
  triggeredPrice?: number;
}

export interface AddressBookEntry {
  id: string;
  label: string;
  address: string;
  networkFamily: NetworkFamily;
  note?: string;
  createdAt: number;
}

export interface NetworkTelemetry {
  networkId: NetworkId;
  blockHeight: number | null;
  gasGwei: number | null;
  latencyMs: number | null;
  healthy: boolean;
}

export type ExchangeWalletTier = 'cold' | 'pool' | 'hot';

export interface ExchangeTreasuryWallet {
  id: string;
  tier: ExchangeWalletTier;
  label: string;
  networkFamily: 'multi-chain' | 'evm' | 'solana' | 'bitcoin' | 'monero';
  evmAddress?: string;
  solanaAddress?: string;
  bitcoinAddress?: string;
  moneroAddress?: string;
  quorum: string;
  allocationCapPct: number;
  status: 'active' | 'frozen' | 'sweeping';
  encryptedVaultBlob?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface ManagedUserRecord {
  uid: string;
  displayName: string;
  email: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended' | 'kyc_pending';
  provider: 'google' | 'password';
  walletCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface AdminAuditLogEntry {
  id: string;
  actorUid: string;
  action: string;
  targetId: string;
  summary: string;
  createdAt: number;
}

export interface ExchangeSystemConfig {
  maintenanceMode: boolean;
  withdrawalsPaused: boolean;
  hotWalletMaxPct: number;
  swapFeeBps: number;
  updatedBy: string;
  updatedAt: number;
}

export interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
}

export interface DiscoveredWalletProvider {
  uuid: string;
  name: string;
  icon?: string;
  rdns?: string;
  kind: 'evm' | 'solana';
  provider?: Eip1193Provider;
}

export interface ConnectedExternalWallet {
  id: string;
  name: string;
  icon?: string;
  rdns?: string;
  kind: 'evm' | 'solana';
  address: string;
  chainId?: number;
  connectedAt: number;
}
