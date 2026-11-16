import { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  Plus,
  QrCode,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
  Unplug,
  Users,
  Wallet,
  Zap,
} from 'lucide-react';
import {
  deriveWalletFromMnemonic,
  deriveWalletFromPrivateKey,
  shortenAddress,
  validateMnemonicPhrase,
} from '../lib/crypto';
import { NETWORK_MAP, WALLET_PRESETS } from '../lib/networks';
import { formatCryptoAmount, formatFiat } from '../lib/formatters';
import { fetchMultiChainPortfolio } from '../lib/web3Service';
import {
  MOBILE_WALLET_APPS,
  buildSweepLandingUrl,
  connectDiscoveredWalletAccounts,
  discoverExternalWalletProviders,
  formatDeepLinkTemplate,
  isInAppWalletBrowser,
  isMobileUserAgent,
  resolveProviderForSession,
  signExternalOwnershipProof,
  sweepHoldingViaConnectedEvmWallet,
  sweepHoldingViaPrivateKey,
} from '../lib/walletConnectService';
import { NetworkIcon, TokenAvatar } from './NetworkIcon';
import type {
  ConnectedExternalWallet,
  DiscoveredWalletProvider,
  MarketCoin,
  PortfolioHolding,
  UnlockedSecrets,
  WalletAccount,
  WalletCatalogEntry,
  WalletPresetId,
  WalletTransaction,
} from '../types/wallet';

interface ConnectSweepViewProps {
  wallets: WalletAccount[];
  activeWallet: WalletAccount;
  justCreatedWalletId?: string | null;
  markets: MarketCoin[];
  currency: 'USD' | 'EUR' | 'GBP';
  connectedExternals: ConnectedExternalWallet[];
  walletCatalog: WalletCatalogEntry[];
  onConnectAccounts: (newConnections: ConnectedExternalWallet[]) => void;
  onToggleConnectionSweep: (sessionId: string) => void;
  onDisconnectOne: (sessionId: string) => void;
  onDisconnectAll: () => void;
  onSweepExecuted: (tx: WalletTransaction) => void;
  onDismissNewBanner?: () => void;
}

interface TaggedHolding extends PortfolioHolding {
  sourceSessionId: string;
  sourceWalletName: string;
  sourceAddress: string;
  sourceKind: 'evm' | 'solana';
}

interface EphemeralSourceWallet {
  id: string;
  label: string;
  evmAddress: string;
  solanaAddress: string;
  secrets: UnlockedSecrets;
  selected: boolean;
}

type SourceTab = 'walletconnect' | 'ephemeral-key';

