import { useEffect, useState } from 'react';
import { Wallet } from 'ethers';
import QRCode from 'qrcode';
import {
  BookUser,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Plus,
  QrCode,
  Shield,
  Trash2,
} from 'lucide-react';
import { deriveWalletFromMnemonic, shortenAddress } from '../lib/crypto';
import { unlockWalletSecrets, verifyVaultPassword } from '../lib/vaultStorage';
import type {
  AddressBookEntry,
  NetworkFamily,
  UnlockedSecrets,
  WalletAccount,
} from '../types/wallet';

interface SecurityViewProps {
  wallets: WalletAccount[];
  activeWallet: WalletAccount;
  secrets: UnlockedSecrets;
  addressBook: AddressBookEntry[];
  currency: 'USD' | 'EUR' | 'GBP';
  onChangeCurrency: (c: 'USD' | 'EUR' | 'GBP') => void;
  onSelectWallet: (id: string) => void;
  onDeriveSubAccount: (parentWallet: WalletAccount) => Promise<void>;
  onDeleteWallet: (id: string) => void;
  onAddWalletClick: () => void;
  onLockVault: () => void;
  onAddContact: (entry: AddressBookEntry) => void;
  onDeleteContact: (id: string) => void;
}

export function SecurityView({
  wallets,
  activeWallet,
  secrets,
  addressBook,
  currency,
  onChangeCurrency,
  onSelectWallet,
  onDeriveSubAccount,
  onDeleteWallet,
  onAddWalletClick,
  onLockVault,
  onAddContact,
  onDeleteContact,
}: SecurityViewProps) {
  const [revealPassword, setRevealPassword] = useState('');
  const [revealedSecrets, setRevealedSecrets] = useState<UnlockedSecrets | null>(null);
  const [revealError, setRevealError] = useState('');
  const [copiedId, setCopiedId] = useState('');
  const [exportingKeystore, setExportingKeystore] = useState(false);
  const [derivingSub, setDerivingSub] = useState(false);
  const [qrTargetValue, setQrTargetValue] = useState<{ label: string; value: string } | null>(null);
  const [qrImageUrl, setQrImageUrl] = useState('');

  // Address Book state
  const [contactLabel, setContactLabel] = useState('');
  const [contactAddress, setContactAddress] = useState('');
  const [contactFamily, setContactFamily] = useState<NetworkFamily>('evm');

  // Reset revealed keys if active wallet switches
  useEffect(() => {
    setRevealedSecrets(null);
    setRevealPassword('');
    setRevealError('');
    setQrTargetValue(null);
  }, [activeWallet.id]);

  useEffect(() => {
    if (!qrTargetValue) {
      setQrImageUrl('');
      return;
    }
    QRCode.toDataURL(qrTargetValue.value, {
      width: 180,
      margin: 2,
      color: { dark: '#090B0F', light: '#FFFFFF' },
    })
      .then(setQrImageUrl)
      .catch(() => setQrImageUrl(''));
  }, [qrTargetValue]);

  const handleRevealKeys = async () => {
    setRevealError('');
    if (!revealPassword) {
      setRevealError('Enter your vault password to decrypt and inspect private keys.');
      return;
    }

    try {
      if (activeWallet.encryptedSecret) {
        const decrypted = await unlockWalletSecrets(activeWallet, revealPassword);
        if (
          activeWallet.type === 'mnemonic' &&
          decrypted.mnemonic &&
          (!decrypted.moneroSpendKeyHex || !decrypted.moneroViewKeyHex)
        ) {
          const derived = deriveWalletFromMnemonic(decrypted.mnemonic, {
            preset: activeWallet.preset || 'standard',
            accountIndex: activeWallet.accountIndex || 0,
            passphrase: decrypted.passphrase,
          });
          setRevealedSecrets({
            ...decrypted,
            moneroSpendKeyHex: derived.secrets.moneroSpendKeyHex,
            moneroViewKeyHex: derived.secrets.moneroViewKeyHex,
          });
        } else {
          setRevealedSecrets(decrypted);
        }
      } else {
        const verifierOk = await verifyVaultPassword(revealPassword);
        if (!verifierOk) {
          setRevealError('Incorrect vault password.');
          return;
        }
        setRevealedSecrets(secrets);
      }
      setRevealPassword('');
    } catch {
      setRevealError('Incorrect password or unable to decrypt this wallet.');
    }
  };

  const handleCopy = async (id: string, val: string) => {
    await navigator.clipboard.writeText(val);
    setCopiedId(id);
    setTimeout(() => setCopiedId(''), 1800);
  };

  const handleExportKeystore = async () => {
    const evmKey = revealedSecrets?.evmPrivateKey || secrets.evmPrivateKey;
    if (!evmKey) return;
    const pw = prompt('Enter an encryption password for the exported UTC JSON keystore:');
    if (!pw || pw.length < 6) return;
    setExportingKeystore(true);
    try {
      const w = new Wallet(evmKey);
      const json = await w.encrypt(pw);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `obsidian-keystore-${w.address.slice(2, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExportingKeystore(false);
    }
  };

  const handleCreateContact = () => {
    if (!contactLabel.trim() || !contactAddress.trim()) return;
    onAddContact({
      id: crypto.randomUUID(),
      label: contactLabel.trim(),
      address: contactAddress.trim(),
      networkFamily: contactFamily,
      createdAt: Date.now(),
    });
    setContactLabel('');
    setContactAddress('');
  };

  return (
    <div className="space-y-8">
      {/* Stored Wallets & HD Derivation */}
      <div className="bg-[#11151C] border border-white/10 rounded-xl overflow-hidden">
        <div className="px-4 sm:px-6 py-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[#F4F6F9]">
              Stored Wallets & HD Sub-Accounts
            </h2>
            <p className="text-xs text-[#8A94A6] mt-0.5">
              Switch between vaults, derive additional BIP-44 accounts, or import another seed phrase
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {activeWallet.type === 'mnemonic' && (
              <button
                type="button"
                disabled={derivingSub}
                onClick={async () => {
                  setDerivingSub(true);
                  try {
                    await onDeriveSubAccount(activeWallet);
                  } finally {
                    setDerivingSub(false);
                  }
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 hover:border-emerald-500/50 text-xs text-[#CBD5E1]"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{derivingSub ? 'Deriving...' : 'Derive Next HD Account'}</span>
              </button>
            )}
            <button
              type="button"
              onClick={onAddWalletClick}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] font-semibold text-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Create / Import Wallet</span>
            </button>
          </div>
        </div>

        <div className="divide-y divide-white/[0.06]">
          {wallets.map((w) => {
            const isActive = w.id === activeWallet.id;
            return (
              <div
                key={w.id}
                className="px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-4 hover:bg-white/[0.02]"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2.5">
                    <span className="text-sm font-semibold text-[#F4F6F9]">{w.name}</span>
                    <span className="text-xs text-[#64748B]">·</span>
                    <span className="text-xs text-[#8A94A6]">
                      {w.type === 'mnemonic'
                        ? `${w.wordCount} words · Index #${w.accountIndex}`
                        : w.type === 'privateKey'
                        ? 'Private Key'
                        : 'Watch-Only'}
                    </span>
                    {isActive && (
                      <>
                        <span className="text-xs text-[#64748B]">·</span>
                        <span className="text-xs font-medium text-emerald-400">Active</span>
                      </>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-[#64748B]">
                    {w.addresses.evmAddress && (
                      <span>EVM: {shortenAddress(w.addresses.evmAddress)}</span>
                    )}
                    {w.addresses.solanaAddress && (
                      <span>SOL: {shortenAddress(w.addresses.solanaAddress)}</span>
                    )}
                    {w.addresses.bitcoinAddress && (
                      <span>BTC: {shortenAddress(w.addresses.bitcoinAddress)}</span>
                    )}
                    {w.addresses.moneroAddress && (
                      <span>XMR: {shortenAddress(w.addresses.moneroAddress)}</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {!isActive && (
                    <button
                      type="button"
                      onClick={() => onSelectWallet(w.id)}
                      className="px-3 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 hover:border-emerald-500/50 text-xs text-[#CBD5E1]"
                    >
                      Switch Active
                    </button>
                  )}
                  {wallets.length > 1 && (
                    <button
                      type="button"
                      onClick={() => onDeleteWallet(w.id)}
                      className="p-2 rounded-lg bg-[#090B0F] border border-white/10 text-[#8A94A6] hover:text-red-400"
                      aria-label={`Remove ${w.name}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Private Keys & Recovery Phrase Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6">
        <div className="lg:col-span-8 bg-[#11151C] border border-white/10 rounded-xl p-4 sm:p-6 space-y-5 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Shield className="w-4 h-4 text-emerald-400 shrink-0" />
              <h3 className="text-sm font-semibold text-[#F4F6F9] truncate">
                Private Keys & Recovery Phrase Inspector ({activeWallet.name})
              </h3>
            </div>
            {(revealedSecrets?.evmPrivateKey || secrets.evmPrivateKey) && (
              <button
                type="button"
                disabled={exportingKeystore}
                onClick={handleExportKeystore}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#CBD5E1] hover:text-[#F4F6F9]"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export UTC Keystore</span>
              </button>
            )}
          </div>

          {activeWallet.type === 'watchOnly' ? (
            <p className="text-xs text-[#8A94A6]">
              This is a Watch-Only portfolio. No seed phrase or private key is stored for this entry.
            </p>
          ) : !revealedSecrets ? (
            <div className="space-y-3">
              <p className="text-xs text-[#8A94A6]">
                Enter your Vault Password to decrypt and inspect your multi-chain private keys (EVM, Solana, Bitcoin, Monero Spend/View) and {activeWallet.wordCount ? `${activeWallet.wordCount}-word recovery phrase` : 'imported secret'}.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="password"
                  value={revealPassword}
                  onChange={(e) => setRevealPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRevealKeys();
                  }}
                  placeholder="Enter Vault Password"
                  className="bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9] w-full sm:w-64 focus:outline-none focus:border-emerald-500/60"
                />
                <button
                  type="button"
                  onClick={handleRevealKeys}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-xs font-semibold text-[#090B0F]"
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>Unlock & View Private Keys</span>
                </button>
              </div>
              {revealError && <p className="text-xs text-red-400">{revealError}</p>}
            </div>
          ) : (
            <div className="space-y-5">
              {/* Recovery Phrase Grid */}
              {revealedSecrets.mnemonic && (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-[#CBD5E1]">
                      BIP-39 Recovery Seed Phrase ({revealedSecrets.mnemonic.split(' ').length} Words)
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopy('mnemonic', revealedSecrets.mnemonic!)}
                      className="inline-flex items-center gap-1 text-xs text-[#8A94A6] hover:text-[#F4F6F9]"
                    >
                      {copiedId === 'mnemonic' ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="text-emerald-400">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>Copy Phrase</span>
                        </>
                      )}
                    </button>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                    {revealedSecrets.mnemonic.split(' ').map((word, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-2 bg-[#090B0F] border border-white/10 rounded-lg px-2.5 py-1.5"
                      >
                        <span className="text-[11px] font-mono text-[#64748B] w-5">
                          {String(idx + 1).padStart(2, '0')}
                        </span>
                        <span className="font-mono text-xs text-[#F4F6F9]">{word}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Individual Chain Private Keys */}
              <div className="space-y-3 pt-2 border-t border-white/10">
                <span className="block text-xs font-medium text-[#CBD5E1]">
                  Derived Chain Private Keys
                </span>

                {revealedSecrets.evmPrivateKey && (
                  <div className="p-3.5 rounded-lg bg-[#090B0F] border border-white/10 space-y-1.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-[#8A94A6]">
                        EVM Private Key (ETH / ARB / BASE / POL / BSC) · {activeWallet.addresses.evmPath}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setQrTargetValue({
                              label: 'EVM Private Key',
                              value: revealedSecrets.evmPrivateKey!,
                            })
                          }
                          className="text-[#8A94A6] hover:text-[#F4F6F9]"
                          title="Show QR backup"
                        >
                          <QrCode className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleCopy('evmKey', revealedSecrets.evmPrivateKey!)}
                          className="text-[#8A94A6] hover:text-[#F4F6F9]"
                        >
                          {copiedId === 'evmKey' ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                    <div className="font-mono text-xs text-[#F4F6F9] break-all">
                      {revealedSecrets.evmPrivateKey}
                    </div>
                  </div>
                )}

                {revealedSecrets.solanaSecretBase58 && (
                  <div className="p-3.5 rounded-lg bg-[#090B0F] border border-white/10 space-y-1.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-[#8A94A6]">
                        Solana Secret Key (Base58) · {activeWallet.addresses.solanaPath}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setQrTargetValue({
                              label: 'Solana Secret Key',
                              value: revealedSecrets.solanaSecretBase58!,
                            })
                          }
                          className="text-[#8A94A6] hover:text-[#F4F6F9]"
                          title="Show QR backup"
                        >
                          <QrCode className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleCopy('solKey', revealedSecrets.solanaSecretBase58!)}
                          className="text-[#8A94A6] hover:text-[#F4F6F9]"
                        >
                          {copiedId === 'solKey' ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                    <div className="font-mono text-xs text-emerald-400 break-all">
                      {revealedSecrets.solanaSecretBase58}
                    </div>
                  </div>
                )}

                {revealedSecrets.bitcoinPrivateKeyHex && (
                  <div className="p-3.5 rounded-lg bg-[#090B0F] border border-white/10 space-y-1.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-[#8A94A6]">
                        Bitcoin SegWit Private Key (Hex) · {activeWallet.addresses.bitcoinPath}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setQrTargetValue({
                              label: 'Bitcoin Private Key',
                              value: revealedSecrets.bitcoinPrivateKeyHex!,
                            })
                          }
                          className="text-[#8A94A6] hover:text-[#F4F6F9]"
                          title="Show QR backup"
                        >
                          <QrCode className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            handleCopy('btcKey', revealedSecrets.bitcoinPrivateKeyHex!)
                          }
                          className="text-[#8A94A6] hover:text-[#F4F6F9]"
                        >
                          {copiedId === 'btcKey' ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                    <div className="font-mono text-xs text-amber-400 break-all">
                      {revealedSecrets.bitcoinPrivateKeyHex}
                    </div>
                  </div>
                )}

                {revealedSecrets.moneroSpendKeyHex && (
                  <div className="p-3.5 rounded-lg bg-[#090B0F] border border-white/10 space-y-1.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-[#8A94A6]">
                        Monero Private Spend Key (Hex) · {activeWallet.addresses.moneroPath || "m/44'/128'/0'/0'"}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setQrTargetValue({
                              label: 'Monero Private Spend Key',
                              value: revealedSecrets.moneroSpendKeyHex!,
                            })
                          }
                          className="text-[#8A94A6] hover:text-[#F4F6F9]"
                          title="Show QR backup"
                        >
                          <QrCode className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            handleCopy('xmrSpendKey', revealedSecrets.moneroSpendKeyHex!)
                          }
                          className="text-[#8A94A6] hover:text-[#F4F6F9]"
                        >
                          {copiedId === 'xmrSpendKey' ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                    <div className="font-mono text-xs text-[#FF6600] break-all">
                      {revealedSecrets.moneroSpendKeyHex}
                    </div>
                  </div>
                )}

                {revealedSecrets.moneroViewKeyHex && (
                  <div className="p-3.5 rounded-lg bg-[#090B0F] border border-white/10 space-y-1.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-[#8A94A6]">
                        Monero Private View Key (Hex) · Watch / Audit Key
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setQrTargetValue({
                              label: 'Monero Private View Key',
                              value: revealedSecrets.moneroViewKeyHex!,
                            })
                          }
                          className="text-[#8A94A6] hover:text-[#F4F6F9]"
                          title="Show QR backup"
                        >
                          <QrCode className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            handleCopy('xmrViewKey', revealedSecrets.moneroViewKeyHex!)
                          }
                          className="text-[#8A94A6] hover:text-[#F4F6F9]"
                        >
                          {copiedId === 'xmrViewKey' ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                    <div className="font-mono text-xs text-orange-300 break-all">
                      {revealedSecrets.moneroViewKeyHex}
                    </div>
                  </div>
                )}

                {qrTargetValue && qrImageUrl && (
                  <div className="p-4 rounded-lg bg-[#090B0F] border border-white/10 flex items-center gap-4">
                    <img
                      src={qrImageUrl}
                      alt={qrTargetValue.label}
                      className="w-28 h-28 rounded"
                    />
                    <div className="space-y-1 text-xs">
                      <div className="font-semibold text-[#F4F6F9]">
                        {qrTargetValue.label} Offline QR
                      </div>
                      <p className="text-[#8A94A6]">
                        Scan only on trusted offline hardware or cold storage signers.
                      </p>
                      <button
                        type="button"
                        onClick={() => setQrTargetValue(null)}
                        className="text-emerald-400 hover:underline"
                      >
                        Close QR
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => {
                  setRevealedSecrets(null);
                  setQrTargetValue(null);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#8A94A6] hover:text-[#F4F6F9]"
              >
                <EyeOff className="w-3.5 h-3.5" />
                <span>Hide Private Keys</span>
              </button>
            </div>
          )}
        </div>

        {/* Vault Preferences & Session Lock */}
        <div className="lg:col-span-4 bg-[#11151C] border border-white/10 rounded-xl p-6 flex flex-col justify-between gap-5">
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-[#F4F6F9]">Vault Preferences</h3>
            </div>

            <div>
              <label className="block text-xs text-[#8A94A6] mb-1.5">Display Fiat Currency</label>
              <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#090B0F] border border-white/10 rounded-lg">
                {(['USD', 'EUR', 'GBP'] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => onChangeCurrency(c)}
                    className={`py-1.5 rounded text-xs font-mono transition-colors ${
                      currency === c
                        ? 'bg-[#1D2432] text-[#F4F6F9] font-semibold'
                        : 'text-[#8A94A6] hover:text-[#F4F6F9]'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onLockVault}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-[#090B0F] border border-white/15 hover:border-red-500/40 text-xs font-medium text-[#F4F6F9] hover:text-red-300 transition-colors"
          >
            <Lock className="w-3.5 h-3.5" />
            <span>Lock Encrypted Vault Now</span>
          </button>
        </div>
      </div>

      {/* Address Book */}
      <div className="bg-[#11151C] border border-white/10 rounded-xl p-6 space-y-5">
        <div className="flex items-center gap-2">
          <BookUser className="w-4 h-4 text-emerald-400" />
          <h3 className="text-sm font-semibold text-[#F4F6F9]">Trusted Address Book</h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
          <input
            type="text"
            value={contactLabel}
            onChange={(e) => setContactLabel(e.target.value)}
            placeholder="Label (e.g. Cold Storage)"
            className="sm:col-span-3 bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9]"
          />
          <select
            value={contactFamily}
            onChange={(e) => setContactFamily(e.target.value as NetworkFamily)}
            className="sm:col-span-2 bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9]"
          >
            <option value="evm">EVM (0x)</option>
            <option value="solana">Solana</option>
            <option value="bitcoin">Bitcoin</option>
            <option value="monero">Monero (XMR)</option>
          </select>
          <input
            type="text"
            value={contactAddress}
            onChange={(e) => setContactAddress(e.target.value)}
            placeholder="Recipient address"
            className="sm:col-span-5 bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-xs text-[#F4F6F9]"
          />
          <button
            type="button"
            onClick={handleCreateContact}
            className="sm:col-span-2 py-2 px-3 rounded-lg bg-[#1A2130] hover:bg-[#232C3F] text-xs font-medium text-[#F4F6F9]"
          >
            Save Contact
          </button>
        </div>

        {addressBook.length > 0 && (
          <div className="divide-y divide-white/[0.06] border-t border-white/10 pt-2">
            {addressBook.map((c) => (
              <div
                key={c.id}
                className="py-2.5 flex items-center justify-between gap-3 text-xs"
              >
                <div className="min-w-0">
                  <span className="font-medium text-[#F4F6F9]">{c.label}</span>
                  <span className="mx-2 text-[#64748B]">·</span>
                  <span className="uppercase text-[11px] text-[#8A94A6]">{c.networkFamily}</span>
                  <div className="font-mono text-[11px] text-[#64748B] truncate mt-0.5">
                    {c.address}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onDeleteContact(c.id)}
                  className="p-1.5 rounded text-[#8A94A6] hover:text-red-400"
                  aria-label="Delete contact"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
