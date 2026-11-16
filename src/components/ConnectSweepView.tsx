import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Unplug,
  Wallet,
  Zap,
} from 'lucide-react';
import { deriveWalletFromMnemonic, deriveWalletFromPrivateKey, shortenAddress, validateMnemonicPhrase } from '../lib/crypto';
import { NETWORK_MAP, WALLET_PRESETS } from '../lib/networks';
import { formatCryptoAmount, formatFiat } from '../lib/formatters';
import { fetchMultiChainPortfolio } from '../lib/web3Service';
import {
  connectDiscoveredWallet,
  discoverExternalWalletProviders,
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
  WalletPresetId,
  WalletTransaction,
} from '../types/wallet';

interface ConnectSweepViewProps {
  wallets: WalletAccount[];
  activeWallet: WalletAccount;
  justCreatedWalletId?: string | null;
  markets: MarketCoin[];
  currency: 'USD' | 'EUR' | 'GBP';
  connectedExternal: ConnectedExternalWallet | null;
  onConnectedExternalChange: (w: ConnectedExternalWallet | null) => void;
  onSweepExecuted: (tx: WalletTransaction) => void;
  onDismissNewBanner?: () => void;
}

type SourceTab = 'walletconnect' | 'ephemeral-key';

export function ConnectSweepView({
  wallets,
  activeWallet,
  justCreatedWalletId,
  markets,
  currency,
  connectedExternal,
  onConnectedExternalChange,
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

  // EIP-6963 / WalletConnect Browser Providers
  const [discoveredProviders, setDiscoveredProviders] = useState<DiscoveredWalletProvider[]>([]);
  const [connectingUuid, setConnectingUuid] = useState<string | null>(null);
  const [ownershipSig, setOwnershipSig] = useState<string | null>(null);
  const [signingProof, setSigningProof] = useState(false);

  // Ephemeral External Seed / Key Source
  const [ephemeralInput, setEphemeralInput] = useState('');
  const [ephemeralPreset, setEphemeralPreset] = useState<WalletPresetId>('metamask');
  const [ephemeralDerived, setEphemeralDerived] = useState<{
    evmAddress: string;
    solanaAddress: string;
    secrets: UnlockedSecrets;
  } | null>(null);
  const [broadcastMode, setBroadcastMode] = useState<'auto' | 'sandbox'>('auto');

  // Scanned Holdings & Sweep Execution
  const [sourceHoldings, setSourceHoldings] = useState<PortfolioHolding[]>([]);
  const [scanning, setScanning] = useState(false);
  const [showZeroBalances, setShowZeroBalances] = useState(false);
  const [sweepingId, setSweepingId] = useState<string | null>(null);
  const [batchSweeping, setBatchSweeping] = useState(false);
  const [error, setError] = useState('');
  const [sweepReceipts, setSweepReceipts] = useState<WalletTransaction[]>([]);

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

  useEffect(() => {
    const stop = discoverExternalWalletProviders((list) => {
      setDiscoveredProviders(list);
    });
    return stop;
  }, []);

  const activeConnectedProvider = useMemo(() => {
    if (!connectedExternal) return null;
    return (
      discoveredProviders.find((p) => p.uuid === connectedExternal.id)?.provider ||
      discoveredProviders.find((p) => p.kind === connectedExternal.kind)?.provider ||
      null
    );
  }, [connectedExternal, discoveredProviders]);

  const scanAddressHoldings = async (evmAddr: string, solAddr: string) => {
    setScanning(true);
    setError('');
    try {
      const results = await fetchMultiChainPortfolio(
        {
          evmAddress: evmAddr,
          evmPath: '',
          solanaAddress: solAddr,
          solanaPath: '',
          bitcoinAddress: '',
          bitcoinPath: '',
          moneroAddress: '',
          moneroPath: '',
        },
        markets
      );
      setSourceHoldings(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to scan external wallet balances.');
    } finally {
      setScanning(false);
    }
  };

  // Automatically scan when connected external wallet changes
  useEffect(() => {
    if (sourceTab !== 'walletconnect' || !connectedExternal) return;
    if (connectedExternal.kind === 'evm') {
      scanAddressHoldings(connectedExternal.address, '');
    } else {
      scanAddressHoldings('', connectedExternal.address);
    }
  }, [sourceTab, connectedExternal?.address, connectedExternal?.kind]);

  const handleConnectProvider = async (item: DiscoveredWalletProvider) => {
    setError('');
    setOwnershipSig(null);
    setConnectingUuid(item.uuid);
    try {
      const conn = await connectDiscoveredWallet(item);
      onConnectedExternalChange(conn);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect external wallet.');
    } finally {
      setConnectingUuid(null);
    }
  };

  const handleDisconnect = () => {
    onConnectedExternalChange(null);
    setOwnershipSig(null);
    setSourceHoldings([]);
    setError('');
  };

  const handleVerifyOwnership = async () => {
    if (!connectedExternal || !activeConnectedProvider || !destinationWallet.addresses.evmAddress) {
      return;
    }
    setSigningProof(true);
    setError('');
    try {
      const sig = await signExternalOwnershipProof(
        activeConnectedProvider,
        connectedExternal.address,
        destinationWallet.addresses.evmAddress
      );
      setOwnershipSig(sig);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ownership signature rejected.');
    } finally {
      setSigningProof(false);
    }
  };

  const handleScanEphemeralSource = async () => {
    setError('');
    const raw = ephemeralInput.trim();
    if (!raw) {
      setError('Paste a 12, 18, or 24-word recovery phrase or raw EVM/Solana private key to scan.');
      return;
    }

    try {
      const words = raw.split(/\s+/).filter(Boolean);
      if (words.length === 12 || words.length === 18 || words.length === 24) {
        const check = validateMnemonicPhrase(raw);
        if (!check.valid) {
          throw new Error(check.error || 'Invalid BIP-39 recovery phrase.');
        }
        const derived = deriveWalletFromMnemonic(raw, {
          preset: ephemeralPreset,
          accountIndex: 0,
        });
        setEphemeralDerived({
          evmAddress: derived.addresses.evmAddress,
          solanaAddress: derived.addresses.solanaAddress,
          secrets: derived.secrets,
        });
        await scanAddressHoldings(
          derived.addresses.evmAddress,
          derived.addresses.solanaAddress
        );
      } else {
        const derived = deriveWalletFromPrivateKey(raw, 'auto');
        if (derived.family === 'monero') {
          throw new Error('Use Send & Receive to transfer Monero (XMR) balances.');
        }
        setEphemeralDerived({
          evmAddress: derived.addresses.evmAddress,
          solanaAddress: derived.addresses.solanaAddress,
          secrets: derived.secrets,
        });
        await scanAddressHoldings(
          derived.addresses.evmAddress,
          derived.addresses.solanaAddress
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to parse source phrase or private key.');
    }
  };

  const executeSingleSweep = async (holding: PortfolioHolding) => {
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

    setSweepingId(holding.id);
    try {
      let tx: WalletTransaction;

      if (sourceTab === 'walletconnect') {
        if (!connectedExternal || !activeConnectedProvider) {
          throw new Error('Reconnect your external EVM wallet first.');
        }
        if (connectedExternal.kind !== 'evm') {
          throw new Error(
            'Automated sweep via extension currently supports EVM wallets. For Solana, paste your Solana secret key or phrase in the Recovery Phrase / Key tab.'
          );
        }
        tx = await sweepHoldingViaConnectedEvmWallet({
          provider: activeConnectedProvider,
          holding,
          fromAddress: connectedExternal.address,
          destinationAddress: destEvm,
        });
      } else {
        if (!ephemeralDerived) {
          throw new Error('Scan a source phrase or private key first.');
        }
        tx = await sweepHoldingViaPrivateKey({
          holding,
          sourceSecrets: ephemeralDerived.secrets,
          sourceAddresses: {
            evmAddress: ephemeralDerived.evmAddress,
            solanaAddress: ephemeralDerived.solanaAddress,
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
      setSweepingId(null);
    }
  };

  const fundedHoldings = useMemo(
    () =>
      sourceHoldings.filter(
        (h) =>
          h.balance > 0 &&
          (NETWORK_MAP[h.networkId].family === 'evm' ||
            (h.networkId === 'solana' && h.isNative))
      ),
    [sourceHoldings]
  );

  const handleBatchSweepAll = async () => {
    if (fundedHoldings.length === 0) return;
    setBatchSweeping(true);
    setError('');

    // Sweep ERC-20 tokens first so native gas remains available until the final sweep
    const ordered = [...fundedHoldings].sort((a, b) => Number(a.isNative) - Number(b.isNative));

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
                WalletConnect & Multi-Chain Sweep
              </h2>
              <p className="text-xs text-[#8A94A6] mt-0.5">
                Connect an external wallet or sweep a source phrase/key directly into your Obsidian Vault
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
          <div className="flex items-center gap-1 p-1 bg-[#090B0F] border border-white/10 rounded-lg">
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
              <span>WalletConnect (External Wallets)</span>
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
              <span>Sweep Seed Phrase / Private Key</span>
            </button>
          </div>

          {sourceHoldings.length > 0 && (
            <button
              type="button"
              onClick={() => {
                if (sourceTab === 'walletconnect' && connectedExternal) {
                  scanAddressHoldings(
                    connectedExternal.kind === 'evm' ? connectedExternal.address : '',
                    connectedExternal.kind === 'solana' ? connectedExternal.address : ''
                  );
                } else if (ephemeralDerived) {
                  scanAddressHoldings(
                    ephemeralDerived.evmAddress,
                    ephemeralDerived.solanaAddress
                  );
                }
              }}
              disabled={scanning}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#CBD5E1] hover:text-[#F4F6F9]"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
              <span>{scanning ? 'Scanning Chains...' : 'Rescan Balances'}</span>
            </button>
          )}
        </div>

        <div className="p-6 space-y-5">
          {sourceTab === 'walletconnect' ? (
            !connectedExternal ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-[#F4F6F9]">
                      Detected Web3 Wallets (EIP-6963 & Solana)
                    </h3>
                    <p className="text-xs text-[#8A94A6] mt-0.5">
                      Connect MetaMask, Rabby, Coinbase Wallet, Trust Wallet, or Phantom to scan balances and sweep to your new Vault
                    </p>
                  </div>
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
                        <span className="text-xs font-medium text-emerald-400 shrink-0">
                          {connectingUuid === prov.uuid ? 'Connecting...' : 'Connect'}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="p-5 rounded-xl bg-[#090B0F] border border-white/10 space-y-3">
                    <div className="text-xs font-semibold text-[#F4F6F9]">
                      No Browser Wallet Extension Detected in This Frame
                    </div>
                    <p className="text-xs text-[#8A94A6] leading-relaxed">
                      Browser extensions like MetaMask, Rabby, and Phantom inject providers into top-level tabs and may be blocked inside embedded preview iframes. You can open this app in a full browser tab to connect your extension, or sweep immediately via your source recovery phrase or private key.
                    </p>
                    <div className="flex flex-wrap items-center gap-2.5 pt-1">
                      <a
                        href={typeof window !== 'undefined' ? window.location.href : '#'}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#1A2130] hover:bg-[#232C3F] border border-white/10 text-xs font-medium text-[#F4F6F9]"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        <span>Open in Full Tab for Extensions</span>
                      </a>
                      <button
                        type="button"
                        onClick={() => setSourceTab('ephemeral-key')}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] text-xs font-semibold"
                      >
                        <KeyRound className="w-3.5 h-3.5" />
                        <span>Sweep via Seed Phrase / Key Instead</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="p-4 rounded-xl bg-[#090B0F] border border-emerald-500/30 flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  {connectedExternal.icon ? (
                    <img
                      src={connectedExternal.icon}
                      alt={connectedExternal.name}
                      className="w-9 h-9 rounded-lg object-contain shrink-0"
                    />
                  ) : (
                    <div className="w-9 h-9 rounded-lg bg-emerald-500/15 flex items-center justify-center text-emerald-400 shrink-0">
                      <Wallet className="w-4 h-4" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-semibold text-[#F4F6F9]">
                        {connectedExternal.name}
                      </span>
                      <span className="text-[#64748B]">·</span>
                      <span className="text-emerald-400">Connected</span>
                      {connectedExternal.chainId && (
                        <>
                          <span className="text-[#64748B]">·</span>
                          <span className="font-mono text-[#8A94A6]">
                            Chain #{connectedExternal.chainId}
                          </span>
                        </>
                      )}
                    </div>
                    <div className="font-mono text-xs text-[#CBD5E1] truncate mt-0.5">
                      {connectedExternal.address}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {connectedExternal.kind === 'evm' && activeConnectedProvider && (
                    <button
                      type="button"
                      disabled={signingProof}
                      onClick={handleVerifyOwnership}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#11151C] border border-white/10 hover:border-emerald-500/40 text-xs text-[#CBD5E1]"
                    >
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                      <span>
                        {ownershipSig
                          ? 'Ownership Verified'
                          : signingProof
                          ? 'Awaiting Signature...'
                          : 'Sign Sweep Auth'}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleDisconnect}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#11151C] border border-white/10 hover:border-red-500/40 text-xs text-[#8A94A6] hover:text-red-300"
                  >
                    <Unplug className="w-3.5 h-3.5" />
                    <span>Disconnect</span>
                  </button>
                </div>
              </div>
            )
          ) : (
            /* Ephemeral Recovery Phrase or Private Key Sweep */
            <div className="space-y-4">
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
                  External 12 / 18 / 24-Word Seed Phrase or Raw Private Key (Held in Memory Only)
                </label>
                <textarea
                  rows={2}
                  value={ephemeralInput}
                  onChange={(e) => setEphemeralInput(e.target.value)}
                  placeholder="Paste external wallet phrase or 0x... / Solana Base58 private key — never saved to disk or cloud"
                  spellCheck={false}
                  className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3.5 py-2.5 font-mono text-xs text-[#F4F6F9] placeholder-[#525D70] focus:outline-none focus:border-emerald-500/60"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                {ephemeralDerived ? (
                  <div className="text-xs font-mono text-[#8A94A6]">
                    Source:{' '}
                    <span className="text-[#F4F6F9]">
                      {shortenAddress(
                        ephemeralDerived.evmAddress || ephemeralDerived.solanaAddress,
                        10,
                        8
                      )}
                    </span>
                  </div>
                ) : (
                  <span className="text-[11px] text-[#64748B]">
                    Zero persistence: source keys clear automatically when leaving this view.
                  </span>
                )}

                <button
                  type="button"
                  disabled={scanning}
                  onClick={handleScanEphemeralSource}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
                  <span>{scanning ? 'Scanning On-Chain...' : 'Scan Source Wallet'}</span>
                </button>
              </div>
            </div>
          )}

          {ownershipSig && (
            <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-[11px] font-mono text-emerald-300 break-all">
              Verified Ownership Signature: {ownershipSig}
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

      {/* Scanned Source Balances & Sweep Actions */}
      {(sourceHoldings.length > 0 || scanning) && (
        <div className="bg-[#11151C] border border-white/10 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-[#F4F6F9]">
                Sweepable Source Assets
              </h3>
              <p className="text-xs text-[#8A94A6] mt-0.5 tabular-nums">
                {fundedHoldings.length} funded positions ({formatFiat(totalSweepableUsd, currency)}) · Tokens sweep before native gas coin
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
                  disabled={batchSweeping || Boolean(sweepingId)}
                  onClick={handleBatchSweepAll}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs"
                >
                  <Zap className="w-3.5 h-3.5" />
                  <span>
                    {batchSweeping
                      ? 'Sweeping All...'
                      : `Sweep All (${fundedHoldings.length}) to ${destinationWallet.name}`}
                  </span>
                </button>
              )}
            </div>
          </div>

          <div className="divide-y divide-white/[0.06]">
            {scanning && sourceHoldings.length === 0 ? (
              <div className="p-8 text-center text-xs text-[#8A94A6]">
                Querying live multi-chain balances across Ethereum, Arbitrum, Base, Optimism, Polygon, BSC, Avalanche, Sepolia, and Solana...
              </div>
            ) : displayedHoldings.length === 0 ? (
              <div className="p-10 text-center space-y-2">
                <p className="text-sm text-[#CBD5E1]">No funded balances detected on scanned networks</p>
                <p className="text-xs text-[#64748B]">
                  Toggle "Show 0-balance chains" above to inspect networks or test a signed sweep dry-run.
                </p>
              </div>
            ) : (
              displayedHoldings.map((item) => {
                const isBusy = sweepingId === item.id;
                const canDryRun = sourceTab === 'ephemeral-key' && broadcastMode === 'sandbox';
                const canSweep = item.balance > 0 || canDryRun;
                return (
                  <div
                    key={item.id}
                    className="px-6 py-3.5 flex flex-wrap items-center justify-between gap-4 text-xs hover:bg-white/[0.02]"
                  >
                    <div className="flex items-center gap-3 min-w-[200px]">
                      <TokenAvatar symbol={item.symbol} size={30} />
                      <div>
                        <div className="font-medium text-[#F4F6F9]">{item.symbol}</div>
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
                      Tx: {tx.hash} · {tx.status === 'signed-sandbox' ? 'Signed Dry-Run' : 'Broadcasted'}
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
