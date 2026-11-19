import {
  BrowserProvider,
  Contract,
  Wallet,
  formatEther,
  formatUnits,
  parseEther,
  parseUnits,
} from 'ethers';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { NETWORK_MAP } from './networks';
import { getEvmFallbackProvider, getEvmProvider, postSolanaJsonRpc } from './web3Service';
import type {
  ConnectedExternalWallet,
  DiscoveredWalletProvider,
  Eip1193Provider,
  NetworkId,
  PortfolioHolding,
  UnlockedSecrets,
  WalletAuthSession,
  WalletTransaction,
} from '../types/wallet';

const ERC20_TRANSFER_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

const ADD_CHAIN_PARAMS: Partial<
  Record<
    NetworkId,
    {
      chainId: string;
      chainName: string;
      nativeCurrency: { name: string; symbol: string; decimals: number };
      rpcUrls: string[];
      blockExplorerUrls: string[];
    }
  >
> = {
  arbitrum: {
    chainId: '0xa4b1',
    chainName: 'Arbitrum One',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://arb1.arbitrum.io/rpc'],
    blockExplorerUrls: ['https://arbiscan.io'],
  },
  optimism: {
    chainId: '0xa',
    chainName: 'OP Mainnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://mainnet.optimism.io'],
    blockExplorerUrls: ['https://optimistic.etherscan.io'],
  },
  base: {
    chainId: '0x2105',
    chainName: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://mainnet.base.org'],
    blockExplorerUrls: ['https://basescan.org'],
  },
  polygon: {
    chainId: '0x89',
    chainName: 'Polygon PoS',
    nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
    rpcUrls: ['https://polygon-rpc.com'],
    blockExplorerUrls: ['https://polygonscan.com'],
  },
  bsc: {
    chainId: '0x38',
    chainName: 'BNB Smart Chain',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: ['https://bsc-dataseed.binance.org'],
    blockExplorerUrls: ['https://bscscan.com'],
  },
  avalanche: {
    chainId: '0xa86a',
    chainName: 'Avalanche C-Chain',
    nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
    rpcUrls: ['https://api.avax.network/ext/bc/C/rpc'],
    blockExplorerUrls: ['https://snowtrace.io'],
  },
  sepolia: {
    chainId: '0xaa36a7',
    chainName: 'Sepolia Testnet',
    nativeCurrency: { name: 'SepoliaETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
    blockExplorerUrls: ['https://sepolia.etherscan.io'],
  },
};

export interface MobileWalletAppConfig {
  id: string;
  name: string;
  chains: string;
  color: string;
  buildDeepLink: (targetUrl: string) => string;
}

export const MOBILE_WALLET_APPS: MobileWalletAppConfig[] = [
  {
    id: 'metamask',
    name: 'MetaMask Mobile',
    chains: 'Ethereum · L2s · EVM',
    color: '#F6851B',
    buildDeepLink: (targetUrl) =>
      `https://metamask.app.link/dapp/${targetUrl.replace(/^https?:\/\//, '')}`,
  },
  {
    id: 'trust',
    name: 'Trust Wallet',
    chains: 'Multi-Chain · EVM · SOL',
    color: '#3375BB',
    buildDeepLink: (targetUrl) =>
      `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(targetUrl)}`,
  },
  {
    id: 'coinbase',
    name: 'Coinbase Wallet',
    chains: 'Base · EVM · Solana',
    color: '#0052FF',
    buildDeepLink: (targetUrl) =>
      `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(targetUrl)}`,
  },
  {
    id: 'phantom',
    name: 'Phantom Mobile',
    chains: 'Solana · Ethereum · Base',
    color: '#AB9FF2',
    buildDeepLink: (targetUrl) => {
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      return `https://phantom.app/ul/browse/${encodeURIComponent(targetUrl)}?ref=${encodeURIComponent(origin)}`;
    },
  },
  {
    id: 'okx',
    name: 'OKX Wallet',
    chains: 'Multi-Chain Web3',
    color: '#94A3B8',
    buildDeepLink: (targetUrl) =>
      `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(targetUrl)}`,
  },
  {
    id: 'safepal',
    name: 'SafePal App',
    chains: 'EVM · BNB · Polygon',
    color: '#4A55FF',
    buildDeepLink: (targetUrl) =>
      `https://link.safepal.io/dapp?url=${encodeURIComponent(targetUrl)}`,
  },
  {
    id: 'bitget',
    name: 'Bitget Wallet',
    chains: 'Multi-Chain Mobile',
    color: '#00F0FF',
    buildDeepLink: (targetUrl) =>
      `https://bkcode.vip?action=dapp&url=${encodeURIComponent(targetUrl)}`,
  },
  {
    id: 'rainbow',
    name: 'imToken Wallet',
    chains: 'ETH · L2s · BTC · TRX',
    color: '#11C4D1',
    buildDeepLink: (targetUrl) =>
      `imtokenv2://navigate/DappView?url=${encodeURIComponent(targetUrl)}`,
  },
];

export function isMobileUserAgent(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
}

