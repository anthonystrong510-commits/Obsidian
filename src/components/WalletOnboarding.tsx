import { useMemo, useState, type ClipboardEvent } from 'react';
import {
  Check,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wallet,
  X,
} from 'lucide-react';
import {
  BIP39_WORDLIST,
  BIP39_WORD_SET,
  deriveWalletFromMnemonic,
  deriveWalletFromPrivateKey,
  generateMnemonicWords,
  isValidBitcoinAddress,
  isValidSolanaAddress,
  normalizePhrase,
  shortenAddress,
  validateMnemonicPhrase,
} from '../lib/crypto';
import { WALLET_PRESETS } from '../lib/networks';
import { isAddress } from 'ethers';
import { resolveEnsAddress } from '../lib/web3Service';
import {
  createVaultVerifier,
  encryptPayload,
  hasVaultPassword,
  verifyVaultPassword,
} from '../lib/vaultStorage';
import type { UnlockedSecrets, WalletAccount, WalletPresetId } from '../types/wallet';

type OnboardingTab = 'create' | 'import-seed' | 'import-key' | 'watch';

interface WalletOnboardingProps {
  mode: 'fullPage' | 'modal';
  existingPassword?: string;
  onComplete: (
    wallet: WalletAccount,
    secrets: UnlockedSecrets,
    passwordUsed: string
  ) => void;
  onClose?: () => void;
}

