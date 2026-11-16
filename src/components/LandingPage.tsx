import { useState } from 'react';
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
import type { MarketCoin } from '../types/wallet';

interface LandingPageProps {
  markets: MarketCoin[];
  onOpenAuth: (mode: 'signin' | 'signup') => void;
}

export function LandingPage({ markets, onOpenAuth }: LandingPageProps) {
  const [heroImgFailed, setHeroImgFailed] = useState(false);
  const [chipImgFailed, setChipImgFailed] = useState(false);

  const featuredMarkets = markets.slice(0, 8);

  return (
    <div className="min-h-screen bg-[#090B0F] text-[#F4F6F9] flex flex-col">
      {/* Strict 3-Zone Top Bar */}
      <header className="sticky top-0 z-30 bg-[#090B0F]/90 backdrop-blur-md border-b border-white/10">
        <div className="max-w-[1280px] mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <a
            href="#top"
            className="font-display text-lg font-bold tracking-tight text-[#F4F6F9] whitespace-nowrap shrink-0"
          >
            Obsidian Vault
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
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-stretch">
            <div className="lg:col-span-6 flex flex-col justify-between space-y-8 py-2">
              <div className="space-y-5">
                <p className="text-xs font-mono text-emerald-400 tracking-wide">
                  Non-Custodial Multi-Chain Web3 Custody
                </p>
                <h1 className="font-display font-bold tracking-tight text-[#F4F6F9] text-balance leading-[1.08] text-[clamp(2.25rem,4vw,3.5rem)]">
                  One cryptographic vault for every chain you hold.
                </h1>
                <p className="text-base text-[#94A3B8] leading-relaxed max-w-[60ch]">
                  Create or import 12, 18, and 24-word seed phrases, recover raw private keys including Monero (XMR), sweep connected mobile or browser wallets in batch, and track live on-chain portfolios with client-side AES-256-GCM encryption.
                </p>
              </div>

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
            </div>

            <div className="lg:col-span-6">
              <div className="relative h-72 sm:h-88 lg:h-full min-h-[320px] rounded-xl overflow-hidden border border-white/10 bg-[#11151C]">
                {!heroImgFailed ? (
                  <img
                    src="/src/assets/images/landing_obsidian_hero_1794857051167.jpg"
                    alt="Brushed titanium Obsidian Vault hardware cold storage monolith"
                    referrerPolicy="no-referrer"
                    onError={() => setHeroImgFailed(true)}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-[#11151C] via-[#0D1419] to-[#090B0F] flex flex-col items-center justify-center gap-3 p-6">
                    <ShieldCheck className="w-10 h-10 text-emerald-400" />
                    <span className="text-sm font-semibold text-[#F4F6F9]">Obsidian Cryptographic Vault</span>
                  </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-[#090B0F] via-[#090B0F]/20 to-transparent" />
                <div className="absolute bottom-5 left-5 right-5 flex flex-wrap items-center justify-between gap-2 text-xs text-[#CBD5E1]">
                  <span className="font-medium text-[#F4F6F9]">BIP-39 / BIP-44 / SLIP-0010 / CryptoNote</span>
                  <span className="font-mono text-emerald-400">Zero-Trust Local Signing</span>
                </div>
              </div>
            </div>
          </div>

          {/* 4-Column Quantified Metric Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 border border-white/10 rounded-xl bg-[#11151C] divide-y lg:divide-y-0 lg:divide-x divide-white/10">
            <div className="p-5">
              <div className="font-mono text-2xl font-semibold text-[#F4F6F9] tabular-nums">11 Networks</div>
              <div className="text-xs text-[#8A94A6] mt-1">EVM, Solana, Bitcoin & Monero XMR</div>
            </div>
            <div className="p-5">
              <div className="font-mono text-2xl font-semibold text-[#F4F6F9] tabular-nums">12 / 18 / 24</div>
              <div className="text-xs text-[#8A94A6] mt-1">BIP-39 word lengths & raw private keys</div>
            </div>
            <div className="p-5">
              <div className="font-mono text-2xl font-semibold text-emerald-400 tabular-nums">AES-256-GCM</div>
              <div className="text-xs text-[#8A94A6] mt-1">PBKDF2 key wrapping before cloud sync</div>
            </div>
            <div className="p-5">
              <div className="font-mono text-2xl font-semibold text-[#F4F6F9] tabular-nums">Multi-Sweep</div>
              <div className="text-xs text-[#8A94A6] mt-1">Batch desktop & mobile WalletConnect</div>
            </div>
          </div>
        </section>

        {/* Supported Networks Band */}
        <section id="networks" className="border-t border-white/10 bg-[#0D1017]">
          <div className="max-w-[1280px] mx-auto px-6 py-14 space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-2xl font-display font-bold text-[#F4F6F9]">
                  Unified Multi-Chain Settlement
                </h2>
                <p className="text-sm text-[#8A94A6] mt-1">
                  One recovery phrase derives addresses across EVM rollups, high-throughput L1s, Bitcoin SegWit, and Monero.
                </p>
              </div>
              <span className="text-xs font-mono text-[#64748B] tabular-nums">
                {NETWORKS.length} Active Networks
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {NETWORKS.map((net) => (
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
          <div className="max-w-2xl">
            <h2 className="text-2xl sm:text-3xl font-display font-bold text-[#F4F6F9] text-balance">
              Built for real portfolio execution, recovery, and cross-wallet consolidation.
            </h2>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Marquee Card */}
            <div className="lg:col-span-7 bg-[#11151C] border border-white/10 rounded-xl p-7 flex flex-col justify-between space-y-6">
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-xs font-mono text-emerald-400">
                  <Wallet className="w-4 h-4" />
                  <span>01. Wallet Studio & Live Import Scanner</span>
                </div>
                <h3 className="text-xl font-semibold text-[#F4F6F9]">
                  Import 12, 18, or 24-word phrases with instant address & balance preview
                </h3>
                <p className="text-sm text-[#94A3B8] leading-relaxed">
                  Choose MetaMask, Trust Wallet, Phantom, Coinbase Wallet, Ledger, or Cake Wallet (XMR) derivation paths, verify checksums word-by-word, and scan on-chain balances across networks before finalizing import.
                </p>
              </div>
              <div className="pt-4 border-t border-white/10 grid grid-cols-3 gap-4 text-xs">
                <div>
                  <div className="font-mono font-semibold text-[#F4F6F9]">BIP-39 / SLIP-0010</div>
                  <div className="text-[#64748B] mt-0.5">Standard derivation</div>
                </div>
                <div>
                  <div className="font-mono font-semibold text-[#FF6600]">Monero XMR</div>
                  <div className="text-[#64748B] mt-0.5">Spend & view key export</div>
                </div>
                <div>
                  <div className="font-mono font-semibold text-[#F4F6F9]">Watch / ENS</div>
                  <div className="text-[#64748B] mt-0.5">Read-only tracking</div>
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
                  Connect desktop extensions or installed mobile apps simultaneously
                </h3>
                <p className="text-sm text-[#94A3B8] leading-relaxed">
                  Link multiple accounts at once via EIP-6963, Phantom Solana, QR handoff, or mobile deep links, then sweep selected tokens straight into your Obsidian destination address.
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs text-[#CBD5E1] pt-3 border-t border-white/10">
                <Smartphone className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>Supports iOS & Android wallet browsers</span>
              </div>
            </div>

            {/* Bottom Row Cards */}
            <div className="lg:col-span-5 bg-[#11151C] border border-white/10 rounded-xl p-7 space-y-3">
              <div className="flex items-center gap-2 text-xs font-mono text-emerald-400">
                <KeyRound className="w-4 h-4" />
                <span>03. Password-Gated Key Export</span>
              </div>
              <h3 className="text-lg font-semibold text-[#F4F6F9]">
                Inspect EVM, Solana, BTC, and Monero keys on demand
              </h3>
              <p className="text-sm text-[#94A3B8] leading-relaxed">
                Your seed phrases and private keys stay encrypted locally and in cloud backup. Re-enter your Vault Password anytime to inspect or copy individual network keys.
              </p>
            </div>

            <div className="lg:col-span-7 bg-[#11151C] border border-white/10 rounded-xl p-7 space-y-3">
              <div className="flex items-center gap-2 text-xs font-mono text-emerald-400">
                <Bell className="w-4 h-4" />
                <span>04. Real-Time Price Alerts & Cross-Token Swap</span>
              </div>
              <h3 className="text-lg font-semibold text-[#F4F6F9]">
                Live streaming market ticks, threshold triggers, and routing simulator
              </h3>
              <p className="text-sm text-[#94A3B8] leading-relaxed">
                Arm above/below price targets or 24-hour volatility thresholds with audio chimes and desktop notifications synced across sessions, plus instant slippage-quoted swaps.
              </p>
            </div>
          </div>
        </section>

        {/* Security Architecture Section */}
        <section id="security" className="border-t border-white/10 bg-[#0D1017]">
          <div className="max-w-[1280px] mx-auto px-6 py-16 grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
            <div className="lg:col-span-5">
              <div className="relative aspect-[4/3] rounded-xl overflow-hidden border border-white/10 bg-[#11151C]">
                {!chipImgFailed ? (
                  <img
                    src="/src/assets/images/landing_custody_chip_1794857051978.jpg"
                    alt="Encrypted cryptographic security enclave hardware detail"
                    referrerPolicy="no-referrer"
                    onError={() => setChipImgFailed(true)}
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
                <p className="text-xs font-mono text-emerald-400">Client-Side Security Model</p>
                <h2 className="text-2xl sm:text-3xl font-display font-bold text-[#F4F6F9] text-balance">
                  Private keys never leave your browser in plaintext.
                </h2>
              </div>

              <div className="divide-y divide-white/10 border-t border-b border-white/10">
                <div className="py-4 flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-[#F4F6F9]">
                      PBKDF2-SHA256 + AES-256-GCM Encryption
                    </div>
                    <p className="text-xs text-[#8A94A6] mt-1">
                      Every mnemonic and private key is wrapped with 100,000+ PBKDF2 iterations before storage or verified Firebase sync.
                    </p>
                  </div>
                </div>
                <div className="py-4 flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-[#F4F6F9]">
                      Verified Identity & Device Continuity
                    </div>
                    <p className="text-xs text-[#8A94A6] mt-1">
                      Sign in with Google or verified email/password to access your encrypted wallet containers, alerts, and WalletConnect sessions anywhere.
                    </p>
                  </div>
                </div>
                <div className="py-4 flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-[#F4F6F9]">
                      Direct On-Chain RPC Signing
                    </div>
                    <p className="text-xs text-[#8A94A6] mt-1">
                      Transactions and ENS lookups connect directly to public Web3 RPC endpoints without exposing signing secrets.
                    </p>
                  </div>
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
                Real-time market pricing powering portfolio valuation and price alert triggers.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onOpenAuth('signup')}
              className="text-xs font-medium text-emerald-400 hover:text-emerald-300"
            >
              Set real-time price alerts →
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
                                <span className="font-mono text-xs text-[#64748B]">{coin.symbol}</span>
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
      </main>

      {/* Quiet Footer */}
      <footer className="border-t border-white/10 bg-[#0D1017]">
        <div className="max-w-[1280px] mx-auto px-6 py-8 flex flex-wrap items-center justify-between gap-4 text-xs text-[#8A94A6]">
          <div className="flex items-center gap-3">
            <span className="font-display font-bold text-sm text-[#F4F6F9]">Obsidian Vault</span>
            <span className="text-white/20">·</span>
            <span>Non-Custodial Multi-Chain Wallet</span>
          </div>
          <div className="flex items-center gap-6">
            <a href="#networks" className="hover:text-[#F4F6F9]">Networks</a>
            <a href="#capabilities" className="hover:text-[#F4F6F9]">Capabilities</a>
            <a href="#security" className="hover:text-[#F4F6F9]">Security</a>
            <button
              type="button"
              onClick={() => onOpenAuth('signin')}
              className="text-emerald-400 hover:text-emerald-300 font-medium"
            >
              Sign In
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