export function isInAppWalletBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    ethereum?: unknown;
    trustwallet?: { ethereum?: unknown };
    okxwallet?: unknown;
    coinbaseWalletExtension?: unknown;
    phantom?: { solana?: unknown };
    solflare?: unknown;
    solana?: unknown;
  };
  return Boolean(
    w.ethereum ||
      w.trustwallet?.ethereum ||
      w.okxwallet ||
      w.coinbaseWalletExtension ||
      w.phantom?.solana ||
      w.solflare ||
      w.solana
  );
}

export function buildSweepLandingUrl(
  destEvm?: string,
  destSol?: string,
  vaultName?: string
): string {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.origin);
  url.searchParams.set('tab', 'sweep');
  if (destEvm) url.searchParams.set('destEvm', destEvm);
  if (destSol) url.searchParams.set('destSol', destSol);
  if (vaultName) url.searchParams.set('vaultName', vaultName);
  return url.toString();
}

export function buildWalletAuthLandingUrl(): string {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.origin);
  url.searchParams.set('auth', 'wallet');
  return url.toString();
}

export function formatDeepLinkTemplate(template: string, targetUrl: string): string {
  const cleanTemplate = template.trim();
  if (!cleanTemplate || /^[\x00-\x1f\s]*(javascript|data|vbscript|file):/i.test(cleanTemplate)) {
    return '#';
  }
  const noProto = targetUrl.replace(/^https?:\/\//, '');
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const resolved = cleanTemplate
    .replace(/\{dappUrlNoProto\}/g, noProto)
    .replace(/\{dappUrl\}/g, encodeURIComponent(targetUrl))
    .replace(/\{origin\}/g, encodeURIComponent(origin));
  try {
    const parsed = new URL(resolved);
    if (
      [
        'https:',
        'metamask:',
        'trust:',
        'phantom:',
        'cbwallet:',
        'okx:',
        'rainbow:',
      ].includes(parsed.protocol)
    ) {
      return resolved;
    }
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      return resolved;
    }
  } catch {
    // Reject malformed URLs
  }
  return '#';
}

interface Eip6963AnnounceEvent extends Event {
  detail?: {
    info?: { uuid?: string; name?: string; icon?: string; rdns?: string };
    provider?: Eip1193Provider;
  };
}

interface SolanaPubKeyLike {
  toBase58?: () => string;
  toString?: () => string;
}

interface SolanaProviderLike {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isTrust?: boolean;
  isConnected?: boolean;
  publicKey?: SolanaPubKeyLike | string | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<unknown>;
  disconnect?: () => Promise<void>;
}

interface WindowWithWallets extends Window {
  ethereum?: Eip1193Provider & {
    providers?: Array<
      Eip1193Provider & {
        isMetaMask?: boolean;
        isRabby?: boolean;
        isCoinbaseWallet?: boolean;
        isTrust?: boolean;
        isOkxWallet?: boolean;
        isBitKeep?: boolean;
        isPhantom?: boolean;
      }
    >;
    isMetaMask?: boolean;
    isRabby?: boolean;
    isCoinbaseWallet?: boolean;
    isTrust?: boolean;
    isOkxWallet?: boolean;
    isBitKeep?: boolean;
    isPhantom?: boolean;
  };
  trustwallet?: { ethereum?: Eip1193Provider; solana?: SolanaProviderLike };
  okxwallet?: Eip1193Provider & { solana?: SolanaProviderLike };
  coinbaseWalletExtension?: Eip1193Provider;
  bitkeep?: { ethereum?: Eip1193Provider };
  phantom?: {
    ethereum?: Eip1193Provider;
    solana?: SolanaProviderLike;
  };
  solflare?: SolanaProviderLike;
  solana?: SolanaProviderLike;
}

function extractSolanaAddress(resp: unknown, provider?: SolanaProviderLike | null): string {
  const candidates: unknown[] = [
    (resp as { publicKey?: unknown })?.publicKey,
    provider?.publicKey,
    resp,
  ];
  for (const cand of candidates) {
    if (!cand) continue;
    if (typeof cand === 'string' && cand.length >= 32 && cand.length <= 48) {
      return cand;
    }
    const obj = cand as SolanaPubKeyLike;
    if (typeof obj.toBase58 === 'function') {
      try {
        const b58 = obj.toBase58();
        if (b58 && b58.length >= 32) return b58;
      } catch {
        // continue
      }
    }
    if (typeof obj.toString === 'function') {
      try {
        const str = obj.toString();
        if (str && str !== '[object Object]' && str.length >= 32 && str.length <= 48) {
          return str;
        }
      } catch {
        // continue
      }
    }
  }
  return '';
}

// Live in-memory provider map supporting multiple simultaneous connected wallets
const sessionProviderMap = new Map<string, Eip1193Provider>();

export function makeSessionId(providerKey: string, address: string): string {
  const cleanAddr = address.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
  const cleanProv = providerKey.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 48);
  return `wc_${cleanProv}_${cleanAddr}`;
}

export function registerSessionProvider(sessionId: string, provider: Eip1193Provider): void {
  sessionProviderMap.set(sessionId, provider);
}

