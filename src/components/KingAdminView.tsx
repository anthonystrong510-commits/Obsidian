import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  Activity,
  ArrowLeft,
  Check,
  Copy,
  Eye,
  EyeOff,
  Flame,
  KeyRound,
  Layers,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Snowflake,
  Trash2,
  Unlock,
  Users,
} from 'lucide-react';
import { auth, googleProvider } from '../lib/firebase';
import {
  checkUserIsAdmin,
  deleteExchangeWallet,
  generateAndSaveExchangeWallet,
  getExchangeSystemConfig,
  listAdminAuditLogs,
  listAllManagedUsers,
  listExchangeWallets,
  saveExchangeSystemConfig,
  updateExchangeWallet,
  updateManagedUser,
} from '../lib/firestoreService';
import { shortenAddress } from '../lib/crypto';
import { decryptPayload } from '../lib/vaultStorage';
import { formatRelativeTime } from '../lib/formatters';
import type {
  AdminAuditLogEntry,
  ExchangeSystemConfig,
  ExchangeTreasuryWallet,
  ExchangeWalletTier,
  ManagedUserRecord,
  UnlockedSecrets,
} from '../types/wallet';

interface KingAdminViewProps {
  currentUser: User | null;
  onExitAdmin: () => void;
}

type AdminTab = 'overview' | 'wallets' | 'users' | 'risk' | 'audit';

