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
import { getEvmFallbackProvider, getEvmProvider } from './web3Service';
import type {
  ConnectedExternalWallet,
  DiscoveredWalletProvider,
  Eip1193Provider,
  NetworkId,
  PortfolioHolding,
  UnlockedSecrets,
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
    name: 'Rainbow Wallet',
    chains: 'Ethereum · Optimism · Base',
    color: '#38BDF8',
    buildDeepLink: (targetUrl) =>
      `https://rnbwapp.com/wc?uri=${encodeURIComponent(targetUrl)}`,
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
    phantom?: { solana?: unknown };
    solana?: unknown;
  };
  return Boolean(w.ethereum || w.phantom?.solana || w.solana);
}

export function buildSweepLandingUrl(destEvm?: string, destSol?: string): string {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.origin);
  url.searchParams.set('tab', 'sweep');
  if (destEvm) url.searchParams.set('destEvm', destEvm);
  if (destSol) url.searchParams.set('destSol', destSol);
  return url.toString();
}

export function formatDeepLinkTemplate(template: string, targetUrl: string): string {
  const noProto = targetUrl.replace(/^https?:\/\//, '');
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return template
    .replace(/\{dappUrlNoProto\}/g, noProto)
    .replace(/\{dappUrl\}/g, encodeURIComponent(targetUrl))
    .replace(/\{origin\}/g, encodeURIComponent(origin));
}

interface Eip6963AnnounceEvent extends Event {
  detail?: {
    info?: { uuid?: string; name?: string; icon?: string; rdns?: string };
    provider?: Eip1193Provider;
  };
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
      }
    >;
    isMetaMask?: boolean;
    isRabby?: boolean;
    isCoinbaseWallet?: boolean;
    isTrust?: boolean;
    isOkxWallet?: boolean;
  };
  phantom?: {
    solana?: {
      isPhantom?: boolean;
      connect: () => Promise<{ publicKey: { toBase58: () => string } }>;
      disconnect?: () => Promise<void>;
    };
  };
  solana?: {
    isPhantom?: boolean;
    connect: () => Promise<{ publicKey: { toBase58: () => string } }>;
    disconnect?: () => Promise<void>;
  };
}

// Live in-memory provider map supporting multiple simultaneous connected wallets
const sessionProviderMap = new Map<string, Eip1193Provider>();

export function makeSessionId(providerUuid: string, address: string): string {
  const cleanAddr = address.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
  const cleanProv = providerUuid.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
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
  if (session.providerUuid) {
    const byUuid = discoveredProviders.find((p) => p.uuid === session.providerUuid)?.provider;
    if (byUuid) return byUuid;
  }
  const byName = discoveredProviders.find(
    (p) => p.name === session.name && p.kind === session.kind
  )?.provider;
  if (byName) return byName;
  return discoveredProviders.find((p) => p.kind === session.kind)?.provider || null;
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

  window.addEventListener('eip6963:announceProvider', handleAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  // Fallback for legacy window.ethereum & mobile in-app wallet browsers
  const fallbackTimer = setTimeout(() => {
    if (win.ethereum) {
      const multi = Array.isArray(win.ethereum.providers) && win.ethereum.providers.length > 0
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
          : prov.isMetaMask
          ? 'MetaMask'
          : 'Injected Web3 Wallet';
        const alreadyHave = Array.from(discovered.values()).some(
          (p) => p.kind === 'evm' && p.name.toLowerCase().includes(name.toLowerCase().split(' ')[0])
        );
        if (!alreadyHave) {
          discovered.set(`injected-evm-${idx}`, {
            uuid: `injected-evm-${idx}`,
            name,
            kind: 'evm',
            provider: prov,
          });
        }
      });
    }

    const solProvider = win.phantom?.solana || win.solana;
    if (solProvider) {
      discovered.set('injected-solana-provider', {
        uuid: 'injected-solana-provider',
        name: solProvider.isPhantom ? 'Phantom (Solana)' : 'Solana Wallet',
        kind: 'solana',
      });
    }
    emit();
  }, 160);

  return () => {
    clearTimeout(fallbackTimer);
    window.removeEventListener('eip6963:announceProvider', handleAnnounce);
  };
}

