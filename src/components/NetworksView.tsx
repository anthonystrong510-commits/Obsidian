import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { NETWORKS } from '../lib/networks';
import { shortenAddress } from '../lib/crypto';
import { fetchNetworkTelemetries } from '../lib/web3Service';
import { NetworkIcon } from './NetworkIcon';
import type { NetworkId, NetworkTelemetry, WalletAccount } from '../types/wallet';

interface NetworksViewProps {
  wallet: WalletAccount;
  onNavigateTransfer: (networkId: NetworkId, mode: 'send' | 'receive') => void;
}

export function NetworksView({ wallet, onNavigateTransfer }: NetworksViewProps) {
  const [telemetries, setTelemetries] = useState<Record<string, NetworkTelemetry>>({});
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadTelemetries = async () => {
    setLoading(true);
    try {
      const list = await fetchNetworkTelemetries();
      setTelemetries(Object.fromEntries(list.map((t) => [t.networkId, t])));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTelemetries();
  }, []);

  const getAddressForFamily = (family: string) => {
    if (family === 'evm') return wallet.addresses.evmAddress;
    if (family === 'solana') return wallet.addresses.solanaAddress;
    if (family === 'monero') return wallet.addresses.moneroAddress || '';
    return wallet.addresses.bitcoinAddress;
  };

  const handleCopy = async (id: string, addr: string) => {
    if (!addr) return;
    await navigator.clipboard.writeText(addr);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1600);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-[#F4F6F9]">
            Connected Multi-Chain Networks
          </h2>
          <p className="text-xs text-[#8A94A6] mt-0.5">
            Live RPC block height, gas fee tracker, and derived deposit addresses across all chains
          </p>
        </div>

        <button
          type="button"
          onClick={loadTelemetries}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-[#11151C] border border-white/10 hover:border-white/20 text-xs text-[#CBD5E1]"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>{loading ? 'Probing RPCs...' : 'Probe Network RPCs'}</span>
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {NETWORKS.map((net) => {
          const tel = telemetries[net.id];
          const address = getAddressForFamily(net.family);
          return (
            <div
              key={net.id}
              className="bg-[#11151C] border border-white/10 rounded-xl p-5 flex flex-col justify-between gap-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <NetworkIcon networkId={net.id} size={34} />
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-[#F4F6F9]">{net.name}</h3>
                      {net.isTestnet && (
                        <span className="text-[11px] font-mono text-amber-400">
                          Testnet
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-[#8A94A6] font-mono mt-0.5">
                      {net.chainId ? `Chain ID ${net.chainId}` : net.family.toUpperCase()} ·{' '}
                      {net.symbol}
                    </p>
                  </div>
                </div>

                <div className="text-right text-[11px] font-mono tabular-nums">
                  <div className={tel?.healthy ? 'text-emerald-400' : 'text-[#8A94A6]'}>
                    {tel?.healthy ? 'RPC Online' : loading ? 'Checking...' : 'Standby'}
                  </div>
                  {tel?.blockHeight && (
                    <div className="text-[#64748B] mt-0.5">
                      #{tel.blockHeight.toLocaleString()}
                    </div>
                  )}
                </div>
              </div>

              <div className="p-3 rounded-lg bg-[#090B0F] border border-white/10 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[10px] text-[#64748B]">Derived Address</div>
                  <div className="font-mono text-xs text-[#F4F6F9] truncate">
                    {address ? shortenAddress(address, 12, 10) : 'Not derived for this key'}
                  </div>
                </div>
                {address && (
                  <button
                    type="button"
                    onClick={() => handleCopy(net.id, address)}
                    className="p-1.5 rounded bg-[#11151C] border border-white/10 text-[#8A94A6] hover:text-[#F4F6F9] shrink-0"
                    aria-label={`Copy ${net.name} address`}
                  >
                    {copiedId === net.id ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 text-xs pt-1">
                <span className="font-mono text-[11px] text-[#8A94A6] tabular-nums">
                  {tel?.gasGwei !== null && tel?.gasGwei !== undefined
                    ? `Fee: ${tel.gasGwei} ${
                        net.family === 'solana'
                          ? 'SOL'
                          : net.family === 'monero'
                          ? 'XMR'
                          : 'Gwei'
                      }`
                    : 'Fee: Live Mempool'}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onNavigateTransfer(net.id, 'receive')}
                    className="px-2.5 py-1 rounded bg-[#090B0F] border border-white/10 hover:border-white/20 text-[#CBD5E1]"
                  >
                    Receive
                  </button>
                  <button
                    type="button"
                    onClick={() => onNavigateTransfer(net.id, 'send')}
                    className="px-2.5 py-1 rounded bg-[#090B0F] border border-white/10 hover:border-emerald-500/40 text-[#CBD5E1]"
                  >
                    Send
                  </button>
                  {address && (
                    <a
                      href={
                        net.family === 'monero'
                          ? net.explorerUrl
                          : `${net.explorerUrl}/address/${address}`
                      }
                      target="_blank"
                      rel="noreferrer"
                      className="p-1.5 rounded bg-[#090B0F] border border-white/10 text-[#8A94A6] hover:text-[#F4F6F9]"
                      aria-label={`Open ${net.name} explorer`}
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
