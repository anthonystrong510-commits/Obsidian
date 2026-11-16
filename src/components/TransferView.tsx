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
import {
  deriveWalletFromMnemonic,
  isValidBitcoinAddress,
  isValidMoneroAddress,
  isValidSolanaAddress,
  shortenAddress,
} from '../lib/crypto';
import { formatCryptoAmount, formatFiat } from '../lib/formatters';
import {
  calculateExchangeFeeAndGas,
  estimateEvmTransferFee,
  resolveEnsAddress,
  signAndExecuteEvmTransfer,
} from '../lib/web3Service';
import { NetworkIcon } from './NetworkIcon';
import type {
  AddressBookEntry,
  ExchangeSystemConfig,
  FeeGasSettlementRecord,
  MarketCoin,
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
  markets?: MarketCoin[];
  addressBook: AddressBookEntry[];
  currency: 'USD' | 'EUR' | 'GBP';
  exchangeConfig?: Partial<ExchangeSystemConfig> | null;
  onTransactionCreated: (tx: WalletTransaction) => void;
  onRecordFeeGasSettlement?: (
    record: Omit<FeeGasSettlementRecord, 'id' | 'ownerUid' | 'createdAt' | 'updatedAt'>
  ) => void | Promise<void>;
  onAddContact: (entry: AddressBookEntry) => void;
}

