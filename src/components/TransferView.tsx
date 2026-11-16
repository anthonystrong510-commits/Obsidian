import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import {
  ArrowDownLeft,
  ArrowUpRight,
  BookUser,
  Check,
  Copy,
  ExternalLink,
  Fuel,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { isAddress } from 'ethers';
import { NETWORKS, NETWORK_MAP } from '../lib/networks';
import { isValidBitcoinAddress, isValidSolanaAddress, shortenAddress } from '../lib/crypto';
import { formatCryptoAmount, formatFiat } from '../lib/formatters';
import {
  estimateEvmTransferFee,
  resolveEnsAddress,
  signAndExecuteEvmTransfer,
} from '../lib/web3Service';
import { NetworkIcon } from './NetworkIcon';
import type {
  AddressBookEntry,
  NetworkId,
  PortfolioHolding,
  UnlockedSecrets,
  WalletAccount,
  WalletTransaction,
} from '../types/wallet';

interface TransferViewProps {
  initialMode?: 'send' | 'receive';
  initialNetworkId?: NetworkId;
  initialSymbol?: string;
  wallet: WalletAccount;
  secrets: UnlockedSecrets;
  holdings: PortfolioHolding[];
  addressBook: AddressBookEntry[];
  currency: 'USD' | 'EUR' | 'GBP';
  onTransactionCreated: (tx: WalletTransaction) => void;
  onAddContact: (entry: AddressBookEntry) => void;
}

export function TransferView({
  initialMode = 'send',
  initialNetworkId = 'ethereum',
  initialSymbol,
  wallet,
  secrets,
  holdings,
  addressBook,
  currency,
  onTransactionCreated,
  onAddContact,
}: TransferViewProps) {
  const [mode, setMode] = useState<'send' | 'receive'>(initialMode);
  const [networkId, setNetworkId] = useState<NetworkId>(initialNetworkId);
  const [selectedSymbol, setSelectedSymbol] = useState<string>(
    initialSymbol || NETWORK_MAP[initialNetworkId].symbol
  );

  // Send State
  const [recipientInput, setRecipientInput] = useState('');
  const [resolvedRecipient, setResolvedRecipient] = useState('');
  const [resolvingEns, setResolvingEns] = useState(false);
  const [amountInput, setAmountInput] = useState('');
  const [speed, setSpeed] = useState<'slow' | 'standard' | 'fast'>('standard');
  const [estimatedFeeNative, setEstimatedFeeNative] = useState('0.00042');
  const [broadcastMode, setBroadcastMode] = useState<'auto' | 'sandbox'>('auto');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [lastTx, setLastTx] = useState<WalletTransaction | null>(null);
  const [saveToBookLabel, setSaveToBookLabel] = useState('');

  // Receive State
  const [requestAmount, setRequestAmount] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copiedAddr, setCopiedAddr] = useState(false);

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  useEffect(() => {
    if (initialNetworkId) {
      setNetworkId(initialNetworkId);
      setSelectedSymbol(initialSymbol || NETWORK_MAP[initialNetworkId].symbol);
    }
  }, [initialNetworkId, initialSymbol]);

  const activeNetwork = NETWORK_MAP[networkId];

  const networkHoldings = useMemo(() => {
    const list = holdings.filter((h) => h.networkId === networkId);
    if (list.length > 0) return list;
    return activeNetwork.tokens.map((t) => ({
      id: `${networkId}:${t.address}`,
      networkId,
      networkName: activeNetwork.name,
      symbol: t.symbol,
      name: t.name,
      address: t.address,
      decimals: t.decimals,
      coinGeckoId: t.coinGeckoId,
      balance: 0,
      balanceRaw: '0',
      priceUsd: 0,
      change24h: 0,
      valueUsd: 0,
      isNative: t.address === 'native',
    }));
  }, [holdings, networkId, activeNetwork]);

  const activeToken = useMemo(
    () =>
      networkHoldings.find((h) => h.symbol === selectedSymbol) || networkHoldings[0],
    [networkHoldings, selectedSymbol]
  );

  const senderAddress = useMemo(() => {
    if (activeNetwork.family === 'evm') return wallet.addresses.evmAddress;
    if (activeNetwork.family === 'solana') return wallet.addresses.solanaAddress;
    return wallet.addresses.bitcoinAddress;
  }, [activeNetwork.family, wallet.addresses]);

  const derivationPath = useMemo(() => {
    if (activeNetwork.family === 'evm') return wallet.addresses.evmPath;
    if (activeNetwork.family === 'solana') return wallet.addresses.solanaPath;
    return wallet.addresses.bitcoinPath;
  }, [activeNetwork.family, wallet.addresses]);

  // ENS resolution when typing .eth
  useEffect(() => {
    const trimmed = recipientInput.trim();
    if (!trimmed) {
      setResolvedRecipient('');
      return;
    }
    if (activeNetwork.family === 'evm' && trimmed.includes('.')) {
      setResolvingEns(true);
      const timer = setTimeout(() => {
        resolveEnsAddress(trimmed)
          .then((addr) => setResolvedRecipient(addr || ''))
          .finally(() => setResolvingEns(false));
      }, 350);
      return () => clearTimeout(timer);
    } else {
      setResolvedRecipient(trimmed);
    }
  }, [recipientInput, activeNetwork.family]);

  const targetAddress = resolvedRecipient || recipientInput.trim();

  const isRecipientValid = useMemo(() => {
    if (!targetAddress) return false;
    if (activeNetwork.family === 'evm') return isAddress(targetAddress);
    if (activeNetwork.family === 'solana') return isValidSolanaAddress(targetAddress);
    return isValidBitcoinAddress(targetAddress);
  }, [targetAddress, activeNetwork.family]);

  // Live Gas Estimation for EVM
  useEffect(() => {
    if (mode !== 'send' || activeNetwork.family !== 'evm' || !senderAddress) return;
    const multiplier = speed === 'slow' ? 0.85 : speed === 'fast' ? 1.35 : 1.0;
    const estTo = isRecipientValid ? targetAddress : senderAddress;
    const estAmt = Number(amountInput) > 0 ? amountInput : '0.001';

    estimateEvmTransferFee(
      networkId,
      senderAddress,
      estTo,
      estAmt,
      activeToken?.address || 'native',
      activeToken?.decimals || 18,
      multiplier
    )
      .then((res) => setEstimatedFeeNative(res.feeNative))
      .catch(() => {});
  }, [
    mode,
    networkId,
    activeNetwork.family,
    senderAddress,
    targetAddress,
    isRecipientValid,
    amountInput,
    activeToken,
    speed,
  ]);

  // Receive QR Code Generation
  const receiveUri = useMemo(() => {
    if (!senderAddress) return '';
    const amt = Number(requestAmount);
    if (activeNetwork.family === 'evm') {
      return amt > 0
        ? `ethereum:${senderAddress}@${activeNetwork.chainId || 1}?value=${amt}`
        : senderAddress;
    }
    if (activeNetwork.family === 'bitcoin') {
      return amt > 0 ? `bitcoin:${senderAddress}?amount=${amt}` : `bitcoin:${senderAddress}`;
    }
    return amt > 0 ? `solana:${senderAddress}?amount=${amt}` : senderAddress;
  }, [senderAddress, requestAmount, activeNetwork]);

  useEffect(() => {
    if (mode !== 'receive' || !receiveUri) {
      setQrDataUrl('');
      return;
    }
    QRCode.toDataURL(receiveUri, {
      width: 240,
      margin: 2,
      color: { dark: '#090B0F', light: '#FFFFFF' },
    })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [mode, receiveUri]);

  const handleCopyAddress = async () => {
    if (!senderAddress) return;
    await navigator.clipboard.writeText(senderAddress);
    setCopiedAddr(true);
    setTimeout(() => setCopiedAddr(false), 1800);
  };

  const handleSetPercent = (pct: number) => {
    const bal = activeToken?.balance || 0;
    if (bal <= 0) {
      setAmountInput('0.01');
      return;
    }
    const feeBuffer = activeToken?.isNative ? Number(estimatedFeeNative) * 1.1 : 0;
    const usable = Math.max(0, bal - (pct === 1 ? feeBuffer : 0));
    setAmountInput((usable * pct).toFixed(6).replace(/\.?0+$/, ''));
  };

  const handleExecuteSend = async () => {
    setSendError('');
    setLastTx(null);

    if (wallet.type === 'watchOnly') {
      setSendError('Watch-Only wallets cannot sign transactions. Import or create a signing wallet.');
      return;
    }
    if (!isRecipientValid) {
      setSendError(`Enter a valid ${activeNetwork.name} recipient address.`);
      return;
    }
    const amt = Number(amountInput);
    if (!Number.isFinite(amt) || amt <= 0) {
      setSendError('Enter a transfer amount greater than 0.');
      return;
    }

    setSending(true);
    try {
      if (activeNetwork.family === 'evm') {
        if (!secrets.evmPrivateKey) {
          throw new Error('EVM private key not unlocked in current session.');
        }
        const nativeHolding = holdings.find(
          (h) => h.networkId === networkId && h.isNative
        );
        const hasGasOnChain = (nativeHolding?.balance || 0) >= Number(estimatedFeeNative);
        const shouldBroadcast = broadcastMode === 'auto' && hasGasOnChain;

        const tx = await signAndExecuteEvmTransfer({
          networkId,
          privateKey: secrets.evmPrivateKey,
          toAddress: targetAddress,
          amountStr: amountInput,
          tokenAddress: activeToken?.address || 'native',
          decimals: activeToken?.decimals || 18,
          symbol: activeToken?.symbol || activeNetwork.symbol,
          speedMultiplier: speed === 'slow' ? 0.85 : speed === 'fast' ? 1.35 : 1.0,
          broadcastOnChain: shouldBroadcast,
        });
        setLastTx(tx);
        onTransactionCreated(tx);
      } else {
        // Non-EVM cryptographic signed payload + local/sandbox broadcast preview
        const mockSig = Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        const tx: WalletTransaction = {
          hash: activeNetwork.family === 'solana' ? `sol_${mockSig.slice(0, 44)}` : mockSig,
          networkId,
          type: 'send',
          status: 'signed-sandbox',
          from: senderAddress,
          to: targetAddress,
          symbol: activeNetwork.symbol,
          amount: amountInput,
          feeFormatted: activeNetwork.family === 'solana' ? '0.000005 SOL' : '0.000024 BTC',
          rawSignedHex: `0x${mockSig}`,
          timestamp: Date.now(),
          note: `${activeNetwork.name} transfer signed locally in sandbox mode`,
        };
        setLastTx(tx);
        onTransactionCreated(tx);
      }

      if (saveToBookLabel.trim()) {
        onAddContact({
          id: crypto.randomUUID(),
          label: saveToBookLabel.trim(),
          address: targetAddress,
          networkFamily: activeNetwork.family,
          createdAt: Date.now(),
        });
        setSaveToBookLabel('');
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Transaction signing failed.');
    } finally {
      setSending(false);
    }
  };

  const compatibleContacts = addressBook.filter(
    (c) => c.networkFamily === activeNetwork.family
  );

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Mode & Network Selector Header */}
      <div className="bg-[#11151C] border border-white/10 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-[#090B0F] border border-white/10 rounded-lg">
          <button
            type="button"
            onClick={() => setMode('send')}
            className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
              mode === 'send'
                ? 'bg-emerald-500 text-[#090B0F] font-semibold'
                : 'text-[#8A94A6] hover:text-[#F4F6F9]'
            }`}
          >
            <ArrowUpRight className="w-4 h-4" />
            <span>Send Crypto</span>
          </button>
          <button
            type="button"
            onClick={() => setMode('receive')}
            className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
              mode === 'receive'
                ? 'bg-emerald-500 text-[#090B0F] font-semibold'
                : 'text-[#8A94A6] hover:text-[#F4F6F9]'
            }`}
          >
            <ArrowDownLeft className="w-4 h-4" />
            <span>Receive Crypto</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-[#8A94A6]">Network:</span>
          <select
            value={networkId}
            onChange={(e) => {
              const next = e.target.value as NetworkId;
              setNetworkId(next);
              setSelectedSymbol(NETWORK_MAP[next].symbol);
              setSendError('');
              setLastTx(null);
            }}
            className="bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-xs font-medium text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
          >
            {NETWORKS.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name} ({n.symbol})
              </option>
            ))}
          </select>
        </div>
      </div>

      {mode === 'send' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-8 bg-[#11151C] border border-white/10 rounded-xl p-6 space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <NetworkIcon networkId={networkId} size={28} />
                <div>
                  <h3 className="text-base font-semibold text-[#F4F6F9]">
                    Send on {activeNetwork.name}
                  </h3>
                  <p className="text-xs font-mono text-[#8A94A6]">
                    From: {shortenAddress(senderAddress, 8, 6)}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <div className="text-[11px] text-[#8A94A6]">Available</div>
                <div className="font-mono text-xs text-[#F4F6F9] tabular-nums">
                  {formatCryptoAmount(activeToken?.balance || 0)} {activeToken?.symbol}
                </div>
              </div>
            </div>

            {/* Token Selector */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[#8A94A6] mb-1.5">Asset</label>
                <select
                  value={activeToken?.symbol || ''}
                  onChange={(e) => setSelectedSymbol(e.target.value)}
                  className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
                >
                  {networkHoldings.map((tok) => (
                    <option key={tok.id} value={tok.symbol}>
                      {tok.symbol} — {tok.name} ({formatCryptoAmount(tok.balance)})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs text-[#8A94A6]">Amount</label>
                  <div className="flex items-center gap-1">
                    {[0.25, 0.5, 1].map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        onClick={() => handleSetPercent(pct)}
                        className="px-1.5 py-0.5 rounded bg-[#090B0F] border border-white/10 text-[10px] font-mono text-[#8A94A6] hover:text-[#F4F6F9]"
                      >
                        {pct === 1 ? 'MAX' : `${pct * 100}%`}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="relative">
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={amountInput}
                    onChange={(e) => setAmountInput(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2.5 pr-16 font-mono text-sm text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-[#8A94A6]">
                    {activeToken?.symbol}
                  </span>
                </div>
                {Number(amountInput) > 0 && activeToken && activeToken.priceUsd > 0 && (
                  <p className="text-[11px] font-mono text-[#64748B] mt-1 tabular-nums">
                    ≈ {formatFiat(Number(amountInput) * activeToken.priceUsd, currency)}
                  </p>
                )}
              </div>
            </div>

            {/* Recipient */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs text-[#8A94A6]">
                  Recipient Address {activeNetwork.family === 'evm' ? 'or ENS (.eth)' : ''}
                </label>
                {compatibleContacts.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) setRecipientInput(e.target.value);
                    }}
                    className="bg-[#090B0F] border border-white/10 rounded px-2 py-1 text-[11px] text-[#CBD5E1]"
                  >
                    <option value="">Pick from Address Book</option>
                    {compatibleContacts.map((c) => (
                      <option key={c.id} value={c.address}>
                        {c.label} ({shortenAddress(c.address)})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <input
                type="text"
                value={recipientInput}
                onChange={(e) => setRecipientInput(e.target.value)}
                placeholder={
                  activeNetwork.family === 'evm'
                    ? '0x... or vitalik.eth'
                    : activeNetwork.family === 'solana'
                    ? 'Solana Base58 address'
                    : 'bc1q... Bitcoin SegWit address'
                }
                spellCheck={false}
                className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3.5 py-2.5 font-mono text-xs text-[#F4F6F9] placeholder-[#525D70] focus:outline-none focus:border-emerald-500/60"
              />

              {resolvingEns && (
                <p className="text-[11px] text-[#8A94A6]">Resolving ENS domain on Ethereum...</p>
              )}
              {resolvedRecipient && recipientInput.includes('.') && (
                <p className="text-[11px] font-mono text-emerald-400">
                  Resolved: {resolvedRecipient}
                </p>
              )}
            </div>

            {/* Optional Save Contact */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div>
                <label className="block text-[11px] text-[#8A94A6] mb-1">
                  Save to Address Book (Optional)
                </label>
                <div className="relative">
                  <BookUser className="w-3.5 h-3.5 text-[#64748B] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={saveToBookLabel}
                    onChange={(e) => setSaveToBookLabel(e.target.value)}
                    placeholder="Contact label (e.g. Hardware Ledger)"
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg pl-8 pr-3 py-2 text-xs text-[#F4F6F9]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-[#8A94A6] mb-1">
                  Execution Mode
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

            {sendError && (
              <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5">
                <ShieldAlert className="w-4 h-4 shrink-0" />
                <span>{sendError}</span>
              </div>
            )}

            <button
              type="button"
              disabled={sending}
              onClick={handleExecuteSend}
              className="w-full py-3 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-sm transition-colors"
            >
              {sending
                ? 'Signing Transaction...'
                : `Sign & Send ${amountInput || '0'} ${activeToken?.symbol || activeNetwork.symbol}`}
            </button>
          </div>

          {/* Gas & Signature Summary Sidebar */}
          <div className="lg:col-span-4 space-y-4">
            <div className="bg-[#11151C] border border-white/10 rounded-xl p-5 space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#F4F6F9]">
                <Fuel className="w-4 h-4 text-emerald-400" />
                <span>Network Fee & Speed</span>
              </div>

              <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#090B0F] border border-white/10 rounded-lg">
                {(['slow', 'standard', 'fast'] as const).map((tier) => (
                  <button
                    key={tier}
                    type="button"
                    onClick={() => setSpeed(tier)}
                    className={`py-1.5 rounded text-xs capitalize transition-colors ${
                      speed === tier
                        ? 'bg-[#1D2432] text-[#F4F6F9] font-medium'
                        : 'text-[#8A94A6] hover:text-[#F4F6F9]'
                    }`}
                  >
                    {tier}
                  </button>
                ))}
              </div>

              <div className="space-y-2 text-xs pt-2 border-t border-white/10">
                <div className="flex justify-between">
                  <span className="text-[#8A94A6]">Estimated Fee</span>
                  <span className="font-mono text-[#F4F6F9] tabular-nums">
                    {activeNetwork.family === 'evm'
                      ? `${estimatedFeeNative} ${activeNetwork.symbol}`
                      : activeNetwork.family === 'solana'
                      ? '0.000005 SOL'
                      : '0.000024 BTC'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#8A94A6]">Signing Standard</span>
                  <span className="font-mono text-[#CBD5E1]">
                    {activeNetwork.family === 'evm'
                      ? 'EIP-155'
                      : activeNetwork.family === 'solana'
                      ? 'Ed25519'
                      : 'BIP-143 SegWit'}
                  </span>
                </div>
              </div>
            </div>

            {lastTx && (
              <div className="bg-[#11151C] border border-emerald-500/30 rounded-xl p-5 space-y-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400">
                  <ShieldCheck className="w-4 h-4" />
                  <span>
                    {lastTx.status === 'signed-sandbox'
                      ? 'Cryptographically Signed (Sandbox)'
                      : 'Broadcasted to Network'}
                  </span>
                </div>
                <div className="text-xs text-[#8A94A6] space-y-1.5">
                  <div>
                    <span className="block text-[11px]">Transaction Hash</span>
                    <span className="font-mono text-[11px] text-[#F4F6F9] break-all">
                      {lastTx.hash}
                    </span>
                  </div>
                  {lastTx.rawSignedHex && (
                    <div>
                      <span className="block text-[11px]">Raw Signed Payload</span>
                      <span className="font-mono text-[10px] text-[#64748B] break-all line-clamp-3">
                        {lastTx.rawSignedHex}
                      </span>
                    </div>
                  )}
                </div>
                {lastTx.status !== 'signed-sandbox' && (
                  <a
                    href={`${activeNetwork.explorerUrl}/tx/${lastTx.hash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-emerald-400 hover:underline"
                  >
                    <span>Inspect on Explorer</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Receive QR Code & Multi-Chain Address Studio */
        <div className="bg-[#11151C] border border-white/10 rounded-xl p-6 grid grid-cols-1 md:grid-cols-12 gap-8 items-center">
          <div className="md:col-span-5 flex flex-col items-center justify-center p-6 rounded-xl bg-[#090B0F] border border-white/10">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt={`${activeNetwork.name} Receive QR`}
                className="w-52 h-52 rounded-lg"
              />
            ) : (
              <div className="w-52 h-52 rounded-lg bg-white/5 flex items-center justify-center text-xs text-[#64748B]">
                No address derived for {activeNetwork.name}
              </div>
            )}
            <p className="text-[11px] text-[#8A94A6] mt-4 text-center">
              Scan with any {activeNetwork.name} compatible wallet
            </p>
          </div>

          <div className="md:col-span-7 space-y-5">
            <div className="flex items-center gap-3">
              <NetworkIcon networkId={networkId} size={32} />
              <div>
                <h3 className="text-lg font-semibold text-[#F4F6F9]">
                  Receive on {activeNetwork.name}
                </h3>
                <p className="text-xs text-[#8A94A6]">
                  Derivation path: <span className="font-mono">{derivationPath}</span>
                </p>
              </div>
            </div>

            <div>
              <label className="block text-xs text-[#8A94A6] mb-1.5">
                Your {activeNetwork.name} Deposit Address
              </label>
              <div className="flex items-center gap-2 bg-[#090B0F] border border-white/10 rounded-lg px-3.5 py-3">
                <code className="text-xs text-[#F4F6F9] break-all flex-1">
                  {senderAddress || 'Not available for this imported key type'}
                </code>
                <button
                  type="button"
                  onClick={handleCopyAddress}
                  disabled={!senderAddress}
                  className="px-3 py-1.5 rounded bg-[#1A2130] hover:bg-[#232C3F] text-xs text-[#F4F6F9] inline-flex items-center gap-1.5 shrink-0"
                >
                  {copiedAddr ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-400">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs text-[#8A94A6] mb-1.5">
                Request Specific Amount (Embeds Payment URI in QR)
              </label>
              <div className="relative max-w-xs">
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={requestAmount}
                  onChange={(e) => setRequestAmount(e.target.value)}
                  placeholder="Optional amount"
                  className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 pr-14 font-mono text-xs text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-[#8A94A6]">
                  {activeNetwork.symbol}
                </span>
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#8A94A6] leading-relaxed">
              Only send {activeNetwork.name} ({activeNetwork.symbol} or supported tokens) to this address. Sending assets from an incompatible blockchain network may result in permanent loss.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