export function resolveProviderForSession(
  session: ConnectedExternalWallet,
  discoveredProviders: DiscoveredWalletProvider[]
): Eip1193Provider | null {
  const direct = sessionProviderMap.get(session.id);
  if (direct) return direct;

  // Match by stable EIP-6963 RDNS first (UUID changes every page load per spec)
  if (session.rdns) {
    const byRdns = discoveredProviders.find((p) => p.rdns === session.rdns)?.provider;
    if (byRdns) {
      sessionProviderMap.set(session.id, byRdns);
      return byRdns;
    }
  }

  if (session.providerUuid) {
    const byUuid = discoveredProviders.find((p) => p.uuid === session.providerUuid)?.provider;
    if (byUuid) {
      sessionProviderMap.set(session.id, byUuid);
      return byUuid;
    }
  }

  const baseName = session.name.replace(/\s+#\d+$/, '').toLowerCase();
  const byName = discoveredProviders.find(
    (p) => p.kind === session.kind && p.name.toLowerCase().includes(baseName)
  )?.provider;
  if (byName) {
    sessionProviderMap.set(session.id, byName);
    return byName;
  }

  const byKind = discoveredProviders.find((p) => p.kind === session.kind)?.provider || null;
  if (byKind) {
    sessionProviderMap.set(session.id, byKind);
    return byKind;
  }

  if (session.kind === 'evm' && typeof window !== 'undefined') {
    const win = window as unknown as WindowWithWallets;
    if (win.ethereum) {
      sessionProviderMap.set(session.id, win.ethereum);
      return win.ethereum;
    }
  }
  return null;
}

export async function rehydrateConnectedProviders(
  sessions: ConnectedExternalWallet[],
  discoveredProviders: DiscoveredWalletProvider[]
): Promise<string[]> {
  if (sessions.length === 0) return [];
  const activeSessionIds: string[] = [];
  const evmSessions = sessions.filter((s) => s.kind === 'evm');
  if (evmSessions.length === 0) return [];

  const evmProviders = discoveredProviders.filter((p) => p.kind === 'evm' && p.provider);

  for (const prov of evmProviders) {
    // Only query providers that match at least one saved session to avoid spamming all browser extensions
    const matchesSavedSession = evmSessions.some(
      (s) =>
        (s.rdns && prov.rdns === s.rdns) ||
        (s.providerUuid && prov.uuid === s.providerUuid) ||
        prov.name.toLowerCase().includes(s.name.replace(/\s+#\d+$/, '').toLowerCase().split(' ')[0])
    );
    if (!matchesSavedSession && evmProviders.length > 1) continue;

    try {
      const authorized = (await prov.provider!.request({ method: 'eth_accounts' })) as string[];
      if (!Array.isArray(authorized) || authorized.length === 0) continue;
      const lowerSet = new Set(authorized.map((a) => a.toLowerCase()));
      for (const sess of evmSessions) {
        if (lowerSet.has(sess.address.toLowerCase())) {
          registerSessionProvider(sess.id, prov.provider!);
          activeSessionIds.push(sess.id);
        }
      }
    } catch {
      // Skip provider if locked
    }
  }

  return activeSessionIds;
}

export function discoverExternalWalletProviders(
  onProvidersChanged: (providers: DiscoveredWalletProvider[]) => void
): () => void {
  const discovered = new Map<string, DiscoveredWalletProvider>();
  const win = window as unknown as WindowWithWallets;

  const emit = () => {
    onProvidersChanged(Array.from(discovered.values()));
  };

  const handleAnnounce = (evt: Event) => {
    const detail = (evt as Eip6963AnnounceEvent).detail;
    if (!detail?.info?.uuid || !detail?.provider) return;
    discovered.set(detail.info.uuid, {
      uuid: detail.info.uuid,
      name: detail.info.name || 'Browser Wallet',
      icon: detail.info.icon,
      rdns: detail.info.rdns,
      kind: 'evm',
      provider: detail.provider,
    });
    emit();
  };

  const scanLegacyAndMobileInjected = () => {
    const evmCandidates: Array<{
      uuid: string;
      name: string;
      rdns?: string;
      provider: Eip1193Provider;
    }> = [];

    if (win.ethereum) {
      const multi =
        Array.isArray(win.ethereum.providers) && win.ethereum.providers.length > 0
          ? win.ethereum.providers
          : [win.ethereum];

      multi.forEach((prov, idx) => {
        const name = prov.isRabby
          ? 'Rabby Wallet'
          : prov.isCoinbaseWallet
          ? 'Coinbase Wallet'
          : prov.isTrust
          ? 'Trust Wallet'
          : prov.isOkxWallet
          ? 'OKX Wallet'
          : prov.isBitKeep
          ? 'Bitget Wallet'
          : prov.isPhantom
          ? 'Phantom'
          : prov.isMetaMask
          ? 'MetaMask'
          : 'Injected Web3 Wallet';
        const rdns = prov.isPhantom
          ? 'app.phantom'
          : prov.isMetaMask
          ? 'io.metamask'
          : prov.isCoinbaseWallet
          ? 'com.coinbase.wallet'
          : prov.isTrust
          ? 'com.trustwallet.app'
          : prov.isRabby
          ? 'io.rabby'
          : prov.isOkxWallet
          ? 'com.okex.wallet'
          : undefined;
        evmCandidates.push({
          uuid: `injected-evm-${idx}-${name.toLowerCase().replace(/\s+/g, '-')}`,
          name,
          rdns,
          provider: prov,
        });
      });
    }

    if (win.trustwallet?.ethereum) {
      evmCandidates.push({
        uuid: 'injected-trust-mobile',
        name: 'Trust Wallet',
        rdns: 'com.trustwallet.app',
        provider: win.trustwallet.ethereum,
      });
    }
    if (win.okxwallet) {
      evmCandidates.push({
        uuid: 'injected-okx-mobile',
        name: 'OKX Wallet',
        rdns: 'com.okex.wallet',
        provider: win.okxwallet,
      });
    }
    if (win.coinbaseWalletExtension) {
      evmCandidates.push({
        uuid: 'injected-coinbase-mobile',
        name: 'Coinbase Wallet',
        rdns: 'com.coinbase.wallet',
        provider: win.coinbaseWalletExtension,
      });
    }
    if (win.bitkeep?.ethereum) {
      evmCandidates.push({
        uuid: 'injected-bitget-mobile',
        name: 'Bitget Wallet',
        rdns: 'com.bitget.web3',
        provider: win.bitkeep.ethereum,
      });
    }
    if (win.phantom?.ethereum) {
      evmCandidates.push({
        uuid: 'injected-phantom-evm',
        name: 'Phantom',
        rdns: 'app.phantom',
        provider: win.phantom.ethereum,
      });
    }

    for (const c of evmCandidates) {
      const alreadyHave = Array.from(discovered.values()).some(
        (p) =>
          p.kind === 'evm' &&
          ((c.rdns && p.rdns === c.rdns) ||
            p.name.toLowerCase().includes(c.name.toLowerCase().split(' ')[0]))
      );
      if (!alreadyHave) {
        discovered.set(c.uuid, {
          uuid: c.uuid,
          name: c.name,
          rdns: c.rdns,
          kind: 'evm',
          provider: c.provider,
        });
      }
    }

    const solProvider = win.phantom?.solana || win.solana || win.solflare;
    if (solProvider) {
      const isPhantomSol = Boolean(win.phantom?.solana || solProvider.isPhantom);
      const isSolflare = Boolean(solProvider.isSolflare);
      discovered.set('injected-solana-provider', {
        uuid: 'injected-solana-provider',
        name: isPhantomSol ? 'Phantom (Solana)' : isSolflare ? 'Solflare (Solana)' : 'Solana Wallet',
        rdns: isPhantomSol ? 'app.phantom' : isSolflare ? 'com.solflare.wallet' : undefined,
        kind: 'solana',
      });
    }
    emit();
  };

  window.addEventListener('eip6963:announceProvider', handleAnnounce);
  window.addEventListener('ethereum#initialized', scanLegacyAndMobileInjected);
  window.addEventListener('solana#initialized', scanLegacyAndMobileInjected);

  // Dispatch eip6963:requestProvider once per discovery lifecycle to prevent extension EventEmitter warnings
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  scanLegacyAndMobileInjected();
  const delayedTimer = setTimeout(scanLegacyAndMobileInjected, 450);

  return () => {
    clearTimeout(delayedTimer);
    window.removeEventListener('eip6963:announceProvider', handleAnnounce);
    window.removeEventListener('ethereum#initialized', scanLegacyAndMobileInjected);
    window.removeEventListener('solana#initialized', scanLegacyAndMobileInjected);
  };
}

async function connectEvmProviderAccounts(
  evmProvider: Eip1193Provider,
  item: DiscoveredWalletProvider,
  platform: 'desktop' | 'mobile',
  forceAccountPicker?: boolean
): Promise<ConnectedExternalWallet[]> {
  const stableProviderKey = item.rdns || item.uuid;
  let accounts: string[] = [];

  if (forceAccountPicker) {
    try {
      await evmProvider.request({
        method: 'wallet_requestPermissions',
        params: [{ eth_accounts: {} }],
      });
    } catch {
      // Fallback smoothly to eth_requestAccounts
    }
    accounts = (await evmProvider.request({
      method: 'eth_requestAccounts',
    })) as string[];
  } else {
    try {
      const existing = (await evmProvider.request({
        method: 'eth_accounts',
      })) as string[];
      if (Array.isArray(existing) && existing.length > 0) {
        accounts = existing;
      }
    } catch {
      // Proceed to interactive eth_requestAccounts
    }

    if (accounts.length === 0) {
      accounts = (await evmProvider.request({
        method: 'eth_requestAccounts',
      })) as string[];
    }
  }

  if (!Array.isArray(accounts) || accounts.length === 0) {
    return [];
  }

  let chainId = 1;
  try {
    const chainHex = (await evmProvider.request({
      method: 'eth_chainId',
    })) as string;
    chainId = chainHex ? parseInt(chainHex, 16) : 1;
  } catch {
    chainId = 1;
  }

  return accounts.map((addr, idx) => {
    const sid = makeSessionId(stableProviderKey, addr);
    registerSessionProvider(sid, evmProvider);
    return {
      id: sid,
      providerUuid: item.uuid,
      name: accounts.length > 1 ? `${item.name} #${idx + 1}` : item.name,
      icon: item.icon,
      rdns: item.rdns,
      kind: 'evm',
      address: addr,
      chainId,
      platform,
      selectedForSweep: true,
      connectedAt: Date.now(),
    };
  });
}

async function connectSolanaProviderAccount(
  sol: SolanaProviderLike,
  item: DiscoveredWalletProvider,
  platform: 'desktop' | 'mobile'
): Promise<ConnectedExternalWallet | null> {
  const stableProviderKey = item.rdns || item.uuid || 'solana';
  let addr = extractSolanaAddress(null, sol);

  if (!addr) {
    try {
      const trustedResp = await sol.connect({ onlyIfTrusted: true });
      addr = extractSolanaAddress(trustedResp, sol);
    } catch {
      // Proceed to interactive connect()
    }
  }

  if (!addr) {
    const resp = await sol.connect();
    addr = extractSolanaAddress(resp, sol);
  }

  if (!addr) return null;

  const sid = makeSessionId(stableProviderKey, addr);
  const cleanName = item.name.includes('Solana') ? item.name : `${item.name} (Solana)`;
  return {
    id: sid,
    providerUuid: item.uuid,
    name: cleanName,
    icon: item.icon,
    rdns: item.rdns || (sol.isPhantom ? 'app.phantom' : undefined),
    kind: 'solana',
    address: addr,
    platform,
    selectedForSweep: true,
    connectedAt: Date.now(),
  };
}

export async function connectDiscoveredWalletAccounts(
  item: DiscoveredWalletProvider,
  options?: { forceAccountPicker?: boolean }
): Promise<ConnectedExternalWallet[]> {
  const platform: 'desktop' | 'mobile' = isMobileUserAgent() ? 'mobile' : 'desktop';
  const win = window as unknown as WindowWithWallets;
  const isPhantom =
    item.rdns === 'app.phantom' || item.name.toLowerCase().includes('phantom');
  const phantomSol = win.phantom?.solana || (win.solana?.isPhantom ? win.solana : undefined);
  const phantomEvm = win.phantom?.ethereum || (isPhantom ? item.provider : undefined);

  // Unified Phantom & Solana handler: connects both Solana and EVM when Phantom is clicked,
  // and gracefully succeeds if either Solana OR EVM is active in the user's Phantom wallet!
  if (item.kind === 'solana' || isPhantom) {
    const results: ConnectedExternalWallet[] = [];
    let lastErr: unknown = null;

    const solCandidate =
      item.kind === 'solana'
        ? win.phantom?.solana || win.solana || win.solflare
        : phantomSol;

    if (item.kind === 'solana') {
      // 1) Try Solana first when user clicked a Solana entry
      if (solCandidate) {
        try {
          const solConn = await connectSolanaProviderAccount(solCandidate, item, platform);
          if (solConn) results.push(solConn);
        } catch (err) {
          lastErr = err;
        }
      }
      // 2) Also pair Phantom EVM if available (or fall back to Phantom EVM if Solana failed)
      if (phantomEvm) {
        try {
          const evmConns = await connectEvmProviderAccounts(
            phantomEvm,
            {
              ...item,
              name: item.name.replace(/\s*\(Solana\)/i, ''),
              kind: 'evm',
              provider: phantomEvm,
            },
            platform,
            results.length === 0 ? options?.forceAccountPicker : false
          );
          results.push(...evmConns);
        } catch (err) {
          if (!lastErr) lastErr = err;
        }
      }
    } else {
      // User clicked "Phantom" (EIP-6963 / EVM entry): try EVM and Solana so neither mode ever fails
      if (phantomEvm) {
        try {
          const evmConns = await connectEvmProviderAccounts(
            phantomEvm,
            item,
            platform,
            options?.forceAccountPicker
          );
          results.push(...evmConns);
        } catch (err) {
          lastErr = err;
        }
      }
      if (solCandidate) {
        try {
          const solConn = await connectSolanaProviderAccount(solCandidate, item, platform);
          if (solConn) results.push(solConn);
        } catch (err) {
          if (!lastErr) lastErr = err;
        }
      }
    }

    if (results.length > 0) {
      return results;
    }

    throw new Error(
      lastErr instanceof Error
        ? lastErr.message
        : 'Phantom / Solana wallet connection was rejected or locked. Please unlock Phantom and try again.'
    );
  }

  if (!item.provider) {
    throw new Error('EVM provider unavailable.');
  }

  const evmConns = await connectEvmProviderAccounts(
    item.provider,
    item,
    platform,
    options?.forceAccountPicker
  );

  if (evmConns.length === 0) {
    throw new Error('Wallet connection rejected or returned no accounts.');
  }

  return evmConns;
}

export async function connectDiscoveredWallet(
  item: DiscoveredWalletProvider
): Promise<ConnectedExternalWallet> {
  const list = await connectDiscoveredWalletAccounts(item);
  return list[0];
}

export async function authenticateWithDiscoveredWallet(
  item: DiscoveredWalletProvider
): Promise<{ session: WalletAuthSession; connections: ConnectedExternalWallet[] }> {
  // Silent eth_accounts check first, falling back to eth_requestAccounts only if needed
  const connections = await connectDiscoveredWalletAccounts(item, { forceAccountPicker: false });
  const primary = connections[0];
  if (!primary) {
    throw new Error('No wallet account was authorized.');
  }

  const cleanAddr = primary.address.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
  const session: WalletAuthSession = {
    id: `wa_${primary.kind}_${cleanAddr}`,
    address: primary.address,
    kind: primary.kind,
    walletName: item.name,
    providerUuid: item.uuid,
    rdns: item.rdns,
    icon: item.icon,
    chainId: primary.chainId,
    platform: primary.platform || (isMobileUserAgent() ? 'mobile' : 'desktop'),
    pairedAt: Date.now(),
  };

  return { session, connections };
}

export async function switchExternalEvmChain(
  provider: Eip1193Provider,
  networkId: NetworkId
): Promise<void> {
  const cfg = NETWORK_MAP[networkId];
  if (!cfg.chainId) throw new Error(`${cfg.name} is not an EVM chain.`);
  const hexChainId = `0x${cfg.chainId.toString(16)}`;

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexChainId }],
    });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 4902 && ADD_CHAIN_PARAMS[networkId]) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [ADD_CHAIN_PARAMS[networkId]],
      });
    } else {
      throw err;
    }
  }
}