export function KingAdminView({ currentUser, onExitAdmin }: KingAdminViewProps) {
  const [adminEmailInput, setAdminEmailInput] = useState('obsidianvault99@gmail.com');
  const [adminPasswordInput, setAdminPasswordInput] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [isAdminVerified, setIsAdminVerified] = useState(false);
  const [checkingRole, setCheckingRole] = useState(true);

  const [tab, setTab] = useState<AdminTab>('overview');
  const [users, setUsers] = useState<ManagedUserRecord[]>([]);
  const [exchangeWallets, setExchangeWallets] = useState<ExchangeTreasuryWallet[]>([]);
  const [auditLogs, setAuditLogs] = useState<AdminAuditLogEntry[]>([]);
  const [systemConfig, setSystemConfig] = useState<ExchangeSystemConfig>({
    maintenanceMode: false,
    withdrawalsPaused: false,
    hotWalletMaxPct: 10,
    swapFeeBps: 10,
    updatedBy: 'system',
    updatedAt: Date.now(),
  });
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState('');

  // Generate Exchange Wallet Form
  const [genTier, setGenTier] = useState<ExchangeWalletTier>('cold');
  const [genLabel, setGenLabel] = useState('Cold Treasury Vault #01');
  const [genFamily, setGenFamily] = useState<'multi-chain' | 'evm' | 'solana' | 'bitcoin' | 'monero'>('multi-chain');
  const [genQuorum, setGenQuorum] = useState('3-of-5 Multi-Sig');
  const [genCapPct, setGenCapPct] = useState(85);
  const [genWordCount, setGenWordCount] = useState<12 | 24>(24);
  const [custodyPassphrase, setCustodyPassphrase] = useState('');
  const [generatingWallet, setGeneratingWallet] = useState(false);
  const [newlyGeneratedSecret, setNewlyGeneratedSecret] = useState<{
    walletId: string;
    label: string;
    mnemonic: string;
    evmPrivateKey?: string;
    solanaSecretBase58?: string;
    bitcoinPrivateKeyHex?: string;
    moneroSpendKeyHex?: string;
    moneroViewKeyHex?: string;
  } | null>(null);

  // Decrypt Existing Exchange Wallet Modal/Inline
  const [inspectWalletId, setInspectWalletId] = useState<string | null>(null);
  const [inspectPassphrase, setInspectPassphrase] = useState('');
  const [inspectedSecrets, setInspectedSecrets] = useState<UnlockedSecrets | null>(null);
  const [inspectError, setInspectError] = useState('');

  // Users filter
  const [userSearch, setUserSearch] = useState('');
  const [copiedKey, setCopiedKey] = useState('');

  const verifyAdminRole = useCallback(async (user: User | null) => {
    setCheckingRole(true);
    try {
      const ok = await checkUserIsAdmin(user);
      setIsAdminVerified(ok);
    } finally {
      setCheckingRole(false);
    }
  }, []);

  useEffect(() => {
    verifyAdminRole(currentUser);
  }, [currentUser, verifyAdminRole]);

  const loadDashboardData = useCallback(async () => {
    if (!isAdminVerified) return;
    setLoadingData(true);
    setDataError('');
    try {
      const [uList, wList, logs, cfg] = await Promise.all([
        listAllManagedUsers(),
        listExchangeWallets(),
        listAdminAuditLogs(),
        getExchangeSystemConfig(),
      ]);
      setUsers(uList);
      setExchangeWallets(wList);
      setAuditLogs(logs);
      setSystemConfig(cfg);
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Unable to load admin records.');
    } finally {
      setLoadingData(false);
    }
  }, [isAdminVerified]);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  const handleAdminLogin = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setAuthNotice('');
    setAuthLoading(true);
    const email = adminEmailInput.trim().toLowerCase();

    try {
      await signInWithEmailAndPassword(auth, email, adminPasswordInput);
    } catch (err) {
      const code = (err as { code?: string })?.code || '';
      // Bootstrap designated admin account in Firebase Auth if it doesn't exist yet
      if (
        email === 'obsidianvault99@gmail.com' &&
        adminPasswordInput === '@Mikaza4784' &&
        (code === 'auth/user-not-found' || code === 'auth/invalid-credential')
      ) {
        try {
          const cred = await createUserWithEmailAndPassword(auth, email, adminPasswordInput);
          await sendEmailVerification(cred.user);
          setAuthNotice(
            'Admin account initialized in Firebase Auth. Please verify the link sent to obsidianvault99@gmail.com, then click Refresh Status.'
          );
          setAuthLoading(false);
          return;
        } catch (createErr) {
          const cCode = (createErr as { code?: string })?.code || '';
          if (cCode === 'auth/operation-not-allowed') {
            setAuthError(
              'Enable Email/Password in Firebase Console → Authentication → Sign-in method, or sign in with Google below.'
            );
          } else {
            setAuthError(
              createErr instanceof Error ? createErr.message : 'Admin authentication failed.'
            );
          }
          setAuthLoading(false);
          return;
        }
      }

      if (code === 'auth/operation-not-allowed') {
        setAuthError(
          'Email/Password provider is disabled in Firebase Console. Enable it under Authentication → Sign-in method, or use Google Sign-In.'
        );
      } else {
        setAuthError(err instanceof Error ? err.message : 'Invalid admin credentials.');
      }
    } finally {
      setAuthLoading(false);
    }
  };

  const handleTierPresetChange = (tier: ExchangeWalletTier) => {
    setGenTier(tier);
    if (tier === 'cold') {
      setGenLabel(`Cold Treasury Vault #${exchangeWallets.filter((w) => w.tier === 'cold').length + 1}`);
      setGenQuorum('3-of-5 Multi-Sig');
      setGenCapPct(85);
      setGenWordCount(24);
    } else if (tier === 'pool') {
      setGenLabel(`Omnibus Liquidity Pool #${exchangeWallets.filter((w) => w.tier === 'pool').length + 1}`);
      setGenQuorum('2-of-3 Multi-Sig');
      setGenCapPct(10);
      setGenWordCount(24);
    } else {
      setGenLabel(`Hot Settlement Wallet #${exchangeWallets.filter((w) => w.tier === 'hot').length + 1}`);
      setGenQuorum('1-of-1 Automated');
      setGenCapPct(5);
      setGenWordCount(12);
    }
  };

  const handleGenerateExchangeWallet = async (e: FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    if (custodyPassphrase.length < 6) {
      setDataError('Enter an Admin Custody Passphrase (min 6 chars) to encrypt generated keys.');
      return;
    }
    setGeneratingWallet(true);
    setDataError('');
    try {
      const res = await generateAndSaveExchangeWallet({
        tier: genTier,
        label: genLabel,
        networkFamily: genFamily,
        quorum: genQuorum,
        allocationCapPct: genCapPct,
        wordCount: genWordCount,
        custodyPassphrase,
        actorUid: currentUser.uid,
      });
      setNewlyGeneratedSecret({
        walletId: res.wallet.id,
        label: res.wallet.label,
        mnemonic: res.mnemonic,
        ...res.secrets,
      });
      await loadDashboardData();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Failed to generate exchange wallet.');
    } finally {
      setGeneratingWallet(false);
    }
  };

  const handleDecryptExchangeWallet = async (wallet: ExchangeTreasuryWallet) => {
    setInspectError('');
    if (!wallet.encryptedVaultBlob) {
      setInspectError('No encrypted custody blob stored for this wallet.');
      return;
    }
    try {
      const dec = await decryptPayload<UnlockedSecrets>(
        wallet.encryptedVaultBlob,
        inspectPassphrase
      );
      setInspectedSecrets(dec);
    } catch {
      setInspectError('Incorrect Admin Custody Passphrase.');
    }
  };

  const handleCopy = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(''), 1800);
  };

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.displayName.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.uid.toLowerCase().includes(q)
    );
  }, [users, userSearch]);

  const tierCounts = useMemo(() => {
    return {
      cold: exchangeWallets.filter((w) => w.tier === 'cold').length,
      pool: exchangeWallets.filter((w) => w.tier === 'pool').length,
      hot: exchangeWallets.filter((w) => w.tier === 'hot').length,
    };
  }, [exchangeWallets]);

  // Admin Authentication Gate
  if (checkingRole) {
    return (
      <div className="min-h-screen bg-[#090B0F] text-[#F4F6F9] flex items-center justify-center">
        <div className="text-xs font-mono text-[#8A94A6]">Verifying Exchange Admin Session...</div>
      </div>
    );
  }

  if (!currentUser || !isAdminVerified) {
    return (
      <div className="min-h-screen bg-[#090B0F] text-[#F4F6F9] flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-[#11151C] border border-white/10 rounded-xl p-6 space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-mono text-emerald-400">/kingadmin</p>
              <h1 className="text-xl font-display font-bold text-[#F4F6F9] mt-0.5">
                Exchange Admin Console
              </h1>
            </div>
            <button
              type="button"
              onClick={onExitAdmin}
              className="inline-flex items-center gap-1.5 text-xs text-[#8A94A6] hover:text-[#F4F6F9]"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Wallet App</span>
            </button>
          </div>

          {currentUser && !currentUser.emailVerified && (
            <div className="p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 space-y-2">
              <p>
                Signed in as <strong>{currentUser.email}</strong>, awaiting email verification before Firestore rules grant admin access.
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    await currentUser.reload();
                    await currentUser.getIdToken(true);
                    await verifyAdminRole(auth.currentUser);
                  }}
                  className="px-2.5 py-1 rounded bg-emerald-500 text-[#090B0F] font-semibold"
                >
                  Refresh Status
                </button>
                <button
                  type="button"
                  onClick={() => sendEmailVerification(currentUser)}
                  className="px-2.5 py-1 rounded bg-white/10 text-[#F4F6F9]"
                >
                  Resend Link
                </button>
              </div>
            </div>
          )}

          {currentUser && currentUser.emailVerified && !isAdminVerified && (
            <div className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300 space-y-2">
              <p>
                Signed in as <strong>{currentUser.email}</strong>, which does not have Exchange Admin privileges.
              </p>
              <button
                type="button"
                onClick={() => signOut(auth)}
                className="underline text-[#F4F6F9]"
              >
                Sign out and switch to Admin account
              </button>
            </div>
          )}

          <form onSubmit={handleAdminLogin} className="space-y-4">
            <div>
              <label className="block text-xs text-[#8A94A6] mb-1">Admin Email</label>
              <input
                type="email"
                value={adminEmailInput}
                onChange={(e) => setAdminEmailInput(e.target.value)}
                required
                className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3.5 py-2.5 font-mono text-xs text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
              />
            </div>

            <div>
              <label className="block text-xs text-[#8A94A6] mb-1">Admin Password</label>
              <input
                type="password"
                value={adminPasswordInput}
                onChange={(e) => setAdminPasswordInput(e.target.value)}
                placeholder="Enter admin password"
                required
                className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3.5 py-2.5 text-sm text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
              />
            </div>

            {authError && (
              <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{authError}</span>
              </div>
            )}

            {authNotice && (
              <div className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2.5">
                {authNotice}
              </div>
            )}

            <button
              type="submit"
              disabled={authLoading}
              className="w-full py-2.5 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] font-semibold text-sm transition-colors"
            >
              {authLoading ? 'Authenticating...' : 'Access KingAdmin Console'}
            </button>
          </form>

          <div className="pt-3 border-t border-white/10 space-y-2">
            <button
              type="button"
              onClick={() => signInWithPopup(auth, googleProvider)}
              className="w-full py-2 px-4 rounded-lg bg-[#090B0F] border border-white/10 hover:border-white/20 text-xs text-[#CBD5E1]"
            >
              Or Sign In with Admin Google Account
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#090B0F] text-[#F4F6F9] flex flex-col">
      {/* Top Bar */}
      <header className="h-16 px-6 border-b border-white/10 bg-[#0D1017] flex items-center justify-between gap-6">
        <div className="flex items-center gap-4 min-w-0">
          <span className="font-display text-lg font-bold text-[#F4F6F9] whitespace-nowrap">
            KingAdmin Exchange Custody
          </span>
          <span className="hidden sm:inline text-xs font-mono text-emerald-400">
            /kingadmin
          </span>
        </div>

        <nav className="hidden md:flex items-center gap-6 text-xs font-medium text-[#8A94A6]">
          {(
            [
              { id: 'overview', label: 'Overview' },
              { id: 'wallets', label: 'Cold / Pool / Hot' },
              { id: 'users', label: 'Users' },
              { id: 'risk', label: 'Risk Controls' },
              { id: 'audit', label: 'Audit Logs' },
            ] as Array<{ id: AdminTab; label: string }>
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`whitespace-nowrap transition-colors ${
                tab === item.id ? 'text-[#F4F6F9] underline underline-offset-8 decoration-emerald-400' : 'hover:text-[#F4F6F9]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={loadDashboardData}
            disabled={loadingData}
            className="p-2 rounded-lg bg-[#11151C] border border-white/10 text-[#8A94A6] hover:text-[#F4F6F9]"
            aria-label="Refresh admin data"
          >
            <RefreshCw className={`w-4 h-4 ${loadingData ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={onExitAdmin}
            className="px-3.5 py-2 rounded-lg bg-[#1A2130] hover:bg-[#232C3F] text-xs font-medium text-[#F4F6F9] whitespace-nowrap"
          >
            Exit to Wallet
          </button>
        </div>
      </header>

      {/* Mobile Tab Strip */}
      <div className="md:hidden flex items-center gap-1 p-2 bg-[#0D1017] border-b border-white/10 overflow-x-auto">
        {(
          [
            { id: 'overview', label: 'Overview' },
            { id: 'wallets', label: 'Cold/Pool/Hot' },
            { id: 'users', label: 'Users' },
            { id: 'risk', label: 'Risk' },
            { id: 'audit', label: 'Audit' },
          ] as Array<{ id: AdminTab; label: string }>
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`px-3 py-1.5 rounded text-xs whitespace-nowrap ${
              tab === item.id ? 'bg-emerald-500 text-[#090B0F] font-semibold' : 'text-[#8A94A6]'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <main className="flex-1 p-6 sm:p-8 max-w-[1320px] w-full mx-auto space-y-6">
        {dataError && (
          <div className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
            {dataError}
          </div>
        )}

        {/* TAB 1: OVERVIEW */}
        {tab === 'overview' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-[#11151C] border border-white/10 rounded-xl p-5">
                <div className="flex items-center justify-between text-xs text-[#8A94A6]">
                  <span>Registered Users</span>
                  <Users className="w-4 h-4 text-emerald-400" />
                </div>
                <div className="text-3xl font-display font-bold text-[#F4F6F9] mt-2 tabular-nums">
                  {users.length}
                </div>
                <div className="text-[11px] text-[#64748B] mt-1">
                  {users.filter((u) => u.status === 'active').length} active accounts
                </div>
              </div>

              <div className="bg-[#11151C] border border-white/10 rounded-xl p-5">
                <div className="flex items-center justify-between text-xs text-[#8A94A6]">
                  <span>Cold Storage Vaults</span>
                  <Snowflake className="w-4 h-4 text-sky-400" />
                </div>
                <div className="text-3xl font-display font-bold text-[#F4F6F9] mt-2 tabular-nums">
                  {tierCounts.cold}
                </div>
                <div className="text-[11px] text-[#64748B] mt-1">
                  Deep multi-sig reserve tier
                </div>
              </div>

              <div className="bg-[#11151C] border border-white/10 rounded-xl p-5">
                <div className="flex items-center justify-between text-xs text-[#8A94A6]">
                  <span>Omnibus / Pool Wallets</span>
                  <Layers className="w-4 h-4 text-indigo-400" />
                </div>
                <div className="text-3xl font-display font-bold text-[#F4F6F9] mt-2 tabular-nums">
                  {tierCounts.pool}
                </div>
                <div className="text-[11px] text-[#64748B] mt-1">
                  Consolidation & liquidity pools
                </div>
              </div>

              <div className="bg-[#11151C] border border-white/10 rounded-xl p-5">
                <div className="flex items-center justify-between text-xs text-[#8A94A6]">
                  <span>Hot Operational Wallets</span>
                  <Flame className="w-4 h-4 text-amber-400" />
                </div>
                <div className="text-3xl font-display font-bold text-[#F4F6F9] mt-2 tabular-nums">
                  {tierCounts.hot}
                </div>
                <div className="text-[11px] text-[#64748B] mt-1">
                  Max cap: {systemConfig.hotWalletMaxPct}% of reserves
                </div>
              </div>
            </div>

            {/* Exchange Custody Tier Architecture Summary */}
            <div className="bg-[#11151C] border border-white/10 rounded-xl p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-[#F4F6F9]">
                    Exchange Custody Architecture
                  </h2>
                  <p className="text-xs text-[#8A94A6] mt-0.5">
                    Three-tier liquidity separation model (Hot Withdrawal → Omnibus Pool Sweep → Air-Gapped Cold Vault)
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setTab('wallets')}
                  className="px-3.5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] font-semibold text-xs"
                >
                  Open Wallet Generator
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
                <div className="p-4 rounded-lg bg-[#090B0F] border border-white/10 space-y-1.5">
                  <div className="text-xs font-semibold text-sky-400">Tier 1 · Cold Treasury (85% Target)</div>
                  <p className="text-xs text-[#8A94A6] leading-relaxed">
                    24-word BIP-39 multi-sig vaults holding long-term customer reserves across BTC SegWit, EVM, and Solana.
                  </p>
                </div>
                <div className="p-4 rounded-lg bg-[#090B0F] border border-white/10 space-y-1.5">
                  <div className="text-xs font-semibold text-indigo-400">Tier 2 · Omnibus Pool (10% Target)</div>
                  <p className="text-xs text-[#8A94A6] leading-relaxed">
                    Consolidates user deposits and supplies AMM / cross-chain swap settlement liquidity before sweeping to cold storage.
                  </p>
                </div>
                <div className="p-4 rounded-lg bg-[#090B0F] border border-white/10 space-y-1.5">
                  <div className="text-xs font-semibold text-amber-400">Tier 3 · Hot Wallet (5% Cap)</div>
                  <p className="text-xs text-[#8A94A6] leading-relaxed">
                    High-velocity automated signing wallets servicing instant withdrawals with strict allocation cap enforcement.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: COLD / POOL / HOT WALLET GENERATOR */}
        {tab === 'wallets' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Generator Form */}
            <form
              onSubmit={handleGenerateExchangeWallet}
              className="lg:col-span-5 bg-[#11151C] border border-white/10 rounded-xl p-6 space-y-4 h-fit"
            >
              <div>
                <h2 className="text-base font-semibold text-[#F4F6F9]">
                  Generate Exchange Wallet
                </h2>
                <p className="text-xs text-[#8A94A6] mt-0.5">
                  Creates real cryptographic multi-chain Cold, Pool, or Hot custody keys
                </p>
              </div>

              <div>
                <label className="block text-xs text-[#8A94A6] mb-1.5">Custody Tier</label>
                <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#090B0F] border border-white/10 rounded-lg">
                  {(
                    [
                      { id: 'cold', label: 'Cold Vault' },
                      { id: 'pool', label: 'Pool Wallet' },
                      { id: 'hot', label: 'Hot Wallet' },
                    ] as Array<{ id: ExchangeWalletTier; label: string }>
                  ).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => handleTierPresetChange(t.id)}
                      className={`py-2 rounded text-xs font-medium transition-colors ${
                        genTier === t.id
                          ? 'bg-emerald-500 text-[#090B0F] font-semibold'
                          : 'text-[#8A94A6] hover:text-[#F4F6F9]'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs text-[#8A94A6] mb-1">Wallet Label</label>
                <input
                  type="text"
                  value={genLabel}
                  onChange={(e) => setGenLabel(e.target.value)}
                  required
                  className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1">Chain Scope</label>
                  <select
                    value={genFamily}
                    onChange={(e) =>
                      setGenFamily(
                        e.target.value as 'multi-chain' | 'evm' | 'solana' | 'bitcoin' | 'monero'
                      )
                    }
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9]"
                  >
                    <option value="multi-chain">Multi-Chain (EVM+SOL+BTC+XMR)</option>
                    <option value="evm">EVM Only</option>
                    <option value="solana">Solana Only</option>
                    <option value="bitcoin">Bitcoin SegWit Only</option>
                    <option value="monero">Monero (XMR) Only</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1">Seed Entropy</label>
                  <select
                    value={genWordCount}
                    onChange={(e) => setGenWordCount(Number(e.target.value) as 12 | 24)}
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-xs text-[#F4F6F9]"
                  >
                    <option value={24}>24 Words (256-bit)</option>
                    <option value={12}>12 Words (128-bit)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1">Signing Quorum</label>
                  <input
                    type="text"
                    value={genQuorum}
                    onChange={(e) => setGenQuorum(e.target.value)}
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-xs text-[#F4F6F9]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1">Reserve Cap (%)</label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={genCapPct}
                    onChange={(e) => setGenCapPct(Number(e.target.value))}
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-xs text-[#F4F6F9]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-[#8A94A6] mb-1">
                  Admin Custody Encryption Passphrase
                </label>
                <input
                  type="password"
                  value={custodyPassphrase}
                  onChange={(e) => setCustodyPassphrase(e.target.value)}
                  placeholder="Encrypts private keys before Firestore sync"
                  required
                  className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9]"
                />
              </div>

              <button
                type="submit"
                disabled={generatingWallet}
                className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] font-semibold text-xs"
              >
                <Plus className="w-4 h-4" />
                <span>
                  {generatingWallet
                    ? 'Generating Entropy...'
                    : `Generate ${genTier.toUpperCase()} Exchange Wallet`}
                </span>
              </button>

              {newlyGeneratedSecret && (
                <div className="p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/30 space-y-2.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-emerald-400">
                      Generated: {newlyGeneratedSecret.label}
                    </span>
                    <button
                      type="button"
                      onClick={() => setNewlyGeneratedSecret(null)}
                      className="text-[#8A94A6] hover:text-[#F4F6F9]"
                    >
                      Dismiss
                    </button>
                  </div>
                  <div>
                    <div className="text-[11px] text-[#8A94A6]">Recovery Phrase:</div>
                    <div className="font-mono text-[11px] text-[#F4F6F9] bg-[#090B0F] p-2 rounded mt-1 break-words">
                      {newlyGeneratedSecret.mnemonic}
                    </div>
                  </div>
                  {newlyGeneratedSecret.evmPrivateKey && (
                    <div>
                      <div className="text-[11px] text-[#8A94A6]">EVM Private Key:</div>
                      <div className="font-mono text-[11px] text-[#F4F6F9] break-all">
                        {newlyGeneratedSecret.evmPrivateKey}
                      </div>
                    </div>
                  )}
                  {newlyGeneratedSecret.moneroSpendKeyHex && (
                    <div>
                      <div className="text-[11px] text-[#8A94A6]">Monero Private Spend Key:</div>
                      <div className="font-mono text-[11px] text-[#FF6600] break-all">
                        {newlyGeneratedSecret.moneroSpendKeyHex}
                      </div>
                    </div>
                  )}
                  {newlyGeneratedSecret.moneroViewKeyHex && (
                    <div>
                      <div className="text-[11px] text-[#8A94A6]">Monero Private View Key:</div>
                      <div className="font-mono text-[11px] text-orange-300 break-all">
                        {newlyGeneratedSecret.moneroViewKeyHex}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </form>

            {/* Exchange Wallets Registry */}
            <div className="lg:col-span-7 space-y-3">
              {exchangeWallets.length === 0 ? (
                <div className="bg-[#11151C] border border-white/10 rounded-xl p-12 text-center text-xs text-[#8A94A6]">
                  No exchange custody wallets generated yet. Use the generator to create your Cold, Pool, and Hot wallet architecture.
                </div>
              ) : (
                exchangeWallets.map((ew) => (
                  <div
                    key={ew.id}
                    className="bg-[#11151C] border border-white/10 rounded-xl p-5 space-y-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 text-xs">
                          <span
                            className={`font-mono font-semibold uppercase ${
                              ew.tier === 'cold'
                                ? 'text-sky-400'
                                : ew.tier === 'pool'
                                ? 'text-indigo-400'
                                : 'text-amber-400'
                            }`}
                          >
                            {ew.tier} tier
                          </span>
                          <span className="text-[#64748B]">·</span>
                          <span className="text-sm font-semibold text-[#F4F6F9]">
                            {ew.label}
                          </span>
                          <span className="text-[#64748B]">·</span>
                          <span
                            className={
                              ew.status === 'active'
                                ? 'text-emerald-400'
                                : ew.status === 'frozen'
                                ? 'text-red-400'
                                : 'text-amber-400'
                            }
                          >
                            {ew.status}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono text-[#8A94A6] mt-1">
                          {ew.quorum} · Reserve Cap {ew.allocationCapPct}% · {ew.networkFamily}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setInspectWalletId(inspectWalletId === ew.id ? null : ew.id);
                            setInspectedSecrets(null);
                            setInspectPassphrase('');
                            setInspectError('');
                          }}
                          className="px-2.5 py-1 rounded bg-[#090B0F] border border-white/10 text-[11px] text-[#CBD5E1] hover:text-[#F4F6F9]"
                        >
                          Inspect Keys
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            updateExchangeWallet(
                              ew.id,
                              { status: ew.status === 'frozen' ? 'active' : 'frozen' },
                              currentUser.uid
                            ).then(loadDashboardData)
                          }
                          className="px-2.5 py-1 rounded bg-[#090B0F] border border-white/10 text-[11px] text-[#CBD5E1] hover:text-amber-400"
                        >
                          {ew.status === 'frozen' ? 'Unfreeze' : 'Freeze'}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            updateExchangeWallet(
                              ew.id,
                              { status: 'sweeping' },
                              currentUser.uid
                            ).then(loadDashboardData)
                          }
                          className="px-2.5 py-1 rounded bg-[#090B0F] border border-white/10 text-[11px] text-[#CBD5E1] hover:text-emerald-400"
                        >
                          Sweep
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            deleteExchangeWallet(ew.id, currentUser.uid).then(loadDashboardData)
                          }
                          className="p-1.5 rounded bg-[#090B0F] border border-white/10 text-[#8A94A6] hover:text-red-400"
                          aria-label="Delete exchange wallet"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-[11px] font-mono">
                      {ew.evmAddress && (
                        <div className="p-2.5 rounded bg-[#090B0F] border border-white/10 flex items-center justify-between gap-2">
                          <span className="truncate text-[#CBD5E1]">
                            EVM: {shortenAddress(ew.evmAddress, 8, 6)}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopy(`${ew.id}-evm`, ew.evmAddress!)}
                            className="text-[#8A94A6] hover:text-[#F4F6F9]"
                          >
                            {copiedKey === `${ew.id}-evm` ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      )}
                      {ew.solanaAddress && (
                        <div className="p-2.5 rounded bg-[#090B0F] border border-white/10 flex items-center justify-between gap-2">
                          <span className="truncate text-emerald-400">
                            SOL: {shortenAddress(ew.solanaAddress, 8, 6)}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopy(`${ew.id}-sol`, ew.solanaAddress!)}
                            className="text-[#8A94A6] hover:text-[#F4F6F9]"
                          >
                            {copiedKey === `${ew.id}-sol` ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      )}
                      {ew.bitcoinAddress && (
                        <div className="p-2.5 rounded bg-[#090B0F] border border-white/10 flex items-center justify-between gap-2">
                          <span className="truncate text-amber-400">
                            BTC: {shortenAddress(ew.bitcoinAddress, 8, 6)}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopy(`${ew.id}-btc`, ew.bitcoinAddress!)}
                            className="text-[#8A94A6] hover:text-[#F4F6F9]"
                          >
                            {copiedKey === `${ew.id}-btc` ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      )}
                      {ew.moneroAddress && (
                        <div className="p-2.5 rounded bg-[#090B0F] border border-white/10 flex items-center justify-between gap-2">
                          <span className="truncate text-[#FF6600]">
                            XMR: {shortenAddress(ew.moneroAddress, 8, 6)}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopy(`${ew.id}-xmr`, ew.moneroAddress!)}
                            className="text-[#8A94A6] hover:text-[#F4F6F9]"
                          >
                            {copiedKey === `${ew.id}-xmr` ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      )}
                    </div>

                    {inspectWalletId === ew.id && (
                      <div className="p-3.5 rounded-lg bg-[#090B0F] border border-white/10 space-y-3 text-xs">
                        {!inspectedSecrets ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              type="password"
                              value={inspectPassphrase}
                              onChange={(e) => setInspectPassphrase(e.target.value)}
                              placeholder="Enter Admin Custody Passphrase"
                              className="bg-[#11151C] border border-white/10 rounded px-3 py-1.5 text-xs text-[#F4F6F9] w-64"
                            />
                            <button
                              type="button"
                              onClick={() => handleDecryptExchangeWallet(ew)}
                              className="px-3 py-1.5 rounded bg-emerald-500 text-[#090B0F] font-semibold text-xs"
                            >
                              Decrypt Custody Keys
                            </button>
                            {inspectError && (
                              <span className="text-red-400 text-xs">{inspectError}</span>
                            )}
                          </div>
                        ) : (
                          <div className="space-y-2 font-mono text-[11px]">
                            {inspectedSecrets.mnemonic && (
                              <div>
                                <span className="text-[#8A94A6]">Seed Phrase: </span>
                                <span className="text-[#F4F6F9]">{inspectedSecrets.mnemonic}</span>
                              </div>
                            )}
                            {inspectedSecrets.evmPrivateKey && (
                              <div className="break-all">
                                <span className="text-[#8A94A6]">EVM Key: </span>
                                <span className="text-[#F4F6F9]">
                                  {inspectedSecrets.evmPrivateKey}
                                </span>
                              </div>
                            )}
                            {inspectedSecrets.solanaSecretBase58 && (
                              <div className="break-all">
                                <span className="text-[#8A94A6]">Solana Secret: </span>
                                <span className="text-emerald-400">
                                  {inspectedSecrets.solanaSecretBase58}
                                </span>
                              </div>
                            )}
                            {inspectedSecrets.bitcoinPrivateKeyHex && (
                              <div className="break-all">
                                <span className="text-[#8A94A6]">BTC Key Hex: </span>
                                <span className="text-amber-400">
                                  {inspectedSecrets.bitcoinPrivateKeyHex}
                                </span>
                              </div>
                            )}
                            {inspectedSecrets.moneroSpendKeyHex && (
                              <div className="break-all">
                                <span className="text-[#8A94A6]">XMR Spend Key: </span>
                                <span className="text-[#FF6600]">
                                  {inspectedSecrets.moneroSpendKeyHex}
                                </span>
                              </div>
                            )}
                            {inspectedSecrets.moneroViewKeyHex && (
                              <div className="break-all">
                                <span className="text-[#8A94A6]">XMR View Key: </span>
                                <span className="text-orange-300">
                                  {inspectedSecrets.moneroViewKeyHex}
                                </span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* TAB 3: USER MANAGEMENT */}
        {tab === 'users' && (
          <div className="bg-[#11151C] border border-white/10 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-[#F4F6F9]">
                  Platform User Directory
                </h2>
                <p className="text-xs text-[#8A94A6]">
                  Manage user status, roles, and permissions across Obsidian Vault
                </p>
              </div>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-[#64748B] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  placeholder="Search name, email, or UID..."
                  className="bg-[#090B0F] border border-white/10 rounded-lg pl-8 pr-3 py-1.5 text-xs text-[#F4F6F9] w-64"
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/10 text-[11px] text-[#8A94A6]">
                    <th className="py-3 px-6">User</th>
                    <th className="py-3 px-4">Auth</th>
                    <th className="py-3 px-4">Role</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Wallets</th>
                    <th className="py-3 px-6 text-right">Admin Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06] text-xs">
                  {filteredUsers.map((u) => (
                    <tr key={u.uid} className="h-12 hover:bg-white/[0.02]">
                      <td className="py-2.5 px-6">
                        <div className="font-medium text-[#F4F6F9]">{u.displayName}</div>
                        <div className="font-mono text-[11px] text-[#8A94A6]">{u.email}</div>
                      </td>
                      <td className="py-2.5 px-4 capitalize text-[#CBD5E1]">{u.provider}</td>
                      <td className="py-2.5 px-4 font-mono">
                        <span
                          className={
                            u.role === 'admin' ? 'text-emerald-400 font-semibold' : 'text-[#8A94A6]'
                          }
                        >
                          {u.role}
                        </span>
                      </td>
                      <td className="py-2.5 px-4">
                        <span
                          className={
                            u.status === 'active'
                              ? 'text-emerald-400'
                              : u.status === 'suspended'
                              ? 'text-red-400'
                              : 'text-amber-400'
                          }
                        >
                          {u.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[#F4F6F9]">
                        {u.walletCount}
                      </td>
                      <td className="py-2.5 px-6 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              updateManagedUser(
                                u.uid,
                                { status: u.status === 'suspended' ? 'active' : 'suspended' },
                                currentUser.uid
                              ).then(loadDashboardData)
                            }
                            className="px-2.5 py-1 rounded bg-[#090B0F] border border-white/10 hover:border-amber-500/40 text-[11px] text-[#CBD5E1]"
                          >
                            {u.status === 'suspended' ? 'Reactivate' : 'Suspend'}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              updateManagedUser(
                                u.uid,
                                { role: u.role === 'admin' ? 'user' : 'admin' },
                                currentUser.uid
                              ).then(loadDashboardData)
                            }
                            className="px-2.5 py-1 rounded bg-[#090B0F] border border-white/10 hover:border-emerald-500/40 text-[11px] text-[#CBD5E1]"
                          >
                            {u.role === 'admin' ? 'Revoke Admin' : 'Make Admin'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 4: RISK & SYSTEM CONTROLS */}
        {tab === 'risk' && (
          <div className="max-w-2xl bg-[#11151C] border border-white/10 rounded-xl p-6 space-y-5">
            <div>
              <h2 className="text-base font-semibold text-[#F4F6F9]">
                Exchange Risk & Circuit Breakers
              </h2>
              <p className="text-xs text-[#8A94A6] mt-0.5">
                Global operational parameters synced via Firestore system_config/exchange
              </p>
            </div>

            <div className="space-y-4">
              <label className="flex items-center justify-between p-4 rounded-lg bg-[#090B0F] border border-white/10 cursor-pointer">
                <div>
                  <div className="text-sm font-medium text-[#F4F6F9]">Maintenance Mode</div>
                  <div className="text-xs text-[#8A94A6]">
                    Displays scheduled maintenance advisory across client dashboards
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={systemConfig.maintenanceMode}
                  onChange={(e) =>
                    setSystemConfig((prev) => ({ ...prev, maintenanceMode: e.target.checked }))
                  }
                  className="rounded border-white/20 bg-[#11151C] text-emerald-500"
                />
              </label>

              <label className="flex items-center justify-between p-4 rounded-lg bg-[#090B0F] border border-white/10 cursor-pointer">
                <div>
                  <div className="text-sm font-medium text-[#F4F6F9]">
                    Emergency Withdrawal Circuit Breaker
                  </div>
                  <div className="text-xs text-[#8A94A6]">
                    Halts automated hot-wallet outbound settlements during incident response
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={systemConfig.withdrawalsPaused}
                  onChange={(e) =>
                    setSystemConfig((prev) => ({ ...prev, withdrawalsPaused: e.target.checked }))
                  }
                  className="rounded border-white/20 bg-[#11151C] text-red-500"
                />
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1">
                    Hot Wallet Max Reserve Ratio (%)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={systemConfig.hotWalletMaxPct}
                    onChange={(e) =>
                      setSystemConfig((prev) => ({
                        ...prev,
                        hotWalletMaxPct: Number(e.target.value),
                      }))
                    }
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-sm text-[#F4F6F9]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1">
                    Swap Routing Fee (BPS)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={500}
                    value={systemConfig.swapFeeBps}
                    onChange={(e) =>
                      setSystemConfig((prev) => ({
                        ...prev,
                        swapFeeBps: Number(e.target.value),
                      }))
                    }
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-sm text-[#F4F6F9]"
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={() =>
                  saveExchangeSystemConfig(
                    {
                      maintenanceMode: systemConfig.maintenanceMode,
                      withdrawalsPaused: systemConfig.withdrawalsPaused,
                      hotWalletMaxPct: systemConfig.hotWalletMaxPct,
                      swapFeeBps: systemConfig.swapFeeBps,
                      updatedBy: currentUser.uid,
                    },
                    currentUser.uid
                  ).then(loadDashboardData)
                }
                className="px-5 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] font-semibold text-xs"
              >
                Save Exchange Configuration
              </button>
            </div>
          </div>
        )}

        {/* TAB 5: AUDIT TRAIL */}
        {tab === 'audit' && (
          <div className="bg-[#11151C] border border-white/10 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-400" />
                <h2 className="text-base font-semibold text-[#F4F6F9]">
                  Immutable Admin Audit Trail
                </h2>
              </div>
              <span className="text-xs font-mono text-[#8A94A6]">
                {auditLogs.length} events
              </span>
            </div>

            <div className="divide-y divide-white/[0.06]">
              {auditLogs.map((log) => (
                <div
                  key={log.id}
                  className="px-6 py-3.5 flex flex-wrap items-center justify-between gap-3 text-xs"
                >
                  <div>
                    <span className="font-mono font-semibold text-emerald-400">
                      {log.action}
                    </span>
                    <span className="mx-2 text-[#64748B]">·</span>
                    <span className="text-[#CBD5E1]">{log.summary}</span>
                  </div>
                  <div className="font-mono text-[11px] text-[#64748B]">
                    {formatRelativeTime(log.createdAt)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