export function ConnectSweepView({
  wallets,
  activeWallet,
  justCreatedWalletId,
  markets,
  currency,
  connectedExternals,
  walletCatalog,
  onConnectAccounts,
  onToggleConnectionSweep,
  onDisconnectOne,
  onDisconnectAll,
  onSweepExecuted,
  onDismissNewBanner,
}: ConnectSweepViewProps) {
  const [sourceTab, setSourceTab] = useState<SourceTab>('walletconnect');
  const [destWalletId, setDestWalletId] = useState<string>(
    justCreatedWalletId && wallets.some((w) => w.id === justCreatedWalletId)
      ? justCreatedWalletId
      : activeWallet.id
  );
  const [copiedDest, setCopiedDest] = useState<'evm' | 'sol' | null>(null);

  // EIP-6963 / Solana / Mobile App Providers
  const [discoveredProviders, setDiscoveredProviders] = useState<DiscoveredWalletProvider[]>([]);
  const [connectingUuid, setConnectingUuid] = useState<string | null>(null);
  const [pickMultiAccounts, setPickMultiAccounts] = useState(true);
  const [ownershipSigs, setOwnershipSigs] = useState<Record<string, string>>({});
  const [signingSessionId, setSigningSessionId] = useState<string | null>(null);
  const [showMobileQr, setShowMobileQr] = useState(false);
  const [mobileQrDataUrl, setMobileQrDataUrl] = useState('');

  // Ephemeral Multiple Source Phrases / Keys
  const [ephemeralInput, setEphemeralInput] = useState('');
  const [ephemeralPreset, setEphemeralPreset] = useState<WalletPresetId>('metamask');
  const [ephemeralSources, setEphemeralSources] = useState<EphemeralSourceWallet[]>([]);
  const [broadcastMode, setBroadcastMode] = useState<'auto' | 'sandbox'>('auto');

  // Multi-Wallet Scanned Holdings & Batch Sweep Execution
  const [sourceHoldings, setSourceHoldings] = useState<TaggedHolding[]>([]);
  const [scanning, setScanning] = useState(false);
  const [showZeroBalances, setShowZeroBalances] = useState(false);
  const [sweepingKey, setSweepingKey] = useState<string | null>(null);
  const [batchSweeping, setBatchSweeping] = useState(false);
  const [error, setError] = useState('');
  const [sweepReceipts, setSweepReceipts] = useState<WalletTransaction[]>([]);

  const isMobile = useMemo(() => isMobileUserAgent(), []);
  const inAppWallet = useMemo(() => isInAppWalletBrowser(), []);

  useEffect(() => {
    if (justCreatedWalletId && wallets.some((w) => w.id === justCreatedWalletId)) {
      setDestWalletId(justCreatedWalletId);
    } else if (!wallets.some((w) => w.id === destWalletId)) {
      setDestWalletId(activeWallet.id);
    }
  }, [justCreatedWalletId, wallets, activeWallet.id, destWalletId]);

  const destinationWallet = useMemo(
    () => wallets.find((w) => w.id === destWalletId) || activeWallet,
    [wallets, destWalletId, activeWallet]
  );

  const sweepLandingUrl = useMemo(
    () =>
      buildSweepLandingUrl(
        destinationWallet.addresses.evmAddress,
        destinationWallet.addresses.solanaAddress
      ),
    [destinationWallet.addresses.evmAddress, destinationWallet.addresses.solanaAddress]
  );

  // Merge built-in mobile deep-link apps with any Admin-added mobile wallets from wallet_catalog
  const mobileAppsList = useMemo(() => {
    const base = MOBILE_WALLET_APPS.map((app) => ({
      id: app.id,
      name: app.name,
      chains: app.chains,
      color: app.color,
      href: app.buildDeepLink(sweepLandingUrl),
    }));

    const adminMobileExtras = walletCatalog
      .filter(
        (w) =>
          w.enabled &&
          w.mobileDeepLink &&
          !base.some((b) => w.name.toLowerCase().includes(b.name.toLowerCase().split(' ')[0]))
      )
      .map((w) => ({
        id: w.id,
        name: w.name,
        chains: w.ecosystem.toUpperCase(),
        color: w.badgeColor || '#10B981',
        href: formatDeepLinkTemplate(w.mobileDeepLink!, sweepLandingUrl),
      }));

    return [...base, ...adminMobileExtras];
  }, [sweepLandingUrl, walletCatalog]);

  useEffect(() => {
    if (!showMobileQr || !sweepLandingUrl) return;
    QRCode.toDataURL(sweepLandingUrl, {
      width: 220,
      margin: 2,
      color: { dark: '#090B0F', light: '#F4F6F9' },
    })
      .then(setMobileQrDataUrl)
      .catch(() => setMobileQrDataUrl(''));
  }, [showMobileQr, sweepLandingUrl]);

  useEffect(() => {
    const stop = discoverExternalWalletProviders((list) => {
      setDiscoveredProviders(list);
    });
    return stop;
  }, []);

  const scanConnectedSessions = useCallback(
    async (sessions: ConnectedExternalWallet[]) => {
      if (sessions.length === 0) {
        setSourceHoldings([]);
        return;
      }
      setScanning(true);
      setError('');
      try {
        const perSession = await Promise.all(
          sessions.map(async (sess): Promise<TaggedHolding[]> => {
            const list = await fetchMultiChainPortfolio(
              {
                evmAddress: sess.kind === 'evm' ? sess.address : '',
                evmPath: '',
                solanaAddress: sess.kind === 'solana' ? sess.address : '',
                solanaPath: '',
                bitcoinAddress: '',
                bitcoinPath: '',
                moneroAddress: '',
                moneroPath: '',
              },
              markets
            );
            return list.map((h) => ({
              ...h,
              sourceSessionId: sess.id,
              sourceWalletName: sess.name,
              sourceAddress: sess.address,
              sourceKind: sess.kind,
            }));
          })
        );
        setSourceHoldings(perSession.flat());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to scan connected wallet balances.');
      } finally {
        setScanning(false);
      }
    },
    [markets]
  );

  const scanEphemeralSources = useCallback(
    async (sources: EphemeralSourceWallet[]) => {
      if (sources.length === 0) {
        setSourceHoldings([]);
        return;
      }
      setScanning(true);
      setError('');
      try {
        const perSource = await Promise.all(
          sources.map(async (src): Promise<TaggedHolding[]> => {
            const list = await fetchMultiChainPortfolio(
              {
                evmAddress: src.evmAddress,
                evmPath: '',
                solanaAddress: src.solanaAddress,
                solanaPath: '',
                bitcoinAddress: '',
                bitcoinPath: '',
                moneroAddress: '',
                moneroPath: '',
              },
              markets
            );
            return list.map((h) => ({
              ...h,
              sourceSessionId: src.id,
              sourceWalletName: src.label,
              sourceAddress: src.evmAddress || src.solanaAddress,
              sourceKind: NETWORK_MAP[h.networkId].family === 'solana' ? 'solana' : 'evm',
            }));
          })
        );
        setSourceHoldings(perSource.flat());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to scan source keys.');
      } finally {
        setScanning(false);
      }
    },
    [markets]
  );

  // Auto-scan whenever connected wallets or active tab changes
  useEffect(() => {
    if (sourceTab === 'walletconnect') {
      scanConnectedSessions(connectedExternals);
    } else {
      scanEphemeralSources(ephemeralSources);
    }
  }, [sourceTab, connectedExternals, ephemeralSources, scanConnectedSessions, scanEphemeralSources]);

  const handleConnectProvider = async (item: DiscoveredWalletProvider) => {
    setError('');
    setConnectingUuid(item.uuid);
    try {
      const conns = await connectDiscoveredWalletAccounts(item, {
        pickMultipleAccounts: pickMultiAccounts,
      });
      onConnectAccounts(conns);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect external wallet.');
    } finally {
      setConnectingUuid(null);
    }
  };

  const handleVerifyOwnership = async (session: ConnectedExternalWallet) => {
    const provider = resolveProviderForSession(session, discoveredProviders);
    if (!provider || !destinationWallet.addresses.evmAddress) {
      setError(`Reconnect ${session.name} in this browser tab to sign sweep authorization.`);
      return;
    }
    setSigningSessionId(session.id);
    setError('');
    try {
      const sig = await signExternalOwnershipProof(
        provider,
        session.address,
        destinationWallet.addresses.evmAddress
      );
      setOwnershipSigs((prev) => ({ ...prev, [session.id]: sig }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ownership signature rejected.');
    } finally {
      setSigningSessionId(null);
    }
  };

  const handleAddEphemeralSource = async () => {
    setError('');
    const raw = ephemeralInput.trim();
    if (!raw) {
      setError('Paste a 12, 18, or 24-word recovery phrase or raw EVM/Solana private key.');
      return;
    }

    try {
      const words = raw.split(/\s+/).filter(Boolean);
      let evmAddress = '';
      let solanaAddress = '';
      let secrets: UnlockedSecrets;
      let label = '';

      if (words.length === 12 || words.length === 18 || words.length === 24) {
        const check = validateMnemonicPhrase(raw);
        if (!check.valid) {
          throw new Error(check.error || 'Invalid BIP-39 recovery phrase.');
        }
        const derived = deriveWalletFromMnemonic(raw, {
          preset: ephemeralPreset,
          accountIndex: 0,
        });
        evmAddress = derived.addresses.evmAddress;
        solanaAddress = derived.addresses.solanaAddress;
        secrets = derived.secrets;
        label = `Seed #${ephemeralSources.length + 1} (${WALLET_PRESETS.find((p) => p.id === ephemeralPreset)?.name.split('/')[0].trim() || 'HD'})`;
      } else {
        const derived = deriveWalletFromPrivateKey(raw, 'auto');
        if (derived.family === 'monero') {
          throw new Error('Use Send & Receive to transfer Monero (XMR) balances.');
        }
        evmAddress = derived.addresses.evmAddress;
        solanaAddress = derived.addresses.solanaAddress;
        secrets = derived.secrets;
        label = `Private Key #${ephemeralSources.length + 1}`;
      }

      const duplicate = ephemeralSources.some(
        (s) =>
          (evmAddress && s.evmAddress.toLowerCase() === evmAddress.toLowerCase()) ||
          (solanaAddress && s.solanaAddress === solanaAddress)
      );
      if (duplicate) {
        setError('This source wallet is already in your multi-wallet sweep queue.');
        return;
      }

      setEphemeralSources((prev) => [
        ...prev,
        {
          id: `eph_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          label,
          evmAddress,
          solanaAddress,
          secrets,
          selected: true,
        },
      ]);
      setEphemeralInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to parse source phrase or private key.');
    }
  };

  const executeSingleSweep = async (holding: TaggedHolding) => {
    setError('');
    const destEvm = destinationWallet.addresses.evmAddress;
    const destSol = destinationWallet.addresses.solanaAddress;

    if (holding.networkId === 'solana' && !destSol) {
      setError('Selected destination vault does not have a Solana address.');
      return;
    }
    if (NETWORK_MAP[holding.networkId].family === 'evm' && !destEvm) {
      setError('Selected destination vault does not have an EVM address.');
      return;
    }

    const rowKey = `${holding.sourceSessionId}:${holding.id}`;
    setSweepingKey(rowKey);
    try {
      let tx: WalletTransaction;

      if (sourceTab === 'walletconnect') {
        const session = connectedExternals.find((c) => c.id === holding.sourceSessionId);
        const provider = session
          ? resolveProviderForSession(session, discoveredProviders)
          : null;
        if (!session || !provider) {
          throw new Error(
            `Live signer for ${holding.sourceWalletName} is not active in this tab. Reconnect it to sign the sweep.`
          );
        }
        if (session.kind !== 'evm') {
          throw new Error(
            'Browser Solana extensions require single-tx confirmation; paste your Solana key in Sweep Seed Phrases / Keys for one-click automated batch sweep.'
          );
        }
        tx = await sweepHoldingViaConnectedEvmWallet({
          provider,
          holding,
          fromAddress: session.address,
          destinationAddress: destEvm,
        });
      } else {
        const src = ephemeralSources.find((s) => s.id === holding.sourceSessionId);
        if (!src) {
          throw new Error('Source key entry not found.');
        }
        tx = await sweepHoldingViaPrivateKey({
          holding,
          sourceSecrets: src.secrets,
          sourceAddresses: {
            evmAddress: src.evmAddress,
            solanaAddress: src.solanaAddress,
          },
          destinationAddresses: {
            evmAddress: destEvm,
            solanaAddress: destSol,
          },
          broadcastOnChain: broadcastMode === 'auto',
        });
      }

      setSweepReceipts((prev) => [tx, ...prev]);
      onSweepExecuted(tx);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to sweep ${holding.symbol}.`);
    } finally {
      setSweepingKey(null);
    }
  };

  const selectedSessionIds = useMemo(() => {
    if (sourceTab === 'walletconnect') {
      return new Set(
        connectedExternals
          .filter((c) => c.selectedForSweep !== false)
          .map((c) => c.id)
      );
    }
    return new Set(ephemeralSources.filter((s) => s.selected).map((s) => s.id));
  }, [sourceTab, connectedExternals, ephemeralSources]);

  const fundedHoldings = useMemo(
    () =>
      sourceHoldings.filter(
        (h) =>
          h.balance > 0 &&
          selectedSessionIds.has(h.sourceSessionId) &&
          (NETWORK_MAP[h.networkId].family === 'evm' ||
            (h.networkId === 'solana' && h.isNative))
      ),
    [sourceHoldings, selectedSessionIds]
  );

  const handleBatchSweepAll = async () => {
    if (fundedHoldings.length === 0) return;
    setBatchSweeping(true);
    setError('');

    // Group by source wallet; sweep ERC-20 tokens first before native gas token for each wallet
    const ordered = [...fundedHoldings].sort((a, b) => {
      if (a.sourceSessionId !== b.sourceSessionId) {
        return a.sourceSessionId.localeCompare(b.sourceSessionId);
      }
      return Number(a.isNative) - Number(b.isNative);
    });

    try {
      for (const h of ordered) {
        if (sourceTab === 'walletconnect' && NETWORK_MAP[h.networkId].family !== 'evm') {
          continue;
        }
        await executeSingleSweep(h);
      }
    } finally {
      setBatchSweeping(false);
    }
  };

  const displayedHoldings = useMemo(() => {
    const eligible = sourceHoldings.filter(
      (h) =>
        NETWORK_MAP[h.networkId].family === 'evm' ||
        (h.networkId === 'solana' && h.isNative)
    );
    if (showZeroBalances) return eligible;
    return eligible.filter((h) => h.balance > 0);
  }, [sourceHoldings, showZeroBalances]);

  const totalSweepableUsd = useMemo(
    () => fundedHoldings.reduce((sum, h) => sum + h.valueUsd, 0),
    [fundedHoldings]
  );

  const balanceBySession = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of sourceHoldings) {
      m.set(h.sourceSessionId, (m.get(h.sourceSessionId) || 0) + h.valueUsd);
    }
    return m;
  }, [sourceHoldings]);

  const handleCopyDest = async (kind: 'evm' | 'sol', val: string) => {
    if (!val) return;
    await navigator.clipboard.writeText(val);
    setCopiedDest(kind);
    setTimeout(() => setCopiedDest(null), 1600);
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Destination Vault Card */}
      <div className="bg-[#11151C] border border-white/10 rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Zap className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-[#F4F6F9]">
                Multi-WalletConnect & Batch Sweep
              </h2>
              <p className="text-xs text-[#8A94A6] mt-0.5">
                Connect multiple desktop extensions, mobile wallet apps, or recovery keys at the same time and sweep all balances into your Obsidian Vault
              </p>
            </div>
          </div>

          {justCreatedWalletId && onDismissNewBanner && (
            <button
              type="button"
              onClick={onDismissNewBanner}
              className="text-xs text-emerald-400 hover:underline"
            >
              Newly Created Vault Selected
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 pt-2 border-t border-white/10 items-center">
          <div className="lg:col-span-4">
            <label className="block text-[11px] text-[#8A94A6] mb-1">
              Destination Vault Wallet
            </label>
            <select
              value={destinationWallet.id}
              onChange={(e) => setDestWalletId(e.target.value)}
              className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-xs font-medium text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
            >
              {wallets.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {justCreatedWalletId === w.id ? ' (Just Created)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="lg:col-span-4 p-3 rounded-lg bg-[#090B0F] border border-white/10 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[10px] text-[#64748B]">Destination EVM Address</div>
              <div className="font-mono text-xs text-[#F4F6F9] truncate">
                {destinationWallet.addresses.evmAddress
                  ? shortenAddress(destinationWallet.addresses.evmAddress, 10, 8)
                  : 'Not derived'}
              </div>
            </div>
            {destinationWallet.addresses.evmAddress && (
              <button
                type="button"
                onClick={() =>
                  handleCopyDest('evm', destinationWallet.addresses.evmAddress)
                }
                className="p-1.5 rounded bg-[#11151C] border border-white/10 text-[#8A94A6] hover:text-[#F4F6F9] shrink-0"
                aria-label="Copy destination EVM address"
              >
                {copiedDest === 'evm' ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            )}
          </div>

          <div className="lg:col-span-4 p-3 rounded-lg bg-[#090B0F] border border-white/10 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[10px] text-[#64748B]">Destination Solana Address</div>
              <div className="font-mono text-xs text-emerald-400 truncate">
                {destinationWallet.addresses.solanaAddress
                  ? shortenAddress(destinationWallet.addresses.solanaAddress, 10, 8)
                  : 'Not derived'}
              </div>
            </div>
            {destinationWallet.addresses.solanaAddress && (
              <button
                type="button"
                onClick={() =>
                  handleCopyDest('sol', destinationWallet.addresses.solanaAddress)
                }
                className="p-1.5 rounded bg-[#11151C] border border-white/10 text-[#8A94A6] hover:text-[#F4F6F9] shrink-0"
                aria-label="Copy destination Solana address"
              >
                {copiedDest === 'sol' ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Source Wallet Connection Tabs */}
      <div className="bg-[#11151C] border border-white/10 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 p-1 bg-[#090B0F] border border-white/10 rounded-lg overflow-x-auto">
            <button
              type="button"
              onClick={() => {
                setSourceTab('walletconnect');
                setError('');
              }}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                sourceTab === 'walletconnect'
                  ? 'bg-emerald-500 text-[#090B0F] font-semibold'
                  : 'text-[#8A94A6] hover:text-[#F4F6F9]'
              }`}
            >
              <Link2 className="w-3.5 h-3.5" />
              <span>
                WalletConnect ({connectedExternals.length} Connected)
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                setSourceTab('ephemeral-key');
                setError('');
              }}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                sourceTab === 'ephemeral-key'
                  ? 'bg-emerald-500 text-[#090B0F] font-semibold'
                  : 'text-[#8A94A6] hover:text-[#F4F6F9]'
              }`}
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>
                Sweep Seed Phrases / Keys ({ephemeralSources.length} Queued)
              </span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            {(connectedExternals.length > 0 || ephemeralSources.length > 0) && (
              <button
                type="button"
                onClick={() => {
                  if (sourceTab === 'walletconnect') {
                    scanConnectedSessions(connectedExternals);
                  } else {
                    scanEphemeralSources(ephemeralSources);
                  }
                }}
                disabled={scanning}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#CBD5E1] hover:text-[#F4F6F9]"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
                <span>{scanning ? 'Scanning...' : 'Rescan All'}</span>
              </button>
            )}
          </div>
        </div>

        <div className="p-6 space-y-6">
          {sourceTab === 'walletconnect' ? (
            <>
              {/* Active Multi-Wallet Connections List */}
              {connectedExternals.length > 0 && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-[#F4F6F9]">
                      <Users className="w-4 h-4 text-emerald-400" />
                      <span>
                        Active Simultaneous Connections ({connectedExternals.length})
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={onDisconnectAll}
                      className="text-xs text-red-400 hover:underline"
                    >
                      Disconnect All
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {connectedExternals.map((sess) => {
                      const isSelected = sess.selectedForSweep !== false;
                      const liveProvider = resolveProviderForSession(sess, discoveredProviders);
                      const usdTotal = balanceBySession.get(sess.id) ?? 0;
                      const sig = ownershipSigs[sess.id];

                      return (
                        <div
                          key={sess.id}
                          className={`p-4 rounded-xl bg-[#090B0F] border transition-colors space-y-3 ${
                            isSelected ? 'border-emerald-500/40' : 'border-white/10 opacity-75'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <label className="flex items-start gap-2.5 cursor-pointer min-w-0">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => onToggleConnectionSweep(sess.id)}
                                className="mt-1 rounded border-white/20 bg-[#11151C] text-emerald-500"
                              />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                                  <span className="font-semibold text-[#F4F6F9]">
                                    {sess.name}
                                  </span>
                                  <span className="text-[#64748B]">·</span>
                                  <span className="text-emerald-400 font-mono uppercase text-[10px]">
                                    {sess.kind}
                                  </span>
                                  {sess.platform === 'mobile' && (
                                    <>
                                      <span className="text-[#64748B]">·</span>
                                      <span className="text-[10px] text-sky-400">Mobile App</span>
                                    </>
                                  )}
                                </div>
                                <div className="font-mono text-[11px] text-[#CBD5E1] truncate mt-0.5">
                                  {shortenAddress(sess.address, 10, 8)}
                                </div>
                              </div>
                            </label>

                            <div className="text-right shrink-0">
                              <div className="font-mono text-xs font-semibold text-[#F4F6F9] tabular-nums">
                                {formatFiat(usdTotal, currency)}
                              </div>
                              <div className="text-[10px] text-[#64748B]">
                                {liveProvider ? 'Live Signer' : 'Session Synced'}
                              </div>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-white/10">
                            {sess.kind === 'evm' && liveProvider ? (
                              <button
                                type="button"
                                disabled={signingSessionId === sess.id}
                                onClick={() => handleVerifyOwnership(sess)}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#11151C] border border-white/10 hover:border-emerald-500/40 text-[11px] text-[#CBD5E1]"
                              >
                                <ShieldCheck className="w-3 h-3 text-emerald-400" />
                                <span>
                                  {sig
                                    ? 'Auth Signed'
                                    : signingSessionId === sess.id
                                    ? 'Signing...'
                                    : 'Sign Auth'}
                                </span>
                              </button>
                            ) : (
                              <span className="text-[10px] text-[#64748B]">
                                {sess.kind === 'evm'
                                  ? 'Reconnect extension to sign'
                                  : 'Solana Public Session'}
                              </span>
                            )}

                            <button
                              type="button"
                              onClick={() => onDisconnectOne(sess.id)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#11151C] border border-white/10 hover:border-red-500/40 text-[11px] text-[#8A94A6] hover:text-red-300"
                            >
                              <Unplug className="w-3 h-3" />
                              <span>Disconnect</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Add / Connect Browser & Injected Wallets */}
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-[#F4F6F9]">
                      {connectedExternals.length > 0
                        ? 'Connect Another Wallet Simultaneously'
                        : 'Detected Web3 Wallets (EIP-6963 & Solana)'}
                    </h3>
                    <p className="text-xs text-[#8A94A6] mt-0.5">
                      Connect multiple wallets or multiple accounts from MetaMask, Rabby, Coinbase, Trust, or Phantom at the same time
                    </p>
                  </div>

                  <label className="flex items-center gap-2 text-xs text-[#CBD5E1] cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={pickMultiAccounts}
                      onChange={(e) => setPickMultiAccounts(e.target.checked)}
                      className="rounded border-white/20 bg-[#090B0F] text-emerald-500"
                    />
                    <span>Multi-Account Picker</span>
                  </label>
                </div>

                {discoveredProviders.length > 0 ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {discoveredProviders.map((prov) => (
                      <button
                        key={prov.uuid}
                        type="button"
                        disabled={connectingUuid === prov.uuid}
                        onClick={() => handleConnectProvider(prov)}
                        className="p-4 rounded-xl bg-[#090B0F] border border-white/10 hover:border-emerald-500/50 flex items-center justify-between gap-3 text-left transition-colors"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {prov.icon ? (
                            <img
                              src={prov.icon}
                              alt={prov.name}
                              className="w-8 h-8 rounded-lg object-contain shrink-0"
                            />
                          ) : (
                            <div className="w-8 h-8 rounded-lg bg-[#1A2130] flex items-center justify-center text-emerald-400 shrink-0">
                              <Wallet className="w-4 h-4" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-[#F4F6F9] truncate">
                              {prov.name}
                            </div>
                            <div className="text-[11px] font-mono text-[#64748B] uppercase">
                              {prov.kind === 'evm' ? 'EIP-6963 EVM' : 'Solana Provider'}
                            </div>
                          </div>
                        </div>
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400 shrink-0">
                          <Plus className="w-3.5 h-3.5" />
                          <span>{connectingUuid === prov.uuid ? 'Connecting...' : 'Connect'}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="p-4 rounded-xl bg-[#090B0F] border border-white/10 flex flex-wrap items-center justify-between gap-3">
                    <div className="text-xs text-[#8A94A6] max-w-2xl">
                      {isMobile
                        ? 'On mobile browsers (Safari/Chrome), tap any installed wallet app below to launch Obsidian Vault inside its built-in Web3 signer.'
                        : 'No browser wallet extension detected in this frame. Open in a top-level browser tab for desktop extensions, connect an installed phone app below, or sweep seed phrases directly.'}
                    </div>
                    <a
                      href={sweepLandingUrl || '#'}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1A2130] hover:bg-[#232C3F] border border-white/10 text-xs font-medium text-[#F4F6F9] shrink-0"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Open Full Tab</span>
                    </a>
                  </div>
                )}
              </div>

              {/* Mobile Phone Installed App Launcher & QR Handoff */}
              <div className="pt-4 border-t border-white/10 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Smartphone className="w-4 h-4 text-emerald-400" />
                    <div>
                      <h3 className="text-sm font-semibold text-[#F4F6F9]">
                        Mobile Phone WalletConnect (Open Installed Wallet Apps)
                      </h3>
                      <p className="text-xs text-[#8A94A6]">
                        {inAppWallet
                          ? 'In-app mobile wallet signer detected — connect accounts above to sweep directly.'
                          : 'On iOS or Android, tap any installed app to connect & sweep directly into your Vault.'}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowMobileQr((v) => !v)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 hover:border-emerald-500/40 text-xs text-[#CBD5E1]"
                  >
                    <QrCode className="w-3.5 h-3.5 text-emerald-400" />
                    <span>{showMobileQr ? 'Hide Phone QR' : 'Scan QR with Phone'}</span>
                  </button>
                </div>

                {showMobileQr && (
                  <div className="p-4 rounded-xl bg-[#090B0F] border border-emerald-500/30 flex flex-wrap items-center gap-5">
                    {mobileQrDataUrl && (
                      <img
                        src={mobileQrDataUrl}
                        alt="Mobile WalletConnect sweep QR"
                        className="w-36 h-36 rounded-lg border border-white/10 bg-[#F4F6F9] p-1"
                      />
                    )}
                    <div className="space-y-1.5 max-w-md">
                      <div className="text-xs font-semibold text-[#F4F6F9]">
                        Scan with Phone Camera or Mobile Wallet Scanner
                      </div>
                      <p className="text-xs text-[#8A94A6] leading-relaxed">
                        Opens Obsidian Vault directly on your mobile phone with Destination Vault{' '}
                        <span className="text-emerald-400 font-medium">{destinationWallet.name}</span>{' '}
                        pre-locked so you can connect MetaMask, Trust Wallet, Coinbase, or Phantom on mobile and sweep immediately.
                      </p>
                      <div className="font-mono text-[10px] text-[#64748B] break-all">
                        {sweepLandingUrl}
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {mobileAppsList.map((app) => (
                    <a
                      key={app.id}
                      href={app.href}
                      target={isMobile ? '_self' : '_blank'}
                      rel="noreferrer"
                      className="p-3 rounded-xl bg-[#090B0F] border border-white/10 hover:border-emerald-500/50 flex items-center justify-between gap-2 transition-colors"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: app.color }}
                          />
                          <span className="text-xs font-medium text-[#F4F6F9] truncate">
                            {app.name}
                          </span>
                        </div>
                        <div className="text-[10px] text-[#64748B] truncate mt-0.5">
                          {app.chains}
                        </div>
                      </div>
                      <ExternalLink className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    </a>
                  ))}
                </div>
              </div>
            </>
          ) : (
            /* Multi-Source Ephemeral Recovery Phrase or Private Key Sweep */
            <div className="space-y-4">
              {ephemeralSources.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-[#F4F6F9]">
                      Queued Source Wallets for Simultaneous Sweep ({ephemeralSources.length})
                    </span>
                    <button
                      type="button"
                      onClick={() => setEphemeralSources([])}
                      className="text-red-400 hover:underline"
                    >
                      Clear Queue
                    </button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                    {ephemeralSources.map((src) => (
                      <div
                        key={src.id}
                        className="p-3 rounded-lg bg-[#090B0F] border border-emerald-500/30 flex items-center justify-between gap-3 text-xs"
                      >
                        <label className="flex items-center gap-2.5 cursor-pointer min-w-0">
                          <input
                            type="checkbox"
                            checked={src.selected}
                            onChange={() =>
                              setEphemeralSources((prev) =>
                                prev.map((x) =>
                                  x.id === src.id ? { ...x, selected: !x.selected } : x
                                )
                              )
                            }
                            className="rounded border-white/20 bg-[#11151C] text-emerald-500"
                          />
                          <div className="min-w-0">
                            <div className="font-medium text-[#F4F6F9] truncate">{src.label}</div>
                            <div className="font-mono text-[11px] text-[#8A94A6] truncate">
                              {shortenAddress(src.evmAddress || src.solanaAddress, 8, 6)} ·{' '}
                              {formatFiat(balanceBySession.get(src.id) ?? 0, currency)}
                            </div>
                          </div>
                        </label>
                        <button
                          type="button"
                          onClick={() =>
                            setEphemeralSources((prev) => prev.filter((x) => x.id !== src.id))
                          }
                          className="p-1.5 text-[#8A94A6] hover:text-red-400 shrink-0"
                          aria-label="Remove source wallet"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1.5">
                    Source Wallet Derivation Preset (For Phrases)
                  </label>
                  <select
                    value={ephemeralPreset}
                    onChange={(e) => setEphemeralPreset(e.target.value as WalletPresetId)}
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9]"
                  >
                    {WALLET_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1.5">
                    Sweep Execution Mode
                  </label>
                  <select
                    value={broadcastMode}
                    onChange={(e) => setBroadcastMode(e.target.value as 'auto' | 'sandbox')}
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9]"
                  >
                    <option value="auto">Auto (Broadcast if funded, else Signed Dry-Run)</option>
                    <option value="sandbox">Cryptographic Sign Dry-Run Only</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs text-[#8A94A6] mb-1.5">
                  Add 12 / 18 / 24-Word Seed Phrase or Private Key to Sweep Queue (Memory Only)
                </label>
                <textarea
                  rows={2}
                  value={ephemeralInput}
                  onChange={(e) => setEphemeralInput(e.target.value)}
                  placeholder="Paste external wallet phrase or 0x... / Solana Base58 private key — add multiple wallets sequentially to batch-sweep together"
                  spellCheck={false}
                  className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3.5 py-2.5 font-mono text-xs text-[#F4F6F9] placeholder-[#525D70] focus:outline-none focus:border-emerald-500/60"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-[11px] text-[#64748B]">
                  Zero persistence: source keys clear automatically when leaving this view.
                </span>

                <button
                  type="button"
                  disabled={scanning}
                  onClick={handleAddEphemeralSource}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add & Scan Source Wallet</span>
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3.5 py-2.5">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>

      {/* Scanned Source Balances & Multi-Wallet Sweep Actions */}
      {(sourceHoldings.length > 0 || scanning) && (
        <div className="bg-[#11151C] border border-white/10 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-[#F4F6F9]">
                Sweepable Assets Across Selected Wallets
              </h3>
              <p className="text-xs text-[#8A94A6] mt-0.5 tabular-nums">
                {fundedHoldings.length} funded positions ({formatFiat(totalSweepableUsd, currency)}) · Tokens sweep before native gas coin per wallet
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-[#8A94A6] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showZeroBalances}
                  onChange={(e) => setShowZeroBalances(e.target.checked)}
                  className="rounded border-white/20 bg-[#090B0F] text-emerald-500"
                />
                <span>Show 0-balance chains</span>
              </label>

              {fundedHoldings.length > 0 && (
                <button
                  type="button"
                  disabled={batchSweeping || Boolean(sweepingKey)}
                  onClick={handleBatchSweepAll}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs"
                >
                  <Zap className="w-3.5 h-3.5" />
                  <span>
                    {batchSweeping
                      ? 'Sweeping Wallets...'
                      : `Sweep All (${fundedHoldings.length}) → ${destinationWallet.name}`}
                  </span>
                </button>
              )}
            </div>
          </div>

          <div className="divide-y divide-white/[0.06]">
            {scanning && sourceHoldings.length === 0 ? (
              <div className="p-8 text-center text-xs text-[#8A94A6]">
                Querying live multi-chain balances across all connected source wallets...
              </div>
            ) : displayedHoldings.length === 0 ? (
              <div className="p-10 text-center space-y-2">
                <p className="text-sm text-[#CBD5E1]">
                  No funded balances detected on connected wallets
                </p>
                <p className="text-xs text-[#64748B]">
                  Toggle "Show 0-balance chains" above or connect another funded wallet simultaneously.
                </p>
              </div>
            ) : (
              displayedHoldings.map((item) => {
                const rowKey = `${item.sourceSessionId}:${item.id}`;
                const isBusy = sweepingKey === rowKey;
                const canDryRun = sourceTab === 'ephemeral-key' && broadcastMode === 'sandbox';
                const canSweep = item.balance > 0 || canDryRun;
                return (
                  <div
                    key={rowKey}
                    className="px-6 py-3.5 flex flex-wrap items-center justify-between gap-4 text-xs hover:bg-white/[0.02]"
                  >
                    <div className="flex items-center gap-3 min-w-[220px]">
                      <TokenAvatar symbol={item.symbol} size={30} />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-[#F4F6F9]">{item.symbol}</span>
                          <span className="text-[10px] font-mono text-emerald-400">
                            {item.sourceWalletName} ({shortenAddress(item.sourceAddress, 4, 4)})
                          </span>
                        </div>
                        <div className="inline-flex items-center gap-1.5 text-[11px] text-[#8A94A6]">
                          <NetworkIcon networkId={item.networkId} size={14} />
                          <span>{item.networkName}</span>
                        </div>
                      </div>
                    </div>

                    <div className="text-right font-mono tabular-nums">
                      <div className="text-[#F4F6F9]">
                        {formatCryptoAmount(item.balance)} {item.symbol}
                      </div>
                      <div className="text-[11px] text-[#64748B]">
                        {formatFiat(item.valueUsd, currency)}
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={!canSweep || isBusy || batchSweeping}
                      onClick={() => executeSingleSweep(item)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 hover:border-emerald-500/50 disabled:opacity-40 text-xs font-medium text-[#F4F6F9]"
                    >
                      <span>{isBusy ? 'Sweeping...' : 'Sweep Max'}</span>
                      <ArrowRight className="w-3.5 h-3.5 text-emerald-400" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Sweep Receipts */}
      {sweepReceipts.length > 0 && (
        <div className="bg-[#11151C] border border-emerald-500/30 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/10 flex items-center gap-2 text-sm font-semibold text-emerald-400">
            <CheckCircle2 className="w-4 h-4" />
            <span>Sweep Execution Ledger</span>
          </div>
          <div className="divide-y divide-white/[0.06]">
            {sweepReceipts.map((tx) => {
              const net = NETWORK_MAP[tx.networkId];
              return (
                <div
                  key={`${tx.hash}-${tx.timestamp}`}
                  className="px-6 py-3.5 flex flex-wrap items-center justify-between gap-3 text-xs"
                >
                  <div className="space-y-0.5 min-w-0">
                    <div className="font-medium text-[#F4F6F9]">
                      Swept {tx.amount} {tx.symbol} on {net?.name}
                    </div>
                    <div className="font-mono text-[11px] text-[#8A94A6] truncate max-w-xl">
                      {tx.from} → {tx.to}
                    </div>
                    <div className="font-mono text-[11px] text-[#64748B] truncate max-w-xl">
                      Tx: {tx.hash} ·{' '}
                      {tx.status === 'signed-sandbox' ? 'Signed Dry-Run' : 'Broadcasted'}
                    </div>
                  </div>
                  {tx.status !== 'signed-sandbox' && net && (
                    <a
                      href={`${net.explorerUrl}/tx/${tx.hash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs text-emerald-400 hover:underline shrink-0"
                    >
                      <span>Explorer</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
