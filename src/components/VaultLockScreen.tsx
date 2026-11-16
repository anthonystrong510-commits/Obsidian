import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, Lock, ShieldAlert, Unlock } from 'lucide-react';
import { verifyVaultPassword } from '../lib/vaultStorage';

interface VaultLockScreenProps {
  walletCount: number;
  onUnlock: (password: string) => Promise<void>;
  onResetVault: () => void;
}

export function VaultLockScreen({
  walletCount,
  onUnlock,
  onResetVault,
}: VaultLockScreenProps) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError('Enter your vault password.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const ok = await verifyVaultPassword(password);
      if (!ok) {
        setError('Incorrect vault password.');
        setLoading(false);
        return;
      }
      await onUnlock(password);
    } catch {
      setError('Failed to decrypt local vault.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#090B0F] text-[#F4F6F9] flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-[#11151C] border border-white/10 rounded-xl overflow-hidden">
        <div className="relative h-44 w-full overflow-hidden border-b border-white/10 bg-[#0B0E14]">
          <img
            src="/src/assets/images/vault_monolith_hero_1794846319768.jpg"
            alt="Obsidian Vault hardware key"
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover opacity-80"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#11151C] via-[#11151C]/50 to-transparent" />
          <div className="absolute bottom-4 left-6 right-6 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#8A94A6]">Encrypted Local Keystore</p>
              <h1 className="text-xl font-semibold tracking-tight text-[#F4F6F9]">
                Obsidian Vault
              </h1>
            </div>
            <div className="w-10 h-10 rounded-lg bg-[#090B0F]/80 border border-white/10 flex items-center justify-center text-emerald-400">
              <Lock className="w-5 h-5" />
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div className="text-sm text-[#8A94A6]">
            <span>{walletCount} encrypted wallet{walletCount === 1 ? '' : 's'}</span>
            <span className="mx-2 text-white/20">·</span>
            <span>AES-256-GCM locked</span>
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
            <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              <ShieldAlert className="w-4 h-4 shrink-0" />
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

          <div className="pt-3 border-t border-white/10 flex items-center justify-between text-xs text-[#8A94A6]">
            {!confirmReset ? (
              <button
                type="button"
                onClick={() => setConfirmReset(true)}
                className="hover:text-red-400 transition-colors"
              >
                Forgot password? Reset vault
              </button>
            ) : (
              <div className="flex items-center justify-between w-full gap-2">
                <span className="text-red-400">Erase local keys?</span>
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
                    Confirm Erase
                  </button>
                </div>
              </div>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