export async function signExternalOwnershipProof(
  provider: Eip1193Provider,
  externalAddress: string,
  destinationVaultAddress: string
): Promise<string> {
  const browserProvider = new BrowserProvider(provider);
  const signer = await browserProvider.getSigner(externalAddress);
  const message = [
    'Obsidian Vault — Multi-Wallet Sweep Authorization',
    `Source Address: ${externalAddress}`,
    `Destination Vault: ${destinationVaultAddress}`,
    `Timestamp: ${new Date().toISOString()}`,
  ].join('\n');
  return signer.signMessage(message);
}

async function getResilientEvmProvider(networkId: NetworkId) {
  const primary = getEvmProvider(networkId);
  try {
    await primary.getBlockNumber();
    return primary;
  } catch {
    return getEvmFallbackProvider(networkId);
  }
}

export async function sweepHoldingViaConnectedEvmWallet(params: {
  provider: Eip1193Provider;
  holding: PortfolioHolding;
  fromAddress: string;
  destinationAddress: string;
}): Promise<WalletTransaction> {
  const { provider, holding, fromAddress, destinationAddress } = params;
  const cfg = NETWORK_MAP[holding.networkId];
  if (cfg.family !== 'evm') {
    throw new Error(`Connected EVM wallet cannot sweep ${cfg.name} assets directly.`);
  }

  await switchExternalEvmChain(provider, holding.networkId);

  const browserProvider = new BrowserProvider(provider);
  const signer = await browserProvider.getSigner(fromAddress);
  const rpcProvider = await getResilientEvmProvider(holding.networkId);

  if (!holding.isNative) {
    const rawAmount = BigInt(holding.balanceRaw || '0');
    if (rawAmount <= 0n) {
      throw new Error(`No ${holding.symbol} balance to sweep on ${cfg.name}.`);
    }
    const contract = new Contract(holding.address, ERC20_TRANSFER_ABI, signer);
    const txResp = await contract.transfer(destinationAddress, rawAmount);
    return {
      hash: txResp.hash,
      networkId: holding.networkId,
      type: 'sweep',
      status: 'pending',
      from: fromAddress,
      to: destinationAddress,
      symbol: holding.symbol,
      amount: formatUnits(rawAmount, holding.decimals),
      usdValue: holding.valueUsd,
      timestamp: Date.now(),
      note: `Swept ${holding.symbol} from connected wallet into Vault`,
    };
  }

  // Native gas asset sweep: deduct exact gas reserve so tx never fails
  const [liveBalanceWei, feeData] = await Promise.all([
    rpcProvider.getBalance(fromAddress),
    rpcProvider.getFeeData(),
  ]);

  if (liveBalanceWei <= 0n) {
    throw new Error(`No ${holding.symbol} balance to sweep on ${cfg.name}.`);
  }

  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? parseUnits('15', 'gwei');
  const gasLimit = 21000n;
  const feeReserveWei = (gasLimit * gasPrice * 120n) / 100n;

  if (liveBalanceWei <= feeReserveWei) {
    throw new Error(
      `Balance (${formatEther(liveBalanceWei)} ${holding.symbol}) is lower than required gas fee reserve (${formatEther(feeReserveWei)} ${holding.symbol}).`
    );
  }

  const sweepWei = liveBalanceWei - feeReserveWei;
  const txResp = await signer.sendTransaction({
    to: destinationAddress,
    value: sweepWei,
    gasLimit,
  });

  return {
    hash: txResp.hash,
    networkId: holding.networkId,
    type: 'sweep',
    status: 'pending',
    from: fromAddress,
    to: destinationAddress,
    symbol: holding.symbol,
    amount: Number(formatEther(sweepWei)).toFixed(6),
    usdValue: Number(formatEther(sweepWei)) * holding.priceUsd,
    feeFormatted: `${Number(formatEther(feeReserveWei)).toFixed(6)} ${holding.symbol}`,
    timestamp: Date.now(),
    note: `Swept max ${holding.symbol} minus gas reserve into Vault`,
  };
}