export async function connectDiscoveredWalletAccounts(
  item: DiscoveredWalletProvider,
  options?: { pickMultipleAccounts?: boolean }
): Promise<ConnectedExternalWallet[]> {
  const platform: 'desktop' | 'mobile' = isMobileUserAgent() ? 'mobile' : 'desktop';

  if (item.kind === 'solana') {
    const win = window as unknown as WindowWithWallets;
    const sol = win.phantom?.solana || win.solana;
    if (!sol) {
      throw new Error('No Solana browser/mobile wallet detected.');
    }
    const resp = await sol.connect();
    const addr = resp.publicKey.toBase58();
    const sid = makeSessionId(item.uuid, addr);
    return [
      {
        id: sid,
        providerUuid: item.uuid,
        name: item.name,
        icon: item.icon,
        rdns: item.rdns,
        kind: 'solana',
        address: addr,
        platform,
        selectedForSweep: true,
        connectedAt: Date.now(),
      },
    ];
  }

  if (!item.provider) {
    throw new Error('EVM provider unavailable.');
  }

  // Optionally invoke wallet_requestPermissions so the user can check multiple accounts at once
  if (options?.pickMultipleAccounts) {
    try {
      await item.provider.request({
        method: 'wallet_requestPermissions',
        params: [{ eth_accounts: {} }],
      });
    } catch {
      // Fallback smoothly to standard eth_requestAccounts if wallet doesn't implement 2255
    }
  }

  const accounts = (await item.provider.request({
    method: 'eth_requestAccounts',
  })) as string[];
  if (!accounts || accounts.length === 0) {
    throw new Error('Wallet connection rejected or returned no accounts.');
  }
  const chainHex = (await item.provider.request({
    method: 'eth_chainId',
  })) as string;
  const chainId = chainHex ? parseInt(chainHex, 16) : 1;

  return accounts.map((addr, idx) => {
    const sid = makeSessionId(item.uuid, addr);
    registerSessionProvider(sid, item.provider!);
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

export async function connectDiscoveredWallet(
  item: DiscoveredWalletProvider
): Promise<ConnectedExternalWallet> {
  const list = await connectDiscoveredWalletAccounts(item);
  return list[0];
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
  const tryUrl = async (url: string) => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const ct = resp.headers.get('content-type') || '';
    if (!resp.ok || !ct.includes('application/json')) {
      throw new Error('Solana RPC error');
    }
    return (await resp.json()) as Record<string, unknown>;
  };

  try {
    return await tryUrl('/api/rpc?network=solana');
  } catch {
    return await tryUrl('https://solana-rpc.publicnode.com');
  }
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
      const fallbackRaw = rawAmount > 0n ? rawAmount : parseUnits('1', holding.decimals);
      const contract = new Contract(holding.address, ERC20_TRANSFER_ABI, signer);
      const data = contract.interface.encodeFunctionData('transfer', [
        destinationAddresses.evmAddress,
        fallbackRaw,
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

      const signedHex = await signer.signTransaction({
        to: holding.address,
        value: 0n,
        data,
        gasLimit,
        gasPrice,
        nonce,
        chainId: cfg.chainId || 1,
      });

      const nativeGasWei = await provider.getBalance(signer.address).catch(() => 0n);
      const feeWei = gasLimit * gasPrice;

      if (broadcastOnChain && rawAmount > 0n && nativeGasWei >= feeWei) {
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
        amount: formatUnits(fallbackRaw, holding.decimals),
        feeFormatted: `${Number(formatEther(feeWei)).toFixed(6)} ${cfg.symbol}`,
        rawSignedHex: signedHex,
        timestamp: Date.now(),
        note: `Signed ${holding.symbol} sweep payload (Sandbox dry-run — insufficient native gas or dry-run selected)`,
      };
    }

    const liveBalanceWei = await provider.getBalance(signer.address).catch(() => 0n);
    const gasLimit = 21000n;
    const feeReserveWei = (gasLimit * gasPrice * 115n) / 100n;
    const canBroadcast = broadcastOnChain && liveBalanceWei > feeReserveWei;
    const sweepWei = canBroadcast ? liveBalanceWei - feeReserveWei : parseEther('0.01');

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
      feeFormatted: `${Number(formatEther(feeReserveWei)).toFixed(6)} ${cfg.symbol}`,
      rawSignedHex: signedHex,
      timestamp: Date.now(),
      note: 'Signed EIP-155 sweep payload (Sandbox dry-run — source wallet has insufficient on-chain balance)',
    };
  }

  if (cfg.family === 'solana' && holding.isNative) {
    if (!sourceSecrets.solanaSecretBase58) {
      throw new Error('Source Solana secret key is unavailable.');
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

    const lamports = BigInt(holding.balanceRaw || '0');
    const feeLamports = 5000n;
    const canBroadcast = broadcastOnChain && lamports > feeLamports;
    const sweepLamports = canBroadcast ? lamports - feeLamports : 1_000_000n;

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
      feeFormatted: '0.000005 SOL',
      rawSignedHex: txBase64,
      timestamp: Date.now(),
      note: 'Signed Ed25519 Solana sweep transaction (Sandbox dry-run — source wallet unfunded)',
    };
  }

  throw new Error(
    `Direct automated sweep for ${cfg.name} requires using an external ${cfg.name} client or Send & Receive.`
  );
}
