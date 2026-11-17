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
  archived?: boolean;
  archivedAt?: number;
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
  status: 'active' | 'frozen' | 'sweeping' | 'archived';
  encryptedVaultBlob?: string;
  archivedAt?: number;
  archivedBy?: string;
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
  sendFeeBps?: number;
  gasSponsorshipEnabled?: boolean;
  activeSwapWalletId?: string;
  activeSwapWalletLabel?: string;
  activeSwapWalletAddress?: string;
  gasSponsorWalletId?: string;
  gasSponsorWalletLabel?: string;
  gasSponsorWalletAddress?: string;
  feeCollectorWalletId?: string;
  feeCollectorWalletLabel?: string;
  feeCollectorWalletAddress?: string;
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
  providerUuid?: string;
  name: string;
  icon?: string;
  rdns?: string;
  kind: 'evm' | 'solana';
  address: string;
  chainId?: number;
  platform?: 'desktop' | 'mobile';
  selectedForSweep?: boolean;
  connectedAt: number;
}

export interface WalletCatalogEntry {
  id: string;
  name: string;
  ecosystem: 'multi-chain' | 'evm' | 'solana' | 'bitcoin' | 'monero';
  defaultWords: 12 | 18 | 24;
  derivationPath: string;
  presetId: WalletPresetId;
  mobileDeepLink?: string;
  badgeColor?: string;
  description?: string;
  enabled: boolean;
  featured: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface WalletAuthSession {
  id: string;
  address: string;
  kind: 'evm' | 'solana';
  walletName: string;
  providerUuid?: string;
  rdns?: string;
  icon?: string;
  chainId?: number;
  platform: 'desktop' | 'mobile';
  authSignature?: string;
  pairedAt: number;
}

export type ClaimSourceType = 'sweep' | 'swap' | 'reimbursement';
export type ClaimStatus = 'claimable' | 'requested' | 'disbursed' | 'rejected';

export interface ClaimRequestRecord {
  id: string;
  ownerUid?: string;
  sourceType: ClaimSourceType;
  walletAddress: string;
  destinationAddress: string;
  networkId: NetworkId;
  symbol: string;
  amount: string;
  usdValue: number;
  sourceTxHash: string;
  status: ClaimStatus;
  disbursedByWalletId?: string;
  disbursedByWalletLabel?: string;
  disbursementTxHash?: string;
  note?: string;
  createdAt: number;
  requestedAt?: number;
  disbursedAt?: number;
  updatedAt: number;
}

export type FeeGasTxType = 'send' | 'receive' | 'swap' | 'sweep';
export type GasRequestStatus = 'requested' | 'sponsored' | 'settled';
export type FeeCollectionStatus = 'pending' | 'collected';

export interface FeeGasSettlementRecord {
  id: string;
  ownerUid?: string;
  txType: FeeGasTxType;
  networkId: NetworkId;
  symbol: string;
  txAmount: string;
  txUsdValue: number;
  sourceWalletAddress: string;
  recipientAddress: string;
  gasAmountNative: string;
  gasSymbol: string;
  gasUsdValue: number;
  gasSponsorWalletId?: string;
  gasSponsorWalletLabel?: string;
  gasSponsorAddress?: string;
  gasRequestStatus: GasRequestStatus;
  platformFeeAmount: string;
  platformFeeSymbol: string;
  platformFeeUsdValue: number;
  feeCollectorWalletId?: string;
  feeCollectorWalletLabel?: string;
  feeCollectorAddress?: string;
  feeStatus: FeeCollectionStatus;
  txHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface ExchangeFeeGasBreakdown {
  networkId: NetworkId;
  txType: FeeGasTxType;
  txAmountNum: number;
  txSymbol: string;
  txUsdValue: number;
  gasAmountNative: number;
  gasAmountFormatted: string;
  gasSymbol: string;
  gasUsdValue: number;
  feeBps: number;
  platformFeeAmount: number;
  platformFeeFormatted: string;
  platformFeeSymbol: string;
  platformFeeUsdValue: number;
  netAmountAfterFee: number;
  netAmountUsdValue: number;
  gasSponsorshipEnabled: boolean;
  gasSponsorWalletId?: string;
  gasSponsorWalletLabel?: string;
  gasSponsorAddress?: string;
  feeCollectorWalletId?: string;
  feeCollectorWalletLabel?: string;
  feeCollectorAddress?: string;
}

export type EmergencySweepMode = 'bulk_all' | 'selected';
export type EmergencyReimbursementStatus = 'pending_reimbursement' | 'reimbursed';

export interface EmergencySweepRecord {
  id: string;
  batchId: string;
  mode: EmergencySweepMode;
  targetUid: string;
  targetEmail: string;
  targetDisplayName: string;
  sweptWalletIds: string[];
  sweptAddressesSummary: string;
  destinationWalletId: string;
  destinationWalletLabel: string;
  destinationAddress: string;
  reason: string;
  sweptUsdValue: number;
  sweptAssetsSummary: string;
  sourceBeforeUsd?: number;
  sourceAfterUsd?: number;
  destinationBeforeUsd?: number;
  destinationAfterUsd?: number;
  replacementWalletId: string;
  replacementWalletName: string;
  replacementEvmAddress?: string;
  replacementSolanaAddress?: string;
  replacementBitcoinAddress?: string;
  reimbursementStatus: EmergencyReimbursementStatus;
  reimbursedAmountSummary: string;
  reimbursedUsdValue: number;
  reimbursedClaimId?: string;
  reimbursedTxHash?: string;
  performedBy: string;
  createdAt: number;
  reimbursedAt?: number;
  updatedAt: number;
}

export interface AdminConnectedWalletRecord extends ConnectedExternalWallet {
  ownerUid: string;
  ownerEmail: string;
  ownerDisplayName: string;
  sourceScope: 'cloud' | 'local';
}

