import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  type User,
} from 'firebase/auth';
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Unlock,
  Wallet,
} from 'lucide-react';
import { auth, googleProvider } from '../lib/firebase';
import {
  deriveWalletFromMnemonic,
  normalizePhrase,
  shortenAddress,
  validateMnemonicPhrase,
} from '../lib/crypto';
import { formatCryptoAmount, formatFiat } from '../lib/formatters';
import { WALLET_PRESETS } from '../lib/networks';
import {
  canDecryptAnyWallet,
  createVaultVerifier,
  encryptPayload,
  hasVaultPassword,
  verifyVaultPassword,
} from '../lib/vaultStorage';
import { fetchMultiChainPortfolio } from '../lib/web3Service';
import type {
  MarketCoin,
  PortfolioHolding,
  UnlockedSecrets,
  WalletAccount,
  WalletPresetId,
} from '../types/wallet';

type LockViewMode = 'unlock' | 'recover-seed' | 'recover-auth';

interface VaultLockScreenProps {
  wallets: WalletAccount[];
  markets: MarketCoin[];
  authUser: User | null;
  onUnlock: (password: string) => Promise<void>;
  onRecoverWithSeed: (
    wallet: WalletAccount,
    secrets: UnlockedSecrets,
    newPassword: string
  ) => Promise<void>;
  onRecoverWithAuth: (newPassword: string) => Promise<void>;
  onResetVault: () => void;
}