export function WalletOnboarding({
  mode,
  existingPassword,
  onComplete,
  onClose,
}: WalletOnboardingProps) {
  const [tab, setTab] = useState<OnboardingTab>('create');

  // Create Wallet State
  const [createWordCount, setCreateWordCount] = useState<12 | 18 | 24>(12);
  const [generatedWords, setGeneratedWords] = useState<string[]>(() =>
    generateMnemonicWords(12)
  );
  const [createWalletName, setCreateWalletName] = useState('Main Multi-Chain Vault');
  const [copiedPhrase, setCopiedPhrase] = useState(false);
  const [revealCreateWords, setRevealCreateWords] = useState(true);
  const [backupConfirmed, setBackupConfirmed] = useState(false);

  // Import Seed Phrase State (12 / 18 / 24 words)
  const [importPreset, setImportPreset] = useState<WalletPresetId>('metamask');
  const [importWordCount, setImportWordCount] = useState<12 | 18 | 24>(12);
  const [importWords, setImportWords] = useState<string[]>(() => Array(24).fill(''));
  const [focusedWordIndex, setFocusedWordIndex] = useState<number | null>(null);
  const [importWalletName, setImportWalletName] = useState('Imported Wallet');
  const [passphrase, setPassphrase] = useState('');
  const [accountIndex, setAccountIndex] = useState(0);
  const [showAdvancedPath, setShowAdvancedPath] = useState(false);
  const [customEvmPath, setCustomEvmPath] = useState('');

  // Import Private Key State
  const [privateKeyInput, setPrivateKeyInput] = useState('');
  const [keyWalletName, setKeyWalletName] = useState('Imported Key');

  // Watch-Only / ENS State
  const [watchInput, setWatchInput] = useState('');
  const [watchName, setWatchName] = useState('Watch Portfolio');
  const [watchResolving, setWatchResolving] = useState(false);

  // Vault Password State
  const needsNewPassword = !hasVaultPassword() && !existingPassword;
  const [password, setPassword] = useState(existingPassword || '');
  const [confirmPassword, setConfirmPassword] = useState(existingPassword || '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleRegenerateWords = (count: 12 | 18 | 24) => {
    setCreateWordCount(count);
    setGeneratedWords(generateMnemonicWords(count));
    setBackupConfirmed(false);
    setCopiedPhrase(false);
  };

  const handleSelectPreset = (presetId: WalletPresetId) => {
    setImportPreset(presetId);
    const preset = WALLET_PRESETS.find((p) => p.id === presetId);
    if (preset) {
      setImportWordCount(preset.defaultWords);
      setImportWalletName(`${preset.name.split('/')[0].trim()} Import`);
    }
  };

  const handleWordCountSwitch = (count: 12 | 18 | 24) => {
    setImportWordCount(count);
  };

  const handleWordChange = (idx: number, val: string) => {
    // Handle multi-word paste into input
    const cleaned = val.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (cleaned.length > 1) {
      applyBulkPhrase(cleaned);
      return;
    }
    setImportWords((prev) => {
      const next = [...prev];
      next[idx] = val.toLowerCase().replace(/[^a-z]/g, '');
      return next;
    });
  };

  const applyBulkPhrase = (words: string[]) => {
    const clean = words.map((w) => w.toLowerCase().replace(/[^a-z]/g, '')).filter(Boolean);
    let targetCount: 12 | 18 | 24 = importWordCount;
    if (clean.length <= 12) targetCount = 12;
    else if (clean.length <= 18) targetCount = 18;
    else targetCount = 24;

    setImportWordCount(targetCount);
    setImportWords(() => {
      const next = Array(24).fill('');
      for (let i = 0; i < Math.min(clean.length, 24); i++) {
        next[i] = clean[i];
      }
      return next;
    });
    setFocusedWordIndex(null);
  };

  const handleWordPaste = (e: ClipboardEvent<HTMLInputElement>, idx: number) => {
    const text = e.clipboardData.getData('text');
    const tokens = normalizePhrase(text).split(' ').filter(Boolean);
    if (tokens.length > 1) {
      e.preventDefault();
      applyBulkPhrase(tokens);
    } else if (tokens.length === 1) {
      e.preventDefault();
      handleWordChange(idx, tokens[0]);
    }
  };

  const activeImportSlice = useMemo(
    () => importWords.slice(0, importWordCount),
    [importWords, importWordCount]
  );

  const importValidation = useMemo(() => {
    const joined = activeImportSlice.join(' ').trim();
    const filledCount = activeImportSlice.filter(Boolean).length;
    if (filledCount < importWordCount) {
      return { valid: false, filledCount, error: `${filledCount}/${importWordCount} words entered` };
    }
    const res = validateMnemonicPhrase(joined);
    return { ...res, filledCount };
  }, [activeImportSlice, importWordCount]);

  const importPreviewAddresses = useMemo(() => {
    if (!importValidation.valid) return null;
    try {
      return deriveWalletFromMnemonic(activeImportSlice.join(' '), {
        preset: importPreset,
        accountIndex,
        passphrase,
        customEvmPath,
      }).addresses;
    } catch {
      return null;
    }
  }, [importValidation.valid, activeImportSlice, importPreset, accountIndex, passphrase, customEvmPath]);

  const createPreviewAddresses = useMemo(() => {
    try {
      return deriveWalletFromMnemonic(generatedWords.join(' '), {
        preset: 'standard',
        accountIndex: 0,
      }).addresses;
    } catch {
      return null;
    }
  }, [generatedWords]);

  const wordSuggestions = useMemo(() => {
    if (focusedWordIndex === null) return [];
    const current = importWords[focusedWordIndex]?.trim().toLowerCase() || '';
    if (!current || BIP39_WORD_SET.has(current)) return [];
    return BIP39_WORDLIST.filter((w) => w.startsWith(current)).slice(0, 6);
  }, [focusedWordIndex, importWords]);

  const validateAndPreparePassword = async (): Promise<string | null> => {
    const activePw = existingPassword || password;
    if (!activePw || activePw.length < 6) {
      setError('Vault password must be at least 6 characters.');
      return null;
    }
    if (needsNewPassword) {
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return null;
      }
      await createVaultVerifier(activePw);
    } else {
      const ok = await verifyVaultPassword(activePw);
      if (!ok) {
        setError('Vault password is incorrect.');
        return null;
      }
    }
    return activePw;
  };

  const handleFinishCreate = async () => {
    setError('');
    if (!backupConfirmed) {
      setError('Confirm you have safely stored your recovery phrase before continuing.');
      return;
    }
    setSubmitting(true);
    try {
      const pw = await validateAndPreparePassword();
      if (!pw) {
        setSubmitting(false);
        return;
      }
      const phrase = generatedWords.join(' ');
      const derived = deriveWalletFromMnemonic(phrase, {
        preset: 'standard',
        accountIndex: 0,
      });
      const encryptedSecret = await encryptPayload(derived.secrets, pw);
      const wallet: WalletAccount = {
        id: crypto.randomUUID(),
        name: createWalletName.trim() || 'Main Multi-Chain Vault',
        type: 'mnemonic',
        wordCount: createWordCount,
        preset: 'standard',
        accountIndex: 0,
        addresses: derived.addresses,
        encryptedSecret,
        createdAt: Date.now(),
      };
      onComplete(wallet, derived.secrets, pw);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create vault.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleFinishImportSeed = async () => {
    setError('');
    if (!importValidation.valid) {
      setError(importValidation.error || 'Enter a valid 12, 18, or 24-word BIP-39 phrase.');
      return;
    }
    setSubmitting(true);
    try {
      const pw = await validateAndPreparePassword();
      if (!pw) {
        setSubmitting(false);
        return;
      }
      const phrase = activeImportSlice.join(' ');
      const derived = deriveWalletFromMnemonic(phrase, {
        preset: importPreset,
        accountIndex,
        passphrase,
        customEvmPath,
      });
      const encryptedSecret = await encryptPayload(derived.secrets, pw);
      const wallet: WalletAccount = {
        id: crypto.randomUUID(),
        name: importWalletName.trim() || 'Imported Wallet',
        type: 'mnemonic',
        wordCount: importWordCount,
        preset: importPreset,
        accountIndex,
        addresses: derived.addresses,
        encryptedSecret,
        createdAt: Date.now(),
      };
      onComplete(wallet, derived.secrets, pw);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to import seed phrase.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleFinishImportKey = async () => {
    setError('');
    setSubmitting(true);
    try {
      const derived = deriveWalletFromPrivateKey(privateKeyInput);
      const pw = await validateAndPreparePassword();
      if (!pw) {
        setSubmitting(false);
        return;
      }
      const encryptedSecret = await encryptPayload(derived.secrets, pw);
      const wallet: WalletAccount = {
        id: crypto.randomUUID(),
        name: keyWalletName.trim() || 'Imported Key',
        type: 'privateKey',
        accountIndex: 0,
        addresses: derived.addresses,
        encryptedSecret,
        createdAt: Date.now(),
      };
      onComplete(wallet, derived.secrets, pw);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid private key format.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleFinishWatch = async (overrideInput?: string, overrideName?: string) => {
    setError('');
    const target = (overrideInput ?? watchInput).trim();
    if (!target) {
      setError('Enter an EVM address, ENS name (e.g. vitalik.eth), Solana, or Bitcoin address.');
      return;
    }
    setWatchResolving(true);
    try {
      let evmAddress = '';
      let solanaAddress = '';
      let bitcoinAddress = '';
      let resolvedLabel = overrideName || watchName;

      if (target.includes('.')) {
        const resolved = await resolveEnsAddress(target);
        if (!resolved) {
          throw new Error(`Could not resolve ENS name "${target}".`);
        }
        evmAddress = resolved;
        if (resolvedLabel === 'Watch Portfolio' || !overrideName) {
          resolvedLabel = target;
        }
      } else if (isAddress(target)) {
        evmAddress = target;
      } else if (isValidSolanaAddress(target)) {
        solanaAddress = target;
      } else if (isValidBitcoinAddress(target)) {
        bitcoinAddress = target;
      } else {
        throw new Error('Unrecognized address format. Supports ENS, 0x EVM, Solana, or Bitcoin.');
      }

      const pw = await validateAndPreparePassword();
      if (!pw) {
        setWatchResolving(false);
        return;
      }

      const wallet: WalletAccount = {
        id: crypto.randomUUID(),
        name: resolvedLabel.trim() || 'Watch Portfolio',
        type: 'watchOnly',
        accountIndex: 0,
        addresses: {
          evmAddress,
          evmPath: 'Watch-Only',
          solanaAddress,
          solanaPath: 'Watch-Only',
          bitcoinAddress,
          bitcoinPath: 'Watch-Only',
        },
        createdAt: Date.now(),
      };
      onComplete(wallet, {}, pw);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add watch address.');
    } finally {
      setWatchResolving(false);
    }
  };

  const handleCopyPhrase = async () => {
    await navigator.clipboard.writeText(generatedWords.join(' '));
    setCopiedPhrase(true);
    setTimeout(() => setCopiedPhrase(false), 2000);
  };

  const content = (
    <div className="bg-[#11151C] border border-white/10 rounded-xl overflow-hidden w-full max-w-5xl mx-auto">
      {/* Header */}
      <div className="px-6 py-5 border-b border-white/10 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
            <Wallet className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-[#F4F6F9]">
              {mode === 'fullPage' ? 'Initialize Obsidian Vault' : 'Add or Import Wallet'}
            </h2>
            <p className="text-xs text-[#8A94A6]">
              <span>Non-custodial multi-chain derivation</span>
              <span className="mx-1.5 text-white/20">·</span>
              <span>EVM, Solana & Bitcoin</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 p-1 bg-[#090B0F] border border-white/10 rounded-lg overflow-x-auto">
            {(
              [
                { id: 'create', label: 'Create New' },
                { id: 'import-seed', label: 'Import 12/18/24 Phrase' },
                { id: 'import-key', label: 'Private Key' },
                { id: 'watch', label: 'Watch / ENS' },
              ] as Array<{ id: OnboardingTab; label: string }>
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setTab(item.id);
                  setError('');
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  tab === item.id
                    ? 'bg-[#1D2432] text-[#F4F6F9]'
                    : 'text-[#8A94A6] hover:text-[#F4F6F9]'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg text-[#8A94A6] hover:text-[#F4F6F9] hover:bg-white/5"
              aria-label="Close modal"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="grid grid-cols-1 lg:grid-cols-12 items-stretch">
        {/* Left / Main Interactive Panel */}
        <div className="lg:col-span-8 p-6 space-y-6">
          {tab === 'create' && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-[#F4F6F9]">
                    Generate Cryptographic Recovery Phrase
                  </h3>
                  <p className="text-xs text-[#8A94A6] mt-0.5">
                    Select entropy strength. One phrase derives keys across all 10 networks.
                  </p>
                </div>
                <div className="flex items-center gap-1 p-1 bg-[#090B0F] border border-white/10 rounded-lg">
                  {([12, 18, 24] as const).map((cnt) => (
                    <button
                      key={cnt}
                      type="button"
                      onClick={() => handleRegenerateWords(cnt)}
                      className={`px-2.5 py-1 text-xs font-mono font-medium rounded transition-colors whitespace-nowrap ${
                        createWordCount === cnt
                          ? 'bg-emerald-500 text-[#090B0F]'
                          : 'text-[#8A94A6] hover:text-[#F4F6F9]'
                      }`}
                    >
                      {cnt} Words
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1.5">Wallet Label</label>
                  <input
                    type="text"
                    value={createWalletName}
                    onChange={(e) => setCreateWalletName(e.target.value)}
                    placeholder="e.g. Hardware Cold Vault"
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-sm text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
                  />
                </div>
                <div className="flex items-end justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setRevealCreateWords((v) => !v)}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#CBD5E1] hover:bg-white/5 whitespace-nowrap"
                  >
                    {revealCreateWords ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    <span>{revealCreateWords ? 'Hide' : 'Reveal'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRegenerateWords(createWordCount)}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#CBD5E1] hover:bg-white/5 whitespace-nowrap"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>New Entropy</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyPhrase}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#CBD5E1] hover:bg-white/5 whitespace-nowrap"
                  >
                    {copiedPhrase ? (
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

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {generatedWords.map((word, idx) => (
                  <div
                    key={`${idx}-${word}`}
                    className="flex items-center gap-2 bg-[#090B0F] border border-white/10 rounded-lg px-2.5 py-2"
                  >
                    <span className="text-[11px] font-mono text-[#64748B] w-5 select-none">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    <span className="font-mono text-xs text-[#F4F6F9] tracking-wide">
                      {revealCreateWords ? word : '••••••'}
                    </span>
                  </div>
                ))}
              </div>

              <label className="flex items-start gap-2.5 p-3 rounded-lg bg-[#090B0F] border border-white/10 cursor-pointer">
                <input
                  type="checkbox"
                  checked={backupConfirmed}
                  onChange={(e) => setBackupConfirmed(e.target.checked)}
                  className="mt-0.5 rounded border-white/20 bg-[#11151C] text-emerald-500 focus:ring-emerald-500"
                />
                <span className="text-xs text-[#CBD5E1] leading-relaxed">
                  I have backed up this {createWordCount}-word secret recovery phrase offline. Obsidian Vault encrypts keys locally in this browser and cannot recover lost phrases.
                </span>
              </label>
            </div>
          )}

          {tab === 'import-seed' && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-[#F4F6F9]">
                    Import from Any Wallet
                  </h3>
                  <p className="text-xs text-[#8A94A6] mt-0.5">
                    Select source wallet derivation preset and paste or type 12, 18, or 24 BIP-39 words.
                  </p>
                </div>
                <div className="flex items-center gap-1 p-1 bg-[#090B0F] border border-white/10 rounded-lg">
                  {([12, 18, 24] as const).map((cnt) => (
                    <button
                      key={cnt}
                      type="button"
                      onClick={() => handleWordCountSwitch(cnt)}
                      className={`px-2.5 py-1 text-xs font-mono font-medium rounded transition-colors whitespace-nowrap ${
                        importWordCount === cnt
                          ? 'bg-emerald-500 text-[#090B0F]'
                          : 'text-[#8A94A6] hover:text-[#F4F6F9]'
                      }`}
                    >
                      {cnt} Words
                    </button>
                  ))}
                </div>
              </div>

              {/* Creative Wallet Preset Selector */}
              <div>
                <span className="block text-xs text-[#8A94A6] mb-2">
                  Source Wallet Ecosystem
                </span>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {WALLET_PRESETS.slice(0, 4).map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => handleSelectPreset(preset.id)}
                      className={`text-left px-3 py-2 rounded-lg border transition-colors ${
                        importPreset === preset.id
                          ? 'bg-emerald-500/10 border-emerald-500/50 text-[#F4F6F9]'
                          : 'bg-[#090B0F] border-white/10 text-[#8A94A6] hover:text-[#F4F6F9]'
                      }`}
                    >
                      <div className="text-xs font-medium truncate">
                        {preset.name.split('/')[0].trim()}
                      </div>
                      <div className="text-[11px] font-mono text-[#64748B] truncate mt-0.5">
                        {preset.defaultWords}w · {preset.evmPathTemplate(0)}
                      </div>
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-2 mt-2">
                  {WALLET_PRESETS.slice(4).map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => handleSelectPreset(preset.id)}
                      className={`text-left px-3 py-2 rounded-lg border transition-colors ${
                        importPreset === preset.id
                          ? 'bg-emerald-500/10 border-emerald-500/50 text-[#F4F6F9]'
                          : 'bg-[#090B0F] border-white/10 text-[#8A94A6] hover:text-[#F4F6F9]'
                      }`}
                    >
                      <div className="text-xs font-medium truncate">
                        {preset.name.split('/')[0].trim()}
                      </div>
                      <div className="text-[11px] font-mono text-[#64748B] truncate mt-0.5">
                        {preset.defaultWords}w standard
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1">Wallet Name</label>
                  <input
                    type="text"
                    value={importWalletName}
                    onChange={(e) => setImportWalletName(e.target.value)}
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-sm text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
                  />
                </div>
                <div className="flex items-end justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const sample = generateMnemonicWords(importWordCount);
                      applyBulkPhrase(sample);
                    }}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#CBD5E1] hover:bg-white/5 whitespace-nowrap"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Fill Demo {importWordCount}-Word Phrase</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setImportWords(Array(24).fill(''))}
                    className="px-3 py-2 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#8A94A6] hover:text-[#F4F6F9] whitespace-nowrap"
                  >
                    Clear
                  </button>
                </div>
              </div>

              {/* Word Grid with Smart Paste & BIP-39 Autocomplete */}
              <div className="relative">
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                  {activeImportSlice.map((word, idx) => {
                    const isFilled = word.trim().length > 0;
                    const isWordValid = !isFilled || BIP39_WORD_SET.has(word.trim());
                    return (
                      <div
                        key={idx}
                        className={`flex items-center gap-1.5 bg-[#090B0F] border rounded-lg px-2.5 py-1.5 transition-colors ${
                          focusedWordIndex === idx
                            ? 'border-emerald-500/70'
                            : !isWordValid
                            ? 'border-red-500/60'
                            : isFilled && isWordValid
                            ? 'border-emerald-500/25'
                            : 'border-white/10'
                        }`}
                      >
                        <span className="text-[11px] font-mono text-[#64748B] w-5 select-none">
                          {String(idx + 1).padStart(2, '0')}
                        </span>
                        <input
                          type="text"
                          value={word}
                          onFocus={() => setFocusedWordIndex(idx)}
                          onBlur={() => setTimeout(() => setFocusedWordIndex(null), 150)}
                          onChange={(e) => handleWordChange(idx, e.target.value)}
                          onPaste={(e) => handleWordPaste(e, idx)}
                          placeholder="word"
                          autoComplete="off"
                          spellCheck={false}
                          className="w-full bg-transparent font-mono text-xs text-[#F4F6F9] placeholder-[#3B4454] focus:outline-none"
                        />
                      </div>
                    );
                  })}
                </div>

                {/* Autocomplete Suggestions Bar */}
                {wordSuggestions.length > 0 && focusedWordIndex !== null && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-[#8A94A6] mr-1">Suggestions:</span>
                    {wordSuggestions.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          handleWordChange(focusedWordIndex, suggestion);
                          setFocusedWordIndex(null);
                        }}
                        className="px-2.5 py-1 rounded bg-[#1A2130] hover:bg-emerald-500 hover:text-[#090B0F] font-mono text-xs text-[#F4F6F9] transition-colors"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                )}

                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span
                    className={
                      importValidation.valid
                        ? 'text-emerald-400 flex items-center gap-1.5'
                        : 'text-[#8A94A6]'
                    }
                  >
                    {importValidation.valid && <ShieldCheck className="w-3.5 h-3.5" />}
                    <span>
                      {importValidation.valid
                        ? `Valid ${importWordCount}-word BIP-39 checksum verified`
                        : importValidation.error}
                    </span>
                  </span>

                  <button
                    type="button"
                    onClick={() => setShowAdvancedPath((v) => !v)}
                    className="text-[#8A94A6] hover:text-[#F4F6F9] underline-offset-2 hover:underline"
                  >
                    {showAdvancedPath ? 'Hide derivation options' : 'Passphrase & custom path'}
                  </button>
                </div>

                {showAdvancedPath && (
                  <div className="mt-3 pt-3 border-t border-white/10 grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[11px] text-[#8A94A6] mb-1">
                        BIP-39 Passphrase (Optional)
                      </label>
                      <input
                        type="password"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        placeholder="25th word"
                        className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-[#8A94A6] mb-1">
                        HD Account Index
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={20}
                        value={accountIndex}
                        onChange={(e) => setAccountIndex(Math.max(0, Number(e.target.value)))}
                        className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-1.5 font-mono text-xs text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-[#8A94A6] mb-1">
                        Custom EVM Path
                      </label>
                      <input
                        type="text"
                        value={customEvmPath}
                        onChange={(e) => setCustomEvmPath(e.target.value)}
                        placeholder="m/44'/60'/0'/0/0"
                        className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-1.5 font-mono text-xs text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === 'import-key' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-base font-semibold text-[#F4F6F9]">
                  Import Raw Private Key
                </h3>
                <p className="text-xs text-[#8A94A6] mt-0.5">
                  Supports 64-character EVM hex keys (Ethereum, Arbitrum, Base, Polygon, BSC) and Solana Base58 secret keys.
                </p>
              </div>
              <div>
                <label className="block text-xs text-[#8A94A6] mb-1.5">Wallet Label</label>
                <input
                  type="text"
                  value={keyWalletName}
                  onChange={(e) => setKeyWalletName(e.target.value)}
                  className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-sm text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
                />
              </div>
              <div>
                <label className="block text-xs text-[#8A94A6] mb-1.5">Private Key</label>
                <textarea
                  rows={3}
                  value={privateKeyInput}
                  onChange={(e) => setPrivateKeyInput(e.target.value)}
                  placeholder="0x... or Base58 Solana secret key"
                  spellCheck={false}
                  className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2.5 font-mono text-xs text-[#F4F6F9] placeholder-[#525D70] focus:outline-none focus:border-emerald-500/60"
                />
              </div>
            </div>
          )}

          {tab === 'watch' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-base font-semibold text-[#F4F6F9]">
                  Watch-Only Portfolio & ENS Tracker
                </h3>
                <p className="text-xs text-[#8A94A6] mt-0.5">
                  Track real live Web3 on-chain balances for any public address or ENS domain without exposing keys.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1.5">Portfolio Name</label>
                  <input
                    type="text"
                    value={watchName}
                    onChange={(e) => setWatchName(e.target.value)}
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-sm text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1.5">
                    Address or ENS Domain
                  </label>
                  <input
                    type="text"
                    value={watchInput}
                    onChange={(e) => setWatchInput(e.target.value)}
                    placeholder="vitalik.eth, 0x..., bc1q..., or Solana address"
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-xs text-[#F4F6F9] placeholder-[#525D70] focus:outline-none focus:border-emerald-500/60"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-xs text-[#8A94A6]">Quick Web3 Live Demo:</span>
                <button
                  type="button"
                  onClick={() => {
                    setWatchInput('vitalik.eth');
                    setWatchName('vitalik.eth (Live Watch)');
                  }}
                  className="px-3 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 hover:border-emerald-500/50 text-xs font-mono text-emerald-400 transition-colors"
                >
                  Load vitalik.eth
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWatchInput('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh');
                    setWatchName('Bitcoin Taproot/SegWit Watch');
                  }}
                  className="px-3 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 hover:border-emerald-500/50 text-xs font-mono text-[#CBD5E1] transition-colors"
                >
                  Load BTC Mainnet Address
                </button>
              </div>
            </div>
          )}

          {/* Vault Password Section */}
          <div className="pt-4 border-t border-white/10 space-y-3">
            {needsNewPassword ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1">
                    Create Vault Password (min 6 chars)
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Encrypts seeds in browser"
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-sm text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1">
                    Confirm Vault Password
                  </label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repeat password"
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-sm text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
                  />
                </div>
              </div>
            ) : !existingPassword ? (
              <div>
                <label className="block text-xs text-[#8A94A6] mb-1">
                  Vault Password (to encrypt new wallet)
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your existing vault password"
                  className="w-full max-w-sm bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-sm text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
                />
              </div>
            ) : null}

            {error && (
              <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <div className="flex items-center justify-end gap-3 pt-1">
              {tab === 'create' && (
                <button
                  type="button"
                  disabled={submitting}
                  onClick={handleFinishCreate}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-sm transition-colors whitespace-nowrap"
                >
                  <Plus className="w-4 h-4" />
                  <span>{submitting ? 'Encrypting Vault...' : 'Create & Open Vault'}</span>
                </button>
              )}
              {tab === 'import-seed' && (
                <button
                  type="button"
                  disabled={submitting}
                  onClick={handleFinishImportSeed}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-sm transition-colors whitespace-nowrap"
                >
                  <KeyRound className="w-4 h-4" />
                  <span>{submitting ? 'Deriving Keys...' : 'Import & Derive Multi-Chain'}</span>
                </button>
              )}
              {tab === 'import-key' && (
                <button
                  type="button"
                  disabled={submitting}
                  onClick={handleFinishImportKey}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-sm transition-colors whitespace-nowrap"
                >
                  <ChevronRight className="w-4 h-4" />
                  <span>{submitting ? 'Importing...' : 'Import Private Key'}</span>
                </button>
              )}
              {tab === 'watch' && (
                <button
                  type="button"
                  disabled={watchResolving}
                  onClick={() => handleFinishWatch()}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-sm transition-colors whitespace-nowrap"
                >
                  <ChevronRight className="w-4 h-4" />
                  <span>{watchResolving ? 'Resolving On-Chain...' : 'Track Live Portfolio'}</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Right Preview & Hardware Artwork Column */}
        <div className="lg:col-span-4 bg-[#0D1017] border-t lg:border-t-0 lg:border-l border-white/10 p-6 flex flex-col justify-between gap-6">
          <div className="space-y-4">
            <div className="relative h-40 rounded-lg overflow-hidden border border-white/10 bg-[#090B0F]">
              <img
                src="/src/assets/images/vault_monolith_hero_1794846319768.jpg"
                alt="Titanium cryptography hardware vault"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover opacity-85"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#0D1017] via-transparent to-transparent" />
            </div>

            <div>
              <h4 className="text-sm font-semibold text-[#F4F6F9]">
                Live Derived Chain Addresses
              </h4>
              <p className="text-xs text-[#8A94A6] mt-1 leading-relaxed">
                Generated deterministically in-memory using BIP-39, BIP-44, SLIP-0010, and BIP-84 standards.
              </p>
            </div>

            {(() => {
              const preview =
                tab === 'create'
                  ? createPreviewAddresses
                  : tab === 'import-seed'
                  ? importPreviewAddresses
                  : null;

              if (!preview) {
                return (
                  <div className="p-4 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#64748B]">
                    {tab === 'import-seed'
                      ? 'Complete all 12, 18, or 24 valid BIP-39 words to preview derived EVM, Solana, and Bitcoin addresses.'
                      : 'Addresses are derived across Ethereum, Arbitrum, Base, Optimism, Polygon, BNB, Avalanche, Solana, and Bitcoin.'}
                  </div>
                );
              }

              return (
                <div className="space-y-2.5">
                  <div className="p-3 rounded-lg bg-[#090B0F] border border-white/10">
                    <div className="flex items-center justify-between text-[11px] text-[#8A94A6]">
                      <span>EVM (ETH / ARB / BASE / POL)</span>
                      <span className="font-mono">{preview.evmPath}</span>
                    </div>
                    <div className="font-mono text-xs text-[#F4F6F9] mt-1 truncate">
                      {shortenAddress(preview.evmAddress, 10, 8)}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-[#090B0F] border border-white/10">
                    <div className="flex items-center justify-between text-[11px] text-[#8A94A6]">
                      <span>Solana (Ed25519)</span>
                      <span className="font-mono">{preview.solanaPath}</span>
                    </div>
                    <div className="font-mono text-xs text-emerald-400 mt-1 truncate">
                      {shortenAddress(preview.solanaAddress, 10, 8)}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-[#090B0F] border border-white/10">
                    <div className="flex items-center justify-between text-[11px] text-[#8A94A6]">
                      <span>Bitcoin (SegWit bc1q)</span>
                      <span className="font-mono">{preview.bitcoinPath}</span>
                    </div>
                    <div className="font-mono text-xs text-amber-400 mt-1 truncate">
                      {shortenAddress(preview.bitcoinAddress, 10, 8)}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>

          <div className="pt-4 border-t border-white/10 text-[11px] text-[#64748B] space-y-1">
            <p>Zero server-side key transmission.</p>
            <p>All private keys encrypted via PBKDF2 + AES-256-GCM.</p>
          </div>
        </div>
      </div>
    </div>
  );

  if (mode === 'modal') {
    return (
      <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
        <div className="w-full max-w-5xl my-8">{content}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#090B0F] text-[#F4F6F9] flex items-center justify-center p-4 sm:p-8">
      {content}
    </div>
  );
}