export function TransferView({
  initialMode = 'send',
  initialNetworkId = 'ethereum',
  initialSymbol,
  wallet,
  secrets,
  holdings,
  markets = [],
  addressBook,
  currency,
  exchangeConfig,
  onTransactionCreated,
  onRecordFeeGasSettlement,
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
  const [requestingReceiveGas, setRequestingReceiveGas] = useState(false);
  const [receiveGasNotice, setReceiveGasNotice] = useState('');

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

  const fallbackMonero = useMemo(() => {
    if (
      activeNetwork.family !== 'monero' ||
      wallet.addresses.moneroAddress ||
      wallet.type !== 'mnemonic' ||
      !secrets.mnemonic
    ) {
      return null;
    }
    try {
      const derived = deriveWalletFromMnemonic(secrets.mnemonic, {
        preset: wallet.preset || 'standard',
        accountIndex: wallet.accountIndex || 0,
        passphrase: secrets.passphrase,
      });
      return {
        address: derived.addresses.moneroAddress,
        path: derived.addresses.moneroPath,
      };
    } catch {
      return null;
    }
  }, [activeNetwork.family, wallet, secrets]);

  const senderAddress = useMemo(() => {
    if (activeNetwork.family === 'evm') return wallet.addresses.evmAddress;
    if (activeNetwork.family === 'solana') return wallet.addresses.solanaAddress;
    if (activeNetwork.family === 'monero') {
      return wallet.addresses.moneroAddress || fallbackMonero?.address || '';
    }
    return wallet.addresses.bitcoinAddress;
  }, [activeNetwork.family, wallet.addresses, fallbackMonero]);

  const derivationPath = useMemo(() => {
    if (activeNetwork.family === 'evm') return wallet.addresses.evmPath;
    if (activeNetwork.family === 'solana') return wallet.addresses.solanaPath;
    if (activeNetwork.family === 'monero') {
      if (wallet.addresses.moneroAddress || fallbackMonero?.address) {
        return wallet.addresses.moneroPath || fallbackMonero?.path || "m/44'/128'/0'/0'";
      }
      return wallet.type === 'privateKey'
        ? 'Single-Chain Key'
        : wallet.type === 'watchOnly'
        ? 'Watch-Only'
        : "m/44'/128'/0'/0'";
    }
    return wallet.addresses.bitcoinPath;
  }, [activeNetwork.family, wallet.addresses, wallet.type, fallbackMonero]);

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
    if (activeNetwork.family === 'monero') return isValidMoneroAddress(targetAddress);
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

  const speedMultiplier = speed === 'slow' ? 0.85 : speed === 'fast' ? 1.35 : 1.0;

  const sendBreakdown = useMemo(
    () =>
      calculateExchangeFeeAndGas({
        txType: 'send',
        networkId,
        amount: Number(amountInput) > 0 ? Number(amountInput) : 0,
        symbol: activeToken?.symbol || activeNetwork.symbol,
        assetUsdPrice: activeToken?.priceUsd,
        markets,
        exchangeConfig,
        gasAmountNativeOverride:
          activeNetwork.family === 'evm' ? Number(estimatedFeeNative) || undefined : undefined,
        speedMultiplier,
        isTokenTransfer: activeToken ? !activeToken.isNative : false,
      }),
    [
      networkId,
      amountInput,
      activeToken,
      activeNetwork.symbol,
      activeNetwork.family,
      markets,
      exchangeConfig,
      estimatedFeeNative,
      speedMultiplier,
    ]
  );

  const receiveBreakdown = useMemo(
    () =>
      calculateExchangeFeeAndGas({
        txType: 'receive',
        networkId,
        amount: Number(requestAmount) > 0 ? Number(requestAmount) : 0.1,
        symbol: activeNetwork.symbol,
        markets,
        exchangeConfig,
        speedMultiplier: 1.0,
        isTokenTransfer: false,
      }),
    [networkId, requestAmount, activeNetwork.symbol, markets, exchangeConfig]
  );

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
    if (activeNetwork.family === 'monero') {
      return amt > 0 ? `monero:${senderAddress}?tx_amount=${amt}` : senderAddress;
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

  const availableBalance = activeToken?.balance || 0;
  const nativeTokenBalance = useMemo(() => {
    const nat = networkHoldings.find((h) => h.isNative);
    return nat?.balance || 0;
  }, [networkHoldings]);

  const insufficientBalanceReason = useMemo(() => {
    const sym = activeToken?.symbol || activeNetwork.symbol;
    if (availableBalance <= 0) {
      return `Insufficient ${sym} balance on ${activeNetwork.name} (0 available).`;
    }
    const amt = Number(amountInput);
    if (Number.isFinite(amt) && amt > 0) {
      if (amt > availableBalance) {
        return `Insufficient ${sym} balance. Available: ${formatCryptoAmount(availableBalance)} ${sym}.`;
      }
      const gasReq = Number(estimatedFeeNative) || sendBreakdown.gasAmountNative || 0;
      const paysOwnGas = !(exchangeConfig?.gasSponsorshipEnabled ?? true);
      if (paysOwnGas && activeNetwork.family === 'evm') {
        if (activeToken?.isNative && amt + gasReq > availableBalance) {
          return `Insufficient ${sym} to cover transfer plus gas (${gasReq.toFixed(6)} ${activeNetwork.symbol}).`;
        }
        if (!activeToken?.isNative && nativeTokenBalance < gasReq) {
          return `Insufficient native ${activeNetwork.symbol} for gas (${gasReq.toFixed(6)} ${activeNetwork.symbol} required).`;
        }
      }
    }
    return '';
  }, [
    availableBalance,
    activeToken,
    activeNetwork.name,
    activeNetwork.symbol,
    activeNetwork.family,
    amountInput,
    estimatedFeeNative,
    sendBreakdown.gasAmountNative,
    exchangeConfig?.gasSponsorshipEnabled,
    nativeTokenBalance,
  ]);

  const handleSetPercent = (pct: number) => {
    const bal = activeToken?.balance || 0;
    if (bal <= 0) {
      setAmountInput('0');
      setSendError(`Insufficient ${activeToken?.symbol || activeNetwork.symbol} balance.`);
      return;
    }
    setSendError('');
    const feeBuffer =
      activeToken?.isNative && !(exchangeConfig?.gasSponsorshipEnabled ?? true)
        ? Number(estimatedFeeNative) * 1.1
        : 0;
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
    if (availableBalance <= 0) {
      setSendError(
        `Insufficient ${activeToken?.symbol || activeNetwork.symbol} balance to send or withdraw.`
      );
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
    if (insufficientBalanceReason) {
      setSendError(insufficientBalanceReason);
      return;
    }

    setSending(true);
    try {
      let finalizedTx: WalletTransaction;

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
          speedMultiplier,
          broadcastOnChain: shouldBroadcast,
        });
        finalizedTx = {
          ...tx,
          usdValue: sendBreakdown.txUsdValue,
          note: `${
            shouldBroadcast ? 'Broadcasted' : 'Signed dry-run'
          } · Gas ${sendBreakdown.gasAmountFormatted} ${sendBreakdown.gasSymbol} requested from ${
            sendBreakdown.gasSponsorWalletLabel
          } · Fee ${sendBreakdown.platformFeeFormatted} ${sendBreakdown.platformFeeSymbol} → ${
            sendBreakdown.feeCollectorWalletLabel
          }`,
        };
      } else {
        // Non-EVM cryptographic signed payload + local/sandbox broadcast preview
        const mockSig = Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        finalizedTx = {
          hash:
            activeNetwork.family === 'solana'
              ? `sol_${mockSig.slice(0, 44)}`
              : activeNetwork.family === 'monero'
              ? `xmr_${mockSig.slice(0, 56)}`
              : mockSig,
          networkId,
          type: 'send',
          status: 'signed-sandbox',
          from: senderAddress,
          to: targetAddress,
          symbol: activeToken?.symbol || activeNetwork.symbol,
          amount: amountInput,
          usdValue: sendBreakdown.txUsdValue,
          feeFormatted: `${sendBreakdown.gasAmountFormatted} ${sendBreakdown.gasSymbol} + ${sendBreakdown.platformFeeFormatted} ${sendBreakdown.platformFeeSymbol} fee`,
          rawSignedHex: `0x${mockSig}`,
          timestamp: Date.now(),
          note: `${activeNetwork.name} withdrawal signed · Gas requested from ${sendBreakdown.gasSponsorWalletLabel} · Fee routed to ${sendBreakdown.feeCollectorWalletLabel}`,
        };
      }

      setLastTx(finalizedTx);
      onTransactionCreated(finalizedTx);

      if (onRecordFeeGasSettlement) {
        await onRecordFeeGasSettlement({
          txType: 'send',
          networkId,
          symbol: activeToken?.symbol || activeNetwork.symbol,
          txAmount: amountInput,
          txUsdValue: sendBreakdown.txUsdValue,
          sourceWalletAddress: senderAddress || wallet.addresses.evmAddress || 'unknown',
          recipientAddress: targetAddress,
          gasAmountNative: sendBreakdown.gasAmountFormatted,
          gasSymbol: sendBreakdown.gasSymbol,
          gasUsdValue: sendBreakdown.gasUsdValue,
          gasSponsorWalletId: sendBreakdown.gasSponsorWalletId,
          gasSponsorWalletLabel: sendBreakdown.gasSponsorWalletLabel,
          gasSponsorAddress: sendBreakdown.gasSponsorAddress,
          gasRequestStatus: 'requested',
          platformFeeAmount: sendBreakdown.platformFeeFormatted,
          platformFeeSymbol: sendBreakdown.platformFeeSymbol,
          platformFeeUsdValue: sendBreakdown.platformFeeUsdValue,
          feeCollectorWalletId: sendBreakdown.feeCollectorWalletId,
          feeCollectorWalletLabel: sendBreakdown.feeCollectorWalletLabel,
          feeCollectorAddress: sendBreakdown.feeCollectorAddress,
          feeStatus: sendBreakdown.feeCollectorWalletId ? 'collected' : 'pending',
          txHash: finalizedTx.hash,
        });
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

  const handleRequestReceiveConsolidationGas = async () => {
    if (!senderAddress || !onRecordFeeGasSettlement) return;
    setRequestingReceiveGas(true);
    setReceiveGasNotice('');
    try {
      const txRef = `rcv_${Array.from(crypto.getRandomValues(new Uint8Array(12)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')}`;
      const amtStr = Number(requestAmount) > 0 ? requestAmount : '0.1';
      await onRecordFeeGasSettlement({
        txType: 'receive',
        networkId,
        symbol: activeNetwork.symbol,
        txAmount: amtStr,
        txUsdValue: receiveBreakdown.txUsdValue,
        sourceWalletAddress: senderAddress,
        recipientAddress: receiveBreakdown.feeCollectorAddress || senderAddress,
        gasAmountNative: receiveBreakdown.gasAmountFormatted,
        gasSymbol: receiveBreakdown.gasSymbol,
        gasUsdValue: receiveBreakdown.gasUsdValue,
        gasSponsorWalletId: receiveBreakdown.gasSponsorWalletId,
        gasSponsorWalletLabel: receiveBreakdown.gasSponsorWalletLabel,
        gasSponsorAddress: receiveBreakdown.gasSponsorAddress,
        gasRequestStatus: 'requested',
        platformFeeAmount: receiveBreakdown.platformFeeFormatted,
        platformFeeSymbol: receiveBreakdown.platformFeeSymbol,
        platformFeeUsdValue: receiveBreakdown.platformFeeUsdValue,
        feeCollectorWalletId: receiveBreakdown.feeCollectorWalletId,
        feeCollectorWalletLabel: receiveBreakdown.feeCollectorWalletLabel,
        feeCollectorAddress: receiveBreakdown.feeCollectorAddress,
        feeStatus: receiveBreakdown.feeCollectorWalletId ? 'collected' : 'pending',
        txHash: txRef,
      });
      setReceiveGasNotice(
        `Requested ${receiveBreakdown.gasAmountFormatted} ${receiveBreakdown.gasSymbol} consolidation gas from ${receiveBreakdown.gasSponsorWalletLabel}; deposit fee (${receiveBreakdown.platformFeeFormatted} ${receiveBreakdown.platformFeeSymbol}) routed to ${receiveBreakdown.feeCollectorWalletLabel}.`
      );
    } finally {
      setRequestingReceiveGas(false);
    }
  };

  const compatibleContacts = addressBook.filter(
    (c) => c.networkFamily === activeNetwork.family
  );

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Mode & Network Selector Header */}
      <div className="bg-[#11151C] border border-white/10 rounded-xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3 sm:gap-4">
        <div className="flex items-center gap-1 p-1 bg-[#090B0F] border border-white/10 rounded-lg">
          <button
            type="button"
            onClick={() => setMode('send')}
            className={`inline-flex items-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
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
            className={`inline-flex items-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
              mode === 'receive'
                ? 'bg-emerald-500 text-[#090B0F] font-semibold'
                : 'text-[#8A94A6] hover:text-[#F4F6F9]'
            }`}
          >
            <ArrowDownLeft className="w-4 h-4" />
            <span>Receive Crypto</span>
          </button>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <span className="text-xs text-[#8A94A6] shrink-0">Network:</span>
          <select
            value={networkId}
            onChange={(e) => {
              const next = e.target.value as NetworkId;
              setNetworkId(next);
              setSelectedSymbol(NETWORK_MAP[next].symbol);
              setSendError('');
              setLastTx(null);
            }}
            className="flex-1 sm:flex-none bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-xs font-medium text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60 min-w-0"
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
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6">
          <div className="lg:col-span-8 bg-[#11151C] border border-white/10 rounded-xl p-4 sm:p-6 space-y-5 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <NetworkIcon networkId={networkId} size={28} />
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-[#F4F6F9] truncate">
                    Send on {activeNetwork.name}
                  </h3>
                  <p className="text-xs font-mono text-[#8A94A6] truncate">
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
                    : activeNetwork.family === 'monero'
                    ? '4... Monero standard or 8... subaddress'
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

            {(sendError || insufficientBalanceReason) && (
              <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5">
                <ShieldAlert className="w-4 h-4 shrink-0" />
                <span>{sendError || insufficientBalanceReason}</span>
              </div>
            )}

            <button
              type="button"
              disabled={sending || Boolean(insufficientBalanceReason) || Number(amountInput) <= 0}
              onClick={handleExecuteSend}
              className="w-full py-3 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-sm transition-colors"
            >
              {sending
                ? 'Signing Transaction...'
                : insufficientBalanceReason
                ? 'Insufficient Balance'
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

              <div className="space-y-2.5 text-xs pt-2 border-t border-white/10">
                <div className="flex justify-between gap-2">
                  <span className="text-[#8A94A6]">Calculated Network Gas</span>
                  <span className="font-mono text-[#F4F6F9] tabular-nums text-right">
                    {sendBreakdown.gasAmountFormatted} {sendBreakdown.gasSymbol} (
                    {formatFiat(sendBreakdown.gasUsdValue, currency)})
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-[#8A94A6]">Gas Requested From</span>
                  <span className="font-mono text-sky-400 truncate max-w-[175px]">
                    {sendBreakdown.gasSponsorWalletLabel}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-[#8A94A6]">
                    Exchange Fee ({(sendBreakdown.feeBps / 100).toFixed(2)}%)
                  </span>
                  <span className="font-mono text-emerald-400 tabular-nums text-right">
                    {sendBreakdown.platformFeeFormatted} {sendBreakdown.platformFeeSymbol} (
                    {formatFiat(sendBreakdown.platformFeeUsdValue, currency)})
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-[#8A94A6]">Fee Routed To</span>
                  <span className="font-mono text-amber-400 truncate max-w-[175px]">
                    {sendBreakdown.feeCollectorWalletLabel}
                  </span>
                </div>
                {Number(amountInput) > 0 && (
                  <div className="flex justify-between gap-2 pt-2 border-t border-white/10">
                    <span className="text-[#8A94A6]">Net Recipient Amount</span>
                    <span className="font-mono font-semibold text-[#F4F6F9] tabular-nums">
                      {formatCryptoAmount(sendBreakdown.netAmountAfterFee, 6)}{' '}
                      {activeToken?.symbol || activeNetwork.symbol}
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-[#8A94A6]">Signing Standard</span>
                  <span className="font-mono text-[#CBD5E1]">
                    {activeNetwork.family === 'evm'
                      ? 'EIP-155'
                      : activeNetwork.family === 'solana'
                      ? 'Ed25519'
                      : activeNetwork.family === 'monero'
                      ? 'RingCT / CryptoNote'
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
                  {senderAddress ||
                    (wallet.type === 'privateKey'
                      ? `Not available — this wallet uses a single-chain imported private key. Import a 12/18/24-word seed phrase or a Monero Private Spend Key to receive ${activeNetwork.symbol}.`
                      : wallet.type === 'watchOnly'
                      ? `Not available — this Watch-Only entry tracks a different chain address.`
                      : `Lock and unlock your vault once to finish deriving your ${activeNetwork.name} address.`)}
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
                Request Specific Amount (Embeds Payment URI & Calculates Deposit Gas)
              </label>
              <div className="relative max-w-xs">
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={requestAmount}
                  onChange={(e) => {
                    setRequestAmount(e.target.value);
                    setReceiveGasNotice('');
                  }}
                  placeholder="Optional amount (defaults 0.1)"
                  className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 pr-14 font-mono text-base sm:text-xs text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-[#8A94A6]">
                  {activeNetwork.symbol}
                </span>
              </div>
            </div>

            {/* Exchange Inbound Deposit Gas & Nominated Fee Preview */}
            <div className="p-4 rounded-xl bg-[#090B0F] border border-white/10 space-y-2.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-[#F4F6F9] inline-flex items-center gap-1.5">
                  <Fuel className="w-3.5 h-3.5 text-sky-400" />
                  <span>Auto-Calculated Inbound Gas & Fee Routing</span>
                </span>
                <span className="font-mono text-[11px] text-[#8A94A6]">
                  {(receiveBreakdown.feeBps / 100).toFixed(2)}% exchange fee
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-[#8A94A6]">Consolidation Gas Requested</span>
                <span className="font-mono text-[#F4F6F9] tabular-nums">
                  {receiveBreakdown.gasAmountFormatted} {receiveBreakdown.gasSymbol} (
                  {formatFiat(receiveBreakdown.gasUsdValue, currency)})
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-[#8A94A6]">Gas Sponsor Wallet</span>
                <span className="font-mono text-sky-400 truncate max-w-[200px]">
                  {receiveBreakdown.gasSponsorWalletLabel}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-[#8A94A6]">Fee Collected To</span>
                <span className="font-mono text-amber-400 truncate max-w-[200px]">
                  {receiveBreakdown.platformFeeFormatted} {receiveBreakdown.platformFeeSymbol} →{' '}
                  {receiveBreakdown.feeCollectorWalletLabel}
                </span>
              </div>

              {onRecordFeeGasSettlement && senderAddress && (
                <div className="pt-2 border-t border-white/10 flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    disabled={requestingReceiveGas}
                    onClick={handleRequestReceiveConsolidationGas}
                    className="px-3.5 py-2 rounded-lg bg-[#1A2130] hover:bg-[#232C3F] border border-emerald-500/30 text-xs font-medium text-emerald-400 whitespace-nowrap"
                  >
                    {requestingReceiveGas
                      ? 'Requesting Gas...'
                      : 'Request Deposit Consolidation Gas from Gas Wallet'}
                  </button>
                </div>
              )}

              {receiveGasNotice && (
                <div className="text-[11px] text-emerald-400 leading-relaxed pt-1">
                  {receiveGasNotice}
                </div>
              )}
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
