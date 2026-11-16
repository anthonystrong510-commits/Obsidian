import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Bell,
  KeyRound,
  Link2,
  Lock,
  ShieldCheck,
  Smartphone,
  Wallet,
} from 'lucide-react';
import { NETWORKS } from '../lib/networks';
import { formatFiat, formatPercent } from '../lib/formatters';
import { NetworkIcon, TokenAvatar } from './NetworkIcon';
import { ObsidianLogo } from './ObsidianLogo';
import type { MarketCoin } from '../types/wallet';

interface LandingPageProps {
  markets: MarketCoin[];
  onOpenAuth: (mode: 'signin' | 'signup') => void;
}

type EcosystemFilter = 'all' | 'evm' | 'non-evm';

export function LandingPage({ markets, onOpenAuth }: LandingPageProps) {
  const [heroImgFailed, setHeroImgFailed] = useState(false);
  const [enclaveImgFailed, setEnclaveImgFailed] = useState(false);
  const [networkFilter, setNetworkFilter] = useState<EcosystemFilter>('all');

  const featuredMarkets = markets.slice(0, 8);

  const visibleNetworks = useMemo(() => {
    if (networkFilter === 'all') return NETWORKS;
    if (networkFilter === 'evm') return NETWORKS.filter((n) => n.family === 'evm');
    return NETWORKS.filter((n) => n.family !== 'evm');
  }, [networkFilter]);

  return (
    <div className="min-h-screen bg-[#090B0F] text-[#F4F6F9] flex flex-col">
      {/* Strict 3-Zone Top Navigation Bar */}
      <header className="sticky top-0 z-30 bg-[#090B0F]/92 backdrop-blur-md border-b border-white/10">
        <div className="max-w-[1280px] mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <a
            href="#top"
            className="flex items-center gap-2.5 font-display text-lg font-bold tracking-tight text-[#F4F6F9] whitespace-nowrap shrink-0"
          >
            <ObsidianLogo size={28} />
            <span>Obsidian Vault</span>
          </a>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-[#8A94A6]">
            <a
              href="#networks"
              className="hover:text-[#F4F6F9] hover:underline underline-offset-8 decoration-emerald-400 transition-colors whitespace-nowrap shrink-0"
            >
              Networks
            </a>
            <a
              href="#capabilities"
              className="hover:text-[#F4F6F9] hover:underline underline-offset-8 decoration-emerald-400 transition-colors whitespace-nowrap shrink-0"
            >
              Capabilities
            </a>
            <a
              href="#security"
              className="hover:text-[#F4F6F9] hover:underline underline-offset-8 decoration-emerald-400 transition-colors whitespace-nowrap shrink-0"
            >
              Security
            </a>
            <a
              href="#markets"
              className="hover:text-[#F4F6F9] hover:underline underline-offset-8 decoration-emerald-400 transition-colors whitespace-nowrap shrink-0"
            >
              Markets
            </a>
          </nav>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => onOpenAuth('signin')}
              className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] font-semibold text-xs transition-colors whitespace-nowrap shrink-0"
            >
              Open Wallet
            </button>
          </div>
        </div>
      </header>

      <main id="top" className="flex-1">
        {/* Hero Split Section */}
        <section className="max-w-[1280px] mx-auto px-6 pt-12 pb-12 lg:pt-16 lg:pb-16 space-y-10">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-stretch">
            <div className="lg:col-span-6 flex flex-col justify-between space-y-8 py-1">
              <div className="space-y-5">
                <p className="text-xs font-mono text-emerald-400 tracking-wide">
                  Self-Custody Multi-Chain Web3 Wallet
                </p>
                <h1 className="font-display font-bold tracking-tight text-[#F4F6F9] text-balance leading-[1.06] text-[clamp(2.25rem,4vw,3.75rem)]">
                  One cryptographic vault for every network you hold.
                </h1>
                <p className="text-base text-[#94A3B8] leading-relaxed max-w-[60ch]">
                  Create batch HD wallets or import 12, 18, and 24-word recovery phrases with live on-chain balance scanning before setup. Send, receive, swap, sweep mobile or browser wallets, and manage Monero (XMR) keys behind local AES-256-GCM encryption.
                </p>
              </div>

              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-4">
                  <button
                    type="button"
                    onClick={() => onOpenAuth('signup')}
                    className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] font-semibold text-sm transition-colors whitespace-nowrap"
                  >
                    <span>Create Vault Account</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenAuth('signin')}
                    className="px-4 py-3 text-sm font-medium text-[#CBD5E1] hover:text-[#F4F6F9] underline-offset-4 hover:underline transition-colors whitespace-nowrap"
                  >
                    Sign in to existing vault
                  </button>
                </div>
                <p className="text-xs text-[#64748B]">
                  Supports MetaMask, Phantom, Trust Wallet, Ledger, Coinbase Wallet, and Cake Wallet imports
                </p>
              </div>
            </div>

            <div className="lg:col-span-6">
              <div className="relative h-72 sm:h-88 lg:h-full min-h-[340px] rounded-xl overflow-hidden border border-white/10 bg-[#11151C]">
                {!heroImgFailed ? (
                  <img
                    src="/src/assets/images/landing_hero_vault_1794858384339.jpg"
                    alt="Obsidian Vault milled titanium and volcanic obsidian cold-storage hardware unit"
                    referrerPolicy="no-referrer"
                    onError={() => setHeroImgFailed(true)}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-[#11151C] via-[#0D1419] to-[#090B0F] flex flex-col items-center justify-center gap-3 p-6">
                    <ShieldCheck className="w-10 h-10 text-emerald-400" />
                    <span className="text-sm font-semibold text-[#F4F6F9]">
                      Obsidian Cryptographic Vault
                    </span>
                  </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-[#090B0F] via-[#090B0F]/25 to-transparent" />
                <div className="absolute bottom-5 left-5 right-5 flex flex-wrap items-center justify-between gap-2 text-xs text-[#CBD5E1]">
                  <span className="font-medium text-[#F4F6F9]">
                    BIP-39 · BIP-44 · SLIP-0010 · CryptoNote
                  </span>
                  <span className="font-mono text-emerald-400">Client-Side Key Encryption</span>
                </div>
              </div>
            </div>
          </div>

          {/* 4-Column Quantified Metric Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 border border-white/10 rounded-xl bg-[#11151C] divide-y lg:divide-y-0 lg:divide-x divide-white/10">
            <div className="p-5">
              <div className="font-mono text-2xl font-semibold text-[#F4F6F9] tabular-nums">
                11 Networks
              </div>
              <div className="text-xs text-[#8A94A6] mt-1">
                EVM rollups, Solana, Bitcoin & Monero XMR
              </div>
            </div>
            <div className="p-5">
              <div className="font-mono text-2xl font-semibold text-[#F4F6F9] tabular-nums">
                12 / 18 / 24
              </div>
              <div className="text-xs text-[#8A94A6] mt-1">
                Seed word lengths plus raw private keys
              </div>
            </div>
            <div className="p-5">
              <div className="font-mono text-2xl font-semibold text-emerald-400 tabular-nums">
                AES-256-GCM
              </div>
              <div className="text-xs text-[#8A94A6] mt-1">
                100k PBKDF2 iterations before vault storage
              </div>
            </div>
            <div className="p-5">
              <div className="font-mono text-2xl font-semibold text-[#F4F6F9] tabular-nums">
                Multi-Sweep
              </div>
              <div className="text-xs text-[#8A94A6] mt-1">
                Concurrent desktop & mobile WalletConnect
              </div>
            </div>
          </div>
        </section>

        {/* Supported Networks Band with Interactive Filter */}
        <section id="networks" className="border-t border-white/10 bg-[#0D1017]">
          <div className="max-w-[1280px] mx-auto px-6 py-16 space-y-8">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-2xl font-display font-bold text-[#F4F6F9]">
                  Unified Multi-Chain Settlement
                </h2>
                <p className="text-sm text-[#8A94A6] mt-1">
                  Every phrase deterministically derives native accounts across EVM chains, Solana, Bitcoin SegWit, and Monero.
                </p>
              </div>

              <div className="flex items-center gap-1 p-1 bg-[#11151C] border border-white/10 rounded-lg">
                {(
                  [
                    { id: 'all', label: `All (${NETWORKS.length})` },
                    { id: 'evm', label: 'EVM & L2s' },
                    { id: 'non-evm', label: 'BTC · SOL · XMR' },
                  ] as Array<{ id: EcosystemFilter; label: string }>
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setNetworkFilter(item.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      networkFilter === item.id
                        ? 'bg-[#1D2432] text-[#F4F6F9]'
                        : 'text-[#8A94A6] hover:text-[#F4F6F9]'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {visibleNetworks.map((net) => (
                <div
                  key={net.id}
                  className="p-3.5 rounded-xl bg-[#11151C] border border-white/10 flex items-center gap-3"
                >
                  <NetworkIcon networkId={net.id} size={28} />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-[#F4F6F9] truncate">{net.name}</div>
                    <div className="text-[11px] font-mono text-[#64748B] truncate">{net.symbol}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Capabilities Asymmetric Bento Grid */}
        <section id="capabilities" className="max-w-[1280px] mx-auto px-6 py-16 space-y-8">
          <div className="max-w-2xl space-y-2">
            <h2 className="text-2xl sm:text-3xl font-display font-bold text-[#F4F6F9] text-balance">
              Engineered for multi-wallet control, fast recovery, and cross-chain execution.
            </h2>
            <p className="text-sm text-[#8A94A6]">
              Inspect assets prior to password setup, switch between multiple vaults in one click, and consolidate external wallets.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Marquee Capability Card */}
            <div className="lg:col-span-7 bg-[#11151C] border border-white/10 rounded-xl p-7 flex flex-col justify-between space-y-6">
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-xs font-mono text-emerald-400">
                  <Wallet className="w-4 h-4" />
                  <span>01. Multi-Wallet Creation & Assets-First Import</span>
                </div>
                <h3 className="text-xl font-semibold text-[#F4F6F9]">
                  Preview on-chain assets before setting your Vault Password
                </h3>
                <p className="text-sm text-[#94A3B8] leading-relaxed">
                  Import 12, 18, or 24-word BIP-39 phrases or batch-create up to 5 HD wallets at once. Obsidian Vault scans live EVM, Solana, Bitcoin, and Monero addresses immediately so you verify every holding first, then encrypt with your chosen password.
                </p>
              </div>
              <div className="pt-4 border-t border-white/10 grid grid-cols-3 gap-4 text-xs">
                <div>
                  <div className="font-mono font-semibold text-[#F4F6F9]">Batch HD Vaults</div>
                  <div className="text-[#64748B] mt-0.5">Instant header switching</div>
                </div>
                <div>
                  <div className="font-mono font-semibold text-[#FF6600]">Monero XMR</div>
                  <div className="text-[#64748B] mt-0.5">Spend & view key support</div>
                </div>
                <div>
                  <div className="font-mono font-semibold text-[#F4F6F9]">Watch / ENS</div>
                  <div className="text-[#64748B] mt-0.5">Read-only address tracker</div>
                </div>
              </div>
            </div>

            {/* Secondary Card */}
            <div className="lg:col-span-5 bg-[#11151C] border border-white/10 rounded-xl p-7 flex flex-col justify-between space-y-5">
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-xs font-mono text-emerald-400">
                  <Link2 className="w-4 h-4" />
                  <span>02. Multi-Wallet & Mobile Sweep</span>
                </div>
                <h3 className="text-xl font-semibold text-[#F4F6F9]">
                  Connect desktop extensions and mobile wallet apps simultaneously
                </h3>
                <p className="text-sm text-[#94A3B8] leading-relaxed">
                  Link multiple MetaMask, Phantom, Trust, Rainbow, or Coinbase accounts simultaneously via EIP-6963, QR handoff, or mobile deep links, then sweep selected balances directly into your Obsidian Vault.
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs text-[#CBD5E1] pt-3 border-t border-white/10">
                <Smartphone className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>Persistent session tokens across mobile wallet redirects</span>
              </div>
            </div>

            {/* Bottom Row Cards */}
            <div className="lg:col-span-5 bg-[#11151C] border border-white/10 rounded-xl p-7 space-y-3">
              <div className="flex items-center gap-2 text-xs font-mono text-emerald-400">
                <KeyRound className="w-4 h-4" />
                <span>03. Dual Recovery & Key Export</span>
              </div>
              <h3 className="text-lg font-semibold text-[#F4F6F9]">
                Recover with your Seed Phrase or verified Account Auth
              </h3>
              <p className="text-sm text-[#94A3B8] leading-relaxed">
                Restore locked vaults anytime using your 12/18/24 recovery phrase or Google / email re-authentication, inspect individual EVM, Solana, BTC, and Monero private keys on demand, and export encrypted UTC keystores.
              </p>
            </div>

            <div className="lg:col-span-7 bg-[#11151C] border border-white/10 rounded-xl p-7 space-y-3">
              <div className="flex items-center gap-2 text-xs font-mono text-emerald-400">
                <Bell className="w-4 h-4" />
                <span>04. Real-Time Price Alerts & Cross-Token Swap</span>
              </div>
              <h3 className="text-lg font-semibold text-[#F4F6F9]">
                Live streaming market ticks, threshold triggers, and routing engine
              </h3>
              <p className="text-sm text-[#94A3B8] leading-relaxed">
                Track 7-day sparklines, execute slippage-protected swaps across major tokens, and arm persistent price or 24-hour volatility alerts with audio chimes and desktop notifications synced across sessions.
              </p>
            </div>
          </div>
        </section>

        {/* Security Architecture Section */}
        <section id="security" className="border-t border-white/10 bg-[#0D1017]">
          <div className="max-w-[1280px] mx-auto px-6 py-16 grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
            <div className="lg:col-span-5">
              <div className="relative aspect-[4/3] rounded-xl overflow-hidden border border-white/10 bg-[#11151C]">
                {!enclaveImgFailed ? (
                  <img
                    src="/src/assets/images/landing_security_enclave_1794858385245.jpg"
                    alt="Obsidian cryptographic security enclave module"
                    referrerPolicy="no-referrer"
                    onError={() => setEnclaveImgFailed(true)}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-[#11151C] to-[#090B0F] flex items-center justify-center">
                    <Lock className="w-10 h-10 text-emerald-400" />
                  </div>
                )}
              </div>
            </div>

            <div className="lg:col-span-7 space-y-6">
              <div className="space-y-2">
                <p className="text-xs font-mono text-emerald-400">Client-Side Security Architecture</p>
                <h2 className="text-2xl sm:text-3xl font-display font-bold text-[#F4F6F9] text-balance">
                  Plaintext private keys never leave your browser environment.
                </h2>
              </div>

              <div className="divide-y divide-white/10 border-t border-b border-white/10">
                <div className="py-4">
                  <div className="text-sm font-semibold text-[#F4F6F9]">
                    PBKDF2-SHA256 + AES-256-GCM Ciphertext Wrapping
                  </div>
                  <p className="text-xs text-[#8A94A6] mt-1">
                    Every seed phrase and chain private key is encrypted client-side with unique random salts and IVs before hitting local storage or verified user cloud backup.
                  </p>
                </div>
                <div className="py-4">
                  <div className="text-sm font-semibold text-[#F4F6F9]">
                    UID-Scoped Session Persistence & Resilient Unlock
                  </div>
                  <p className="text-xs text-[#8A94A6] mt-1">
                    Accounts and connected WalletConnect sessions remain isolated per verified identity with automatic session continuity across refreshes and mobile deep-link flows.
                  </p>
                </div>
                <div className="py-4">
                  <div className="text-sm font-semibold text-[#F4F6F9]">
                    Direct On-Chain RPC & Explorer Verification
                  </div>
                  <p className="text-xs text-[#8A94A6] mt-1">
                    Portfolio balances, ENS resolution, Bitcoin Mempool UTXOs, Solana signatures, and Monero node telemetry query live public infrastructure without exposing keys.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Live Market Snapshot */}
        <section id="markets" className="max-w-[1280px] mx-auto px-6 py-16 space-y-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-display font-bold text-[#F4F6F9]">Live Asset Markets</h2>
              <p className="text-sm text-[#8A94A6] mt-1">
                Real-time market pricing powering portfolio valuation and automated price alert triggers.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onOpenAuth('signup')}
              className="text-xs font-medium text-emerald-400 hover:text-emerald-300 whitespace-nowrap"
            >
              Launch portfolio & alerts →
            </button>
          </div>

          <div className="bg-[#11151C] border border-white/10 rounded-xl overflow-hidden">
            {featuredMarkets.length === 0 ? (
              <div className="p-8 text-center text-xs text-[#8A94A6]">
                Loading live market feed...
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/10 text-xs text-[#8A94A6]">
                      <th className="py-3.5 px-6 font-medium">Asset</th>
                      <th className="py-3.5 px-4 font-medium text-right">Price (USD)</th>
                      <th className="py-3.5 px-6 font-medium text-right">24h Change</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06] text-sm">
                    {featuredMarkets.map((coin) => {
                      const pos = coin.price_change_percentage_24h >= 0;
                      return (
                        <tr key={coin.id} className="h-12 hover:bg-white/[0.02]">
                          <td className="py-2.5 px-6">
                            <div className="flex items-center gap-3">
                              <TokenAvatar symbol={coin.symbol} size={28} />
                              <div className="flex items-baseline gap-2">
                                <span className="font-semibold text-[#F4F6F9]">{coin.name}</span>
                                <span className="font-mono text-xs text-[#64748B]">
                                  {coin.symbol}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[#F4F6F9]">
                            {formatFiat(coin.current_price, 'USD')}
                          </td>
                          <td
                            className={`py-2.5 px-6 text-right font-mono tabular-nums ${
                              pos ? 'text-emerald-400' : 'text-red-400'
                            }`}
                          >
                            {formatPercent(coin.price_change_percentage_24h)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {/* Conversion CTA Band */}
        <section className="border-t border-white/10 bg-[#0D1017]">
          <div className="max-w-[1280px] mx-auto px-6 py-14 flex flex-wrap items-center justify-between gap-6">
            <div className="space-y-1.5 max-w-xl">
              <h2 className="text-2xl font-display font-bold text-[#F4F6F9]">
                Initialize your self-custody vault in under a minute.
              </h2>
              <p className="text-sm text-[#8A94A6]">
                Generate new multi-chain wallets or import existing 12, 18, and 24-word phrases with verified cloud backup.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => onOpenAuth('signup')}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] font-semibold text-sm transition-colors whitespace-nowrap"
              >
                <span>Create New Vault</span>
                <ArrowRight className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => onOpenAuth('signin')}
                className="px-4 py-2.5 rounded-lg bg-[#11151C] border border-white/15 hover:border-white/30 text-sm font-medium text-[#F4F6F9] transition-colors whitespace-nowrap"
              >
                Sign In
              </button>
            </div>
          </div>
        </section>
      </main>

      {/* Multi-Column Quiet Footer */}
      <footer className="border-t border-white/10 bg-[#090B0F]">
        <div className="max-w-[1280px] mx-auto px-6 py-12 space-y-10">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-8">
            <div className="md:col-span-5 space-y-3">
              <a href="#top" className="inline-flex items-center gap-2.5">
                <ObsidianLogo size={30} />
                <span className="font-display font-bold text-base text-[#F4F6F9]">
                  Obsidian Vault
                </span>
              </a>
              <p className="text-xs text-[#8A94A6] leading-relaxed max-w-sm">
                Non-custodial Web3 multi-chain wallet supporting BIP-39 phrase imports, Monero (XMR) derivation, batch HD account creation, WalletConnect sweep, and real-time portfolio telemetry.
              </p>
            </div>

            <div className="md:col-span-2 space-y-2.5 text-xs">
              <div className="font-semibold text-[#F4F6F9]">Platform</div>
              <ul className="space-y-2 text-[#8A94A6]">
                <li>
                  <a href="#networks" className="hover:text-[#F4F6F9]">
                    Supported Networks
                  </a>
                </li>
                <li>
                  <a href="#capabilities" className="hover:text-[#F4F6F9]">
                    Wallet Studio
                  </a>
                </li>
                <li>
                  <a href="#security" className="hover:text-[#F4F6F9]">
                    Encryption Model
                  </a>
                </li>
                <li>
                  <a href="#markets" className="hover:text-[#F4F6F9]">
                    Live Markets
                  </a>
                </li>
              </ul>
            </div>

            <div className="md:col-span-3 space-y-2.5 text-xs">
              <div className="font-semibold text-[#F4F6F9]">Standards & Custody</div>
              <ul className="space-y-2 text-[#8A94A6]">
                <li>BIP-39 12 / 18 / 24-Word Phrases</li>
                <li>BIP-44 · SLIP-0010 · BIP-84 SegWit</li>
                <li>CryptoNote Monero Spend & View Keys</li>
                <li>Client-Side AES-256-GCM Wrapping</li>
              </ul>
            </div>

            <div className="md:col-span-2 space-y-2.5 text-xs">
              <div className="font-semibold text-[#F4F6F9]">Access Vault</div>
              <div className="flex flex-col items-start gap-2">
                <button
                  type="button"
                  onClick={() => onOpenAuth('signup')}
                  className="text-emerald-400 hover:text-emerald-300 font-medium"
                >
                  Create Account
                </button>
                <button
                  type="button"
                  onClick={() => onOpenAuth('signin')}
                  className="text-[#8A94A6] hover:text-[#F4F6F9]"
                >
                  Sign In to Vault
                </button>
              </div>
            </div>
          </div>

          <div className="pt-6 border-t border-white/10 flex flex-wrap items-center justify-between gap-4 text-xs text-[#64748B]">
            <span>© {new Date().getFullYear()} Obsidian Vault. Self-custody multi-chain software.</span>
            <span>Keys remain encrypted client-side at all times.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