function buildSolanaTransferMessage(
  fromPubkey: Uint8Array,
  toPubkey: Uint8Array,
  recentBlockhash: string,
  lamports: bigint
): Uint8Array {
  const systemProgram = new Uint8Array(32); // 11111111111111111111111111111111
  const blockhashBytes = bs58.decode(recentBlockhash);

  const ixData = new Uint8Array(12);
  const view = new DataView(ixData.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);

  const parts: Uint8Array[] = [
    new Uint8Array([1, 0, 1]),
    new Uint8Array([3]),
    fromPubkey,
    toPubkey,
    systemProgram,
    blockhashBytes,
    new Uint8Array([1]),
    new Uint8Array([2]),
    new Uint8Array([2, 0, 1]),
    new Uint8Array([12]),
    ixData,
  ];

  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const message = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    message.set(p, offset);
    offset += p.length;
  }
  return message;
}

async function postSolanaRpc(body: unknown): Promise<Record<string, unknown>> {
  return postSolanaJsonRpc(body);
}

export async function sweepHoldingViaPrivateKey(params: {
  holding: PortfolioHolding;
  sourceSecrets: UnlockedSecrets;
  sourceAddresses: { evmAddress: string; solanaAddress: string };
  destinationAddresses: { evmAddress: string; solanaAddress: string };
  broadcastOnChain: boolean;
}): Promise<WalletTransaction> {
  const { holding, sourceSecrets, sourceAddresses, destinationAddresses, broadcastOnChain } = params;
  const cfg = NETWORK_MAP[holding.networkId];

  if (cfg.family === 'evm') {
    if (!sourceSecrets.evmPrivateKey) {
      throw new Error('Source EVM private key is unavailable for this sweep.');
    }
    const provider = await getResilientEvmProvider(holding.networkId);
    const signer = new Wallet(sourceSecrets.evmPrivateKey, provider);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? parseUnits('15', 'gwei');

    let nonce = 0;
    try {
      nonce = await provider.getTransactionCount(signer.address, 'pending');
    } catch {
      nonce = 0;
    }

    if (!holding.isNative) {
      const rawAmount = BigInt(holding.balanceRaw || '0');
      if (rawAmount <= 0n || holding.balance <= 0) {
        throw new Error(`Insufficient ${holding.symbol} balance to sweep on ${cfg.name}.`);
      }

      const contract = new Contract(holding.address, ERC20_TRANSFER_ABI, signer);
      const data = contract.interface.encodeFunctionData('transfer', [
        destinationAddresses.evmAddress,
        rawAmount,
      ]);
      let gasLimit = 65000n;
      try {
        gasLimit = await provider.estimateGas({
          from: signer.address,
          to: holding.address,
          data,
        });
      } catch {
        gasLimit = 65000n;
      }

      const nativeGasWei = await provider.getBalance(signer.address).catch(() => 0n);
      const feeWei = gasLimit * gasPrice;

      if (broadcastOnChain && nativeGasWei < feeWei) {
        throw new Error(
          `Insufficient native ${cfg.symbol} for gas fee (${Number(formatEther(feeWei)).toFixed(6)} ${cfg.symbol} required) to sweep ${holding.symbol}.`
        );
      }

      const signedHex = await signer.signTransaction({
        to: holding.address,
        value: 0n,
        data,
        gasLimit,
        gasPrice,
        nonce,
        chainId: cfg.chainId || 1,
      });

      if (broadcastOnChain && nativeGasWei >= feeWei) {
        const sent = await provider.broadcastTransaction(signedHex);
        return {
          hash: sent.hash,
          networkId: holding.networkId,
          type: 'sweep',
          status: 'pending',
          from: signer.address,
          to: destinationAddresses.evmAddress,
          symbol: holding.symbol,
          amount: formatUnits(rawAmount, holding.decimals),
          usdValue: holding.valueUsd,
          feeFormatted: `${Number(formatEther(feeWei)).toFixed(6)} ${cfg.symbol}`,
          rawSignedHex: signedHex,
          timestamp: Date.now(),
          note: `Swept ${holding.symbol} directly from source key into Vault`,
        };
      }

      const sandboxHash = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')}`;

      return {
        hash: sandboxHash,
        networkId: holding.networkId,
        type: 'sweep',
        status: 'signed-sandbox',
        from: signer.address,
        to: destinationAddresses.evmAddress,
        symbol: holding.symbol,
        amount: formatUnits(rawAmount, holding.decimals),
        usdValue: holding.valueUsd,
        feeFormatted: `${Number(formatEther(feeWei)).toFixed(6)} ${cfg.symbol}`,
        rawSignedHex: signedHex,
        timestamp: Date.now(),
        note: `Signed ${holding.symbol} sweep payload (Sandbox dry-run)`,
      };
    }

    const liveBalanceWei = await provider.getBalance(signer.address).catch(() => 0n);
    const scannedBalanceWei = BigInt(holding.balanceRaw || '0');
    const effectiveBalanceWei = liveBalanceWei > 0n ? liveBalanceWei : scannedBalanceWei;

    if (effectiveBalanceWei <= 0n || holding.balance <= 0) {
      throw new Error(`Insufficient ${holding.symbol} balance to sweep on ${cfg.name}.`);
    }

    const gasLimit = 21000n;
    const feeReserveWei = (gasLimit * gasPrice * 115n) / 100n;
    if (effectiveBalanceWei <= feeReserveWei) {
      throw new Error(
        `Insufficient ${holding.symbol} balance (${formatEther(effectiveBalanceWei)} ${holding.symbol}) to cover required gas fee reserve (${Number(formatEther(feeReserveWei)).toFixed(6)} ${holding.symbol}).`
      );
    }

    const canBroadcast = broadcastOnChain && liveBalanceWei > feeReserveWei;
    const sweepWei = effectiveBalanceWei - feeReserveWei;

    const signedHex = await signer.signTransaction({
      to: destinationAddresses.evmAddress,
      value: sweepWei,
      gasLimit,
      gasPrice,
      nonce,
      chainId: cfg.chainId || 1,
    });

    if (canBroadcast) {
      const sent = await provider.broadcastTransaction(signedHex);
      return {
        hash: sent.hash,
        networkId: holding.networkId,
        type: 'sweep',
        status: 'pending',
        from: signer.address,
        to: destinationAddresses.evmAddress,
        symbol: holding.symbol,
        amount: Number(formatEther(sweepWei)).toFixed(6),
        usdValue: Number(formatEther(sweepWei)) * holding.priceUsd,
        feeFormatted: `${Number(formatEther(feeReserveWei)).toFixed(6)} ${cfg.symbol}`,
        rawSignedHex: signedHex,
        timestamp: Date.now(),
        note: `Swept max ${holding.symbol} minus gas reserve into Vault`,
      };
    }

    const sandboxHash = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')}`;

    return {
      hash: sandboxHash,
      networkId: holding.networkId,
      type: 'sweep',
      status: 'signed-sandbox',
      from: signer.address,
      to: destinationAddresses.evmAddress,
      symbol: holding.symbol,
      amount: Number(formatEther(sweepWei)).toFixed(6),
      usdValue: Number(formatEther(sweepWei)) * holding.priceUsd,
      feeFormatted: `${Number(formatEther(feeReserveWei)).toFixed(6)} ${cfg.symbol}`,
      rawSignedHex: signedHex,
      timestamp: Date.now(),
      note: 'Signed EIP-155 sweep payload (Sandbox dry-run)',
    };
  }

  if (cfg.family === 'solana' && holding.isNative) {
    if (!sourceSecrets.solanaSecretBase58) {
      throw new Error('Source Solana secret key is unavailable.');
    }
    const lamports = BigInt(holding.balanceRaw || '0');
    const feeLamports = 5000n;
    if (lamports <= 0n || holding.balance <= 0) {
      throw new Error('Insufficient SOL balance to sweep on Solana.');
    }
    if (lamports <= feeLamports) {
      throw new Error(
        `Insufficient SOL balance (${(Number(lamports) / 1e9).toFixed(6)} SOL) to cover 0.000005 SOL network fee.`
      );
    }

    const secret64 = bs58.decode(sourceSecrets.solanaSecretBase58);
    const seed32 = secret64.slice(0, 32);
    const fromPub = bs58.decode(sourceAddresses.solanaAddress);
    const toPub = bs58.decode(destinationAddresses.solanaAddress);

    const bhJson = (await postSolanaRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'getLatestBlockhash',
      params: [{ commitment: 'finalized' }],
    })) as {
      result?: { value?: { blockhash?: string } };
    };
    const blockhash =
      bhJson.result?.value?.blockhash || '11111111111111111111111111111111';

    const canBroadcast = broadcastOnChain && lamports > feeLamports;
    const sweepLamports = lamports - feeLamports;

    const msg = buildSolanaTransferMessage(fromPub, toPub, blockhash, sweepLamports);
    const sig = ed25519.sign(msg, seed32);

    const rawTx = new Uint8Array(1 + sig.length + msg.length);
    rawTx[0] = 1;
    rawTx.set(sig, 1);
    rawTx.set(msg, 1 + sig.length);

    let binary = '';
    for (let i = 0; i < rawTx.length; i++) {
      binary += String.fromCharCode(rawTx[i]);
    }
    const txBase64 = btoa(binary);

    if (canBroadcast) {
      const sendJson = (await postSolanaRpc({
        jsonrpc: '2.0',
        id: 2,
        method: 'sendTransaction',
        params: [txBase64, { encoding: 'base64' }],
      })) as {
        result?: string;
        error?: { message?: string };
      };
      if (sendJson.error) {
        throw new Error(sendJson.error.message || 'Solana broadcast failed.');
      }
      return {
        hash: sendJson.result || bs58.encode(sig),
        networkId: 'solana',
        type: 'sweep',
        status: 'pending',
        from: sourceAddresses.solanaAddress,
        to: destinationAddresses.solanaAddress,
        symbol: 'SOL',
        amount: (Number(sweepLamports) / 1e9).toFixed(6),
        usdValue: holding.valueUsd,
        feeFormatted: '0.000005 SOL',
        rawSignedHex: txBase64,
        timestamp: Date.now(),
        note: 'Swept max SOL minus 5,000 lamports fee into Vault',
      };
    }

    return {
      hash: `sol_${bs58.encode(sig).slice(0, 44)}`,
      networkId: 'solana',
      type: 'sweep',
      status: 'signed-sandbox',
      from: sourceAddresses.solanaAddress,
      to: destinationAddresses.solanaAddress,
      symbol: 'SOL',
      amount: (Number(sweepLamports) / 1e9).toFixed(6),
      usdValue: holding.valueUsd,
      feeFormatted: '0.000005 SOL',
      rawSignedHex: txBase64,
      timestamp: Date.now(),
      note: 'Signed Ed25519 Solana sweep transaction (Sandbox dry-run)',
    };
  }

  throw new Error(
    `Direct automated sweep for ${cfg.name} requires using an external ${cfg.name} client or Send & Receive.`
  );
}