export function VaultLockScreen({
  wallets,
  markets,
  authUser,
  onUnlock,
  onRecoverWithSeed,
  onRecoverWithAuth,
  onResetVault,
}: VaultLockScreenProps) {
  const [viewMode, setViewMode] = useState<LockViewMode>('unlock');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  // Seed Recovery State
  const [seedPhraseInput, setSeedPhraseInput] = useState('');
  const [seedPreset, setSeedPreset] = useState<WalletPresetId>('standard');
  const [seedNewPassword, setSeedNewPassword] = useState('');
  const [seedConfirmPassword, setSeedConfirmPassword] = useState('');
  const [seedAssets, setSeedAssets] = useState<PortfolioHolding[]>([]);
  const [scanningSeedAssets, setScanningSeedAssets] = useState(false);

  // Normal Auth Recovery State
  const isGoogleUser = Boolean(
    authUser?.providerData.some((p) => p.providerId === 'google.com')
  );
  const [authVerifyPassword, setAuthVerifyPassword] = useState('');
  const [authReverified, setAuthReverified] = useState(false);
  const [authAssets, setAuthAssets] = useState<PortfolioHolding[]>([]);
  const [scanningAuthAssets, setScanningAuthAssets] = useState(false);
  const [authNewPassword, setAuthNewPassword] = useState('');
  const [authConfirmPassword, setAuthConfirmPassword] = useState('');

  const normalizedSeed = useMemo(() => normalizePhrase(seedPhraseInput), [seedPhraseInput]);
  const seedValidation = useMemo(() => {
    const words = normalizedSeed.split(' ').filter(Boolean);
    if (words.length === 0) return { valid: false, wordCount: 0, error: '' };
    if (![12, 18, 24].includes(words.length)) {
      return {
        valid: false,
        wordCount: words.length,
        error: `${words.length} words entered (requires 12, 18, or 24 words)`,
      };
    }
    const res = validateMnemonicPhrase(normalizedSeed);
    return { valid: res.valid, wordCount: words.length, error: res.error || '' };
  }, [normalizedSeed]);

  const recoveredPreviewAddresses = useMemo(() => {
    if (!seedValidation.valid) return null;
    try {
      return deriveWalletFromMnemonic(normalizedSeed, {
        preset: seedPreset,
        accountIndex: 0,
      }).addresses;
    } catch {
      return null;
    }
  }, [seedValidation.valid, normalizedSeed, seedPreset]);

  // Scan assets FIRST as soon as recovery seed is valid
  useEffect(() => {
    if (viewMode !== 'recover-seed' || !recoveredPreviewAddresses) {
      setSeedAssets([]);
      setScanningSeedAssets(false);
      return;
    }
    let cancelled = false;
    setScanningSeedAssets(true);
    fetchMultiChainPortfolio(recoveredPreviewAddresses, markets, [])
      .then((res) => {
        if (!cancelled) setSeedAssets(res.filter((h) => h.balance > 0));
      })
      .catch(() => {
        if (!cancelled) setSeedAssets([]);
      })
      .finally(() => {
        if (!cancelled) setScanningSeedAssets(false);
      });
    return () => {
      cancelled = true;
    };
  }, [viewMode, recoveredPreviewAddresses, markets]);

  // Scan synced wallet assets FIRST when opening Normal Auth recovery
  useEffect(() => {
    if (viewMode !== 'recover-auth' || wallets.length === 0) return;
    let cancelled = false;
    setScanningAuthAssets(true);
    Promise.all(
      wallets.slice(0, 5).map((w) => fetchMultiChainPortfolio(w.addresses, markets, []))
    )
      .then((results) => {
        if (cancelled) return;
        const combined = results.flat().filter((h) => h.balance > 0);
        setAuthAssets(combined);
      })
      .catch(() => {
        if (!cancelled) setAuthAssets([]);
      })
      .finally(() => {
        if (!cancelled) setScanningAuthAssets(false);
      });
    return () => {
      cancelled = true;
    };
  }, [viewMode, wallets, markets]);

  const handleSubmitUnlock = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError('Enter your vault password.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const hasVerifier = hasVaultPassword();
      const verifierOk = hasVerifier ? await verifyVaultPassword(password) : false;
      const walletDecryptOk = await canDecryptAnyWallet(wallets, password);

      if (!verifierOk && !walletDecryptOk) {
        setError(
          'Password did not match these encrypted wallets. Use Seed Phrase Recovery or Account Recovery below.'
        );
        setLoading(false);
        return;
      }

      // Synchronize local verifier on successful decryption
      await createVaultVerifier(password);
      await onUnlock(password);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to decrypt vault. Use Seed Phrase or Account Recovery below.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleSeedRecoverSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!seedValidation.valid) {
      setError('Enter a valid 12, 18, or 24-word BIP-39 recovery phrase.');
      return;
    }
    if (seedNewPassword.length < 6) {
      setError('Create a new vault password (minimum 6 characters).');
      return;
    }
    if (seedNewPassword !== seedConfirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const derived = deriveWalletFromMnemonic(normalizedSeed, {
        preset: seedPreset,
        accountIndex: 0,
      });
      await createVaultVerifier(seedNewPassword);
      const encryptedSecret = await encryptPayload(derived.secrets, seedNewPassword);

      // Preserve existing wallet ID/name if same EVM/SOL address already exists
      const existingMatch = wallets.find(
        (w) =>
          (w.addresses.evmAddress &&
            w.addresses.evmAddress.toLowerCase() ===
              derived.addresses.evmAddress.toLowerCase()) ||
          (w.addresses.solanaAddress &&
            w.addresses.solanaAddress === derived.addresses.solanaAddress)
      );

      const wallet: WalletAccount = {
        id: existingMatch?.id || crypto.randomUUID(),
        name: existingMatch?.name || 'Recovered Multi-Chain Vault',
        type: 'mnemonic',
        wordCount: seedValidation.wordCount as 12 | 18 | 24,
        preset: seedPreset,
        accountIndex: 0,
        addresses: derived.addresses,
        encryptedSecret,
        createdAt: existingMatch?.createdAt || Date.now(),
      };

      await onRecoverWithSeed(wallet, derived.secrets, seedNewPassword);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to recover wallet from phrase.');
    } finally {
      setLoading(false);
    }
  };

  const handleReverifyAccount = async () => {
    if (!authUser) return;
    setError('');
    setLoading(true);
    try {
      if (isGoogleUser) {
        await reauthenticateWithPopup(authUser, googleProvider);
      } else {
        if (!authUser.email || !authVerifyPassword) {
          throw new Error('Enter your Firebase account password to confirm ownership.');
        }
        const cred = EmailAuthProvider.credential(authUser.email, authVerifyPassword);
        await reauthenticateWithCredential(authUser, cred);
      }
      setAuthReverified(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Account verification failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteAuthRecovery = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!authReverified) {
      setError('Verify your signed-in account ownership first.');
      return;
    }
    if (authNewPassword.length < 6) {
      setError('Create a new vault password (minimum 6 characters).');
      return;
    }
    if (authNewPassword !== authConfirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await createVaultVerifier(authNewPassword);
      await onRecoverWithAuth(authNewPassword);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to complete account recovery.');
    } finally {
      setLoading(false);
    }
  };

  const seedTotalUsd = seedAssets.reduce((sum, a) => sum + a.valueUsd, 0);
  const authTotalUsd = authAssets.reduce((sum, a) => sum + a.valueUsd, 0);

  return (
    <div className="min-h-screen bg-[#090B0F] text-[#F4F6F9] flex items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-lg bg-[#11151C] border border-white/10 rounded-xl overflow-hidden">
        <div className="relative h-40 w-full overflow-hidden border-b border-white/10 bg-[#0B0E14]">
          <img
            src="/src/assets/images/vault_monolith_hero_1794846319768.jpg"
            alt="Obsidian Vault hardware key"
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover opacity-80"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#11151C] via-[#11151C]/50 to-transparent" />
          <div className="absolute bottom-4 left-6 right-6 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#8A94A6]">
                {viewMode === 'unlock'
                  ? 'Encrypted Keystore Session'
                  : viewMode === 'recover-seed'
                  ? 'Seed Phrase Recovery'
                  : 'Account Auth Recovery'}
              </p>
              <h1 className="text-xl font-semibold tracking-tight text-[#F4F6F9]">
                Obsidian Vault
              </h1>
            </div>
            <div className="w-10 h-10 rounded-lg bg-[#090B0F]/80 border border-white/10 flex items-center justify-center text-emerald-400">
              {viewMode === 'unlock' ? <Lock className="w-5 h-5" /> : <KeyRound className="w-5 h-5" />}
            </div>
          </div>
        </div>

        {/* MODE 1: STANDARD PASSWORD UNLOCK */}
        {viewMode === 'unlock' && (
          <form onSubmit={handleSubmitUnlock} className="p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#8A94A6]">
              <span>
                {wallets.length} synced wallet{wallets.length === 1 ? '' : 's'} · AES-256-GCM
              </span>
              {authUser?.email && (
                <span className="font-mono text-[#CBD5E1] truncate max-w-[200px]">
                  {authUser.email}
                </span>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="vault-unlock-pw" className="block text-xs font-medium text-[#CBD5E1]">
                Vault Password
              </label>
              <div className="relative">
                <input
                  id="vault-unlock-pw"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password to decrypt keys"
                  autoFocus
                  className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3.5 py-2.5 pr-10 text-sm text-[#F4F6F9] placeholder-[#525D70] focus:outline-none focus:border-emerald-500/60"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#8A94A6] hover:text-[#F4F6F9]"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-sm transition-colors whitespace-nowrap"
            >
              <Unlock className="w-4 h-4" />
              <span>{loading ? 'Decrypting Vault...' : 'Unlock Vault'}</span>
            </button>

            <div className="pt-3 border-t border-white/10 space-y-2.5">
              <div className="text-[11px] text-[#64748B]">Need to recover access on this browser?</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setViewMode('recover-seed');
                    setError('');
                  }}
                  className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-[#090B0F] border border-white/10 hover:border-emerald-500/40 text-xs text-[#CBD5E1]"
                >
                  <KeyRound className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Use Seed Phrase</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setViewMode('recover-auth');
                    setError('');
                  }}
                  className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-[#090B0F] border border-white/10 hover:border-emerald-500/40 text-xs text-[#CBD5E1]"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Use Auth Recovery</span>
                </button>
              </div>
            </div>

            <div className="pt-2 border-t border-white/10 flex items-center justify-between text-xs text-[#8A94A6]">
              {!confirmReset ? (
                <button
                  type="button"
                  onClick={() => setConfirmReset(true)}
                  className="hover:text-red-400 transition-colors"
                >
                  Reset local browser cache
                </button>
              ) : (
                <div className="flex items-center justify-between w-full gap-2">
                  <span className="text-red-400">Clear local browser keys?</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmReset(false)}
                      className="px-2.5 py-1 rounded bg-white/5 hover:bg-white/10 text-[#CBD5E1]"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={onResetVault}
                      className="px-2.5 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-300"
                    >
                      Confirm Clear
                    </button>
                  </div>
                </div>
              )}
            </div>
          </form>
        )}

        {/* MODE 2: RECOVER WITH SEED PHRASE (DISPLAYS ASSETS FIRST -> PROMPT PASSWORD) */}
        {viewMode === 'recover-seed' && (
          <form onSubmit={handleSeedRecoverSubmit} className="p-6 space-y-4">
            <button
              type="button"
              onClick={() => {
                setViewMode('unlock');
                setError('');
              }}
              className="inline-flex items-center gap-1.5 text-xs text-[#8A94A6] hover:text-[#F4F6F9]"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to Password Unlock</span>
            </button>

            <div>
              <h2 className="text-sm font-semibold text-[#F4F6F9]">
                Recover Wallet with 12, 18, or 24-Word Seed Phrase
              </h2>
              <p className="text-xs text-[#8A94A6] mt-0.5">
                Verify your assets on-chain first, then set a new vault password.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="sm:col-span-2">
                <label className="block text-[11px] text-[#8A94A6] mb-1">
                  Recovery Seed Phrase
                </label>
                <textarea
                  rows={3}
                  value={seedPhraseInput}
                  onChange={(e) => setSeedPhraseInput(e.target.value)}
                  placeholder="Paste your 12, 18, or 24 BIP-39 words..."
                  spellCheck={false}
                  className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-xs text-[#F4F6F9] placeholder-[#525D70] focus:outline-none focus:border-emerald-500/60"
                />
              </div>
              <div>
                <label className="block text-[11px] text-[#8A94A6] mb-1">Derivation</label>
                <select
                  value={seedPreset}
                  onChange={(e) => setSeedPreset(e.target.value as WalletPresetId)}
                  className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-2.5 py-2 text-xs text-[#F4F6F9]"
                >
                  {WALLET_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name.split('/')[0].trim()}
                    </option>
                  ))}
                </select>
                {seedValidation.error && (
                  <p className="text-[11px] text-amber-400 mt-1.5">{seedValidation.error}</p>
                )}
              </div>
            </div>

            {/* ASSETS PREVIEW FIRST */}
            {recoveredPreviewAddresses && (
              <div className="p-4 rounded-lg bg-[#090B0F] border border-emerald-500/30 space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-emerald-400">
                    Recovered Wallet Assets
                  </span>
                  {scanningSeedAssets ? (
                    <span className="inline-flex items-center gap-1 font-mono text-[11px] text-[#8A94A6]">
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      Scanning...
                    </span>
                  ) : (
                    <span className="font-mono font-semibold text-[#F4F6F9] tabular-nums">
                      {formatFiat(seedTotalUsd)}
                    </span>
                  )}
                </div>
                <div className="font-mono text-[11px] text-[#8A94A6] space-y-0.5">
                  <div>EVM: {shortenAddress(recoveredPreviewAddresses.evmAddress, 8, 6)}</div>
                  <div>SOL: {shortenAddress(recoveredPreviewAddresses.solanaAddress, 8, 6)}</div>
                </div>
                {!scanningSeedAssets && (
                  <div className="pt-2 border-t border-white/10 space-y-1 max-h-32 overflow-y-auto">
                    {seedAssets.length === 0 ? (
                      <div className="text-[11px] text-[#64748B]">
                        Wallet checksum valid. 0 non-zero balances detected across scanned chains.
                      </div>
                    ) : (
                      seedAssets.map((h) => (
                        <div
                          key={`${h.networkId}-${h.symbol}`}
                          className="flex items-center justify-between text-xs font-mono"
                        >
                          <span className="text-[#F4F6F9]">
                            {formatCryptoAmount(h.balance)} {h.symbol}{' '}
                            <span className="text-[#64748B]">({h.networkName})</span>
                          </span>
                          <span className="text-emerald-400 tabular-nums">
                            {formatFiat(h.valueUsd)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Prompt to Create New Password After Assets Preview */}
            {recoveredPreviewAddresses && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="block text-[11px] text-[#8A94A6] mb-1">
                    Create New Vault Password
                  </label>
                  <input
                    type="password"
                    value={seedNewPassword}
                    onChange={(e) => setSeedNewPassword(e.target.value)}
                    placeholder="Minimum 6 characters"
                    required
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-[#8A94A6] mb-1">
                    Confirm New Password
                  </label>
                  <input
                    type="password"
                    value={seedConfirmPassword}
                    onChange={(e) => setSeedConfirmPassword(e.target.value)}
                    placeholder="Repeat password"
                    required
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9]"
                  />
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !recoveredPreviewAddresses}
              className="w-full py-2.5 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-sm transition-colors"
            >
              {loading ? 'Restoring & Encrypting...' : 'Set Password & Recover Wallet'}
            </button>
          </form>
        )}

        {/* MODE 3: RECOVER VIA NORMAL AUTH (DISPLAYS SYNCED ACCOUNTS & ASSETS FIRST) */}
        {viewMode === 'recover-auth' && (
          <form onSubmit={handleCompleteAuthRecovery} className="p-6 space-y-4">
            <button
              type="button"
              onClick={() => {
                setViewMode('unlock');
                setError('');
              }}
              className="inline-flex items-center gap-1.5 text-xs text-[#8A94A6] hover:text-[#F4F6F9]"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to Password Unlock</span>
            </button>

            <div>
              <h2 className="text-sm font-semibold text-[#F4F6F9]">
                Recover Vault via Verified Account Auth
              </h2>
              <p className="text-xs text-[#8A94A6] mt-0.5">
                Inspect your synced wallets and balances first, re-verify {authUser?.email}, and set a fresh session password to access your portfolio.
              </p>
            </div>

            {/* SYNCED WALLETS & ASSETS FIRST */}
            <div className="p-4 rounded-lg bg-[#090B0F] border border-white/10 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="inline-flex items-center gap-1.5 font-semibold text-[#F4F6F9]">
                  <Wallet className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{wallets.length} Synced Account{wallets.length === 1 ? '' : 's'}</span>
                </span>
                {scanningAuthAssets ? (
                  <span className="font-mono text-[11px] text-emerald-400">Scanning balances...</span>
                ) : (
                  <span className="font-mono font-semibold text-emerald-400 tabular-nums">
                    {formatFiat(authTotalUsd)}
                  </span>
                )}
              </div>

              <div className="space-y-1 max-h-24 overflow-y-auto text-[11px] font-mono text-[#8A94A6]">
                {wallets.map((w) => (
                  <div key={w.id} className="flex items-center justify-between">
                    <span className="text-[#CBD5E1] truncate">{w.name}</span>
                    <span>
                      {shortenAddress(
                        w.addresses.evmAddress ||
                          w.addresses.solanaAddress ||
                          w.addresses.bitcoinAddress ||
                          '',
                        6,
                        4
                      )}
                    </span>
                  </div>
                ))}
              </div>

              {authAssets.length > 0 && (
                <div className="pt-2 border-t border-white/10 space-y-1 max-h-28 overflow-y-auto">
                  {authAssets.map((h, i) => (
                    <div
                      key={`${h.networkId}-${h.symbol}-${i}`}
                      className="flex items-center justify-between text-[11px] font-mono"
                    >
                      <span className="text-[#F4F6F9]">
                        {formatCryptoAmount(h.balance)} {h.symbol}
                      </span>
                      <span className="text-emerald-400 tabular-nums">{formatFiat(h.valueUsd)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {!authReverified ? (
              <div className="space-y-3 p-3.5 rounded-lg bg-[#090B0F] border border-white/10">
                <div className="text-xs text-[#CBD5E1]">
                  Confirm ownership of <strong>{authUser?.email}</strong>
                </div>
                {!isGoogleUser && (
                  <input
                    type="password"
                    value={authVerifyPassword}
                    onChange={(e) => setAuthVerifyPassword(e.target.value)}
                    placeholder="Enter your Firebase account login password"
                    className="w-full bg-[#11151C] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9]"
                  />
                )}
                <button
                  type="button"
                  disabled={loading}
                  onClick={handleReverifyAccount}
                  className="w-full py-2 px-3 rounded-lg bg-[#1A2130] hover:bg-[#232C3F] border border-emerald-500/40 text-xs font-semibold text-emerald-400"
                >
                  {loading
                    ? 'Verifying...'
                    : isGoogleUser
                    ? 'Re-Authenticate with Google'
                    : 'Verify Account Password'}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-xs text-emerald-400">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Account ownership verified. Create your new Vault Password:</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input
                    type="password"
                    value={authNewPassword}
                    onChange={(e) => setAuthNewPassword(e.target.value)}
                    placeholder="New Vault Password (min 6 chars)"
                    required
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9]"
                  />
                  <input
                    type="password"
                    value={authConfirmPassword}
                    onChange={(e) => setAuthConfirmPassword(e.target.value)}
                    placeholder="Confirm Vault Password"
                    required
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9]"
                  />
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {authReverified && (
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] font-semibold text-sm transition-colors"
              >
                {loading ? 'Opening Vault...' : 'Open Portfolio & Assets'}
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
