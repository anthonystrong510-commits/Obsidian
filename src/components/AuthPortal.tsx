import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Link2,
  Mail,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Wallet,
} from 'lucide-react';
import { auth, googleProvider } from '../lib/firebase';
import {
  MOBILE_WALLET_APPS,
  authenticateWithDiscoveredWallet,
  buildWalletAuthLandingUrl,
  discoverExternalWalletProviders,
  isInAppWalletBrowser,
  isMobileUserAgent,
} from '../lib/walletConnectService';
import { sanitizeExternalUrl } from '../lib/vaultStorage';
import { ObsidianLogo } from './ObsidianLogo';
import type {
  ConnectedExternalWallet,
  DiscoveredWalletProvider,
  WalletAuthSession,
} from '../types/wallet';

interface AuthPortalProps {
  unverifiedUser: User | null;
  initialMode?: 'signin' | 'signup' | 'wallet';
  onRefreshVerification: () => Promise<void>;
  onWalletAuthSuccess?: (
    session: WalletAuthSession,
    connections: ConnectedExternalWallet[]
  ) => Promise<void> | void;
  onBackToLanding?: () => void;
}

type AuthMode = 'signin' | 'signup' | 'reset' | 'wallet';

export function AuthPortal({
  unverifiedUser,
  initialMode = 'signin',
  onRefreshVerification,
  onWalletAuthSuccess,
  onBackToLanding,
}: AuthPortalProps) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [infoMessage, setInfoMessage] = useState('');
  const [showConsoleHelp, setShowConsoleHelp] = useState(false);

  // Wallet Auth discovery & pairing state
  const [discoveredWallets, setDiscoveredWallets] = useState<DiscoveredWalletProvider[]>([]);
  const [scanningWallets, setScanningWallets] = useState(false);
  const [connectingUuid, setConnectingUuid] = useState<string | null>(null);

  const mobileDevice = useMemo(() => isMobileUserAgent(), []);
  const inAppBrowser = useMemo(() => isInAppWalletBrowser(), []);
  const walletAuthDeepLinkUrl = useMemo(() => buildWalletAuthLandingUrl(), []);

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  useEffect(() => {
    const stop = discoverExternalWalletProviders((list) => {
      setDiscoveredWallets(list);
    });
    return () => stop();
  }, []);

  const handleRescanWallets = () => {
    setScanningWallets(true);
    setError('');
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => setScanningWallets(false), 600);
  };

  const handleWalletAuthenticate = async (prov: DiscoveredWalletProvider) => {
    setError('');
    setInfoMessage('');
    setConnectingUuid(prov.uuid);
    try {
      const { session, connections } = await authenticateWithDiscoveredWallet(prov);
      await onWalletAuthSuccess?.(session, connections);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to connect wallet. Unlock your wallet extension or app and try again.'
      );
    } finally {
      setConnectingUuid(null);
    }
  };

  const mapAuthError = (err: unknown): string => {
    const code = (err as { code?: string })?.code || '';
    if (code === 'auth/operation-not-allowed') {
      setShowConsoleHelp(true);
      return 'Email/Password sign-in is not enabled yet in Firebase Console. Enable it under Authentication → Sign-in method, or sign in with Google below.';
    }
    if (code === 'auth/email-already-in-use') {
      return 'An account with this email already exists. Switch to Sign In.';
    }
    if (code === 'auth/weak-password') {
      return 'Password must be at least 6 characters.';
    }
    if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
      return 'Invalid email or password.';
    }
    if (code === 'auth/popup-closed-by-user') {
      return 'Google sign-in popup was closed before completing.';
    }
    if (code === 'auth/unauthorized-domain') {
      return 'This domain is not authorized in Firebase Auth settings. Check Firebase Console → Authentication → Settings → Authorized domains.';
    }
    return err instanceof Error ? err.message : 'Authentication failed.';
  };

  const handleGoogleSignIn = async () => {
    setError('');
    setInfoMessage('');
    setLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setError(mapAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleEmailSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setInfoMessage('');
    setShowConsoleHelp(false);

    if (!email.trim()) {
      setError('Enter your email address.');
      return;
    }

    if (mode === 'reset') {
      setLoading(true);
      try {
        await sendPasswordResetEmail(auth, email.trim());
        setInfoMessage('Password reset link sent to your email.');
      } catch (err) {
        setError(mapAuthError(err));
      } finally {
        setLoading(false);
      }
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    if (mode === 'signup') {
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
      setLoading(true);
      try {
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        if (displayName.trim()) {
          await updateProfile(cred.user, { displayName: displayName.trim() });
        }
        await sendEmailVerification(cred.user);
        setInfoMessage('Account created. Check your inbox to verify your email.');
      } catch (err) {
        setError(mapAuthError(err));
      } finally {
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      setError(mapAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  if (unverifiedUser) {
    return (
      <div className="min-h-screen bg-[#090B0F] text-[#F4F6F9] flex items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-md bg-[#11151C] border border-white/10 rounded-xl p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400">
              <Mail className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-[#F4F6F9]">Verify Your Email</h1>
              <p className="text-xs text-[#8A94A6] truncate">{unverifiedUser.email}</p>
            </div>
          </div>

          <p className="text-xs text-[#CBD5E1] leading-relaxed">
            For zero-trust cloud vault security, Firestore enforces verified email identity before syncing encrypted wallets or alerts. Open the verification link sent to your inbox, then click refresh below.
          </p>

          {infoMessage && (
            <div className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
              {infoMessage}
            </div>
          )}

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="space-y-2.5">
            <button
              type="button"
              onClick={async () => {
                setLoading(true);
                setError('');
                try {
                  await onRefreshVerification();
                } catch (err) {
                  setError(mapAuthError(err));
                } finally {
                  setLoading(false);
                }
              }}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] font-semibold text-sm transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              <span>I&apos;ve Verified — Continue</span>
            </button>

            <button
              type="button"
              onClick={async () => {
                setLoading(true);
                setError('');
                try {
                  await sendEmailVerification(unverifiedUser);
                  setInfoMessage('Verification email resent.');
                } catch (err) {
                  setError(mapAuthError(err));
                } finally {
                  setLoading(false);
                }
              }}
              disabled={loading}
              className="w-full py-2 px-4 rounded-lg bg-[#090B0F] border border-white/10 hover:border-white/20 text-xs text-[#CBD5E1]"
            >
              Resend Verification Email
            </button>

            <button
              type="button"
              onClick={() => signOut(auth)}
              className="w-full py-2 px-4 text-xs text-[#8A94A6] hover:text-[#F4F6F9]"
            >
              Sign out / Use another account
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#090B0F] text-[#F4F6F9] flex items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-5xl bg-[#11151C] border border-white/10 rounded-xl overflow-hidden grid grid-cols-1 lg:grid-cols-12 items-stretch">
        {/* Left Auth Form Column */}
        <div className="lg:col-span-7 p-5 sm:p-10 flex flex-col justify-between gap-6 min-w-0">
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                {onBackToLanding && (
                  <button
                    type="button"
                    onClick={onBackToLanding}
                    className="inline-flex items-center gap-1 text-xs text-[#8A94A6] hover:text-[#F4F6F9] transition-colors shrink-0"
                    aria-label="Back to landing page"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>Home</span>
                  </button>
                )}
                <div className="flex items-center gap-2">
                  <ObsidianLogo size={26} />
                  <span className="font-display text-lg sm:text-xl font-bold tracking-tight text-[#F4F6F9] whitespace-nowrap">
                    Obsidian Vault
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1 p-1 bg-[#090B0F] border border-white/10 rounded-lg overflow-x-auto max-w-full">
                <button
                  type="button"
                  onClick={() => {
                    setMode('signin');
                    setError('');
                    setInfoMessage('');
                  }}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    mode === 'signin'
                      ? 'bg-[#1D2432] text-[#F4F6F9]'
                      : 'text-[#8A94A6] hover:text-[#F4F6F9]'
                  }`}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode('signup');
                    setError('');
                    setInfoMessage('');
                  }}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    mode === 'signup'
                      ? 'bg-[#1D2432] text-[#F4F6F9]'
                      : 'text-[#8A94A6] hover:text-[#F4F6F9]'
                  }`}
                >
                  Sign Up
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode('wallet');
                    setError('');
                    setInfoMessage('');
                  }}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    mode === 'wallet'
                      ? 'bg-emerald-500/20 text-emerald-400'
                      : 'text-[#8A94A6] hover:text-[#F4F6F9]'
                  }`}
                >
                  <Link2 className="w-3 h-3" />
                  <span>Connect Wallet</span>
                </button>
              </div>
            </div>

            <div>
              <h1 className="text-2xl sm:text-3xl font-display font-bold tracking-tight text-[#F4F6F9] text-balance">
                {mode === 'wallet'
                  ? 'Authenticate with your paired wallet'
                  : mode === 'signup'
                  ? 'Create your multi-chain vault account'
                  : mode === 'reset'
                  ? 'Reset account password'
                  : 'Sign in to your crypto vault'}
              </h1>
              <p className="text-xs text-[#8A94A6] mt-1.5 leading-relaxed">
                {mode === 'wallet'
                  ? 'Pair your browser or mobile wallet once. Your connected address acts as your persistent vault session and immediately imports your multi-chain assets.'
                  : 'Sync encrypted 12/18/24-word wallets, price alerts, and multi-chain portfolios securely, or pair an external wallet without email login.'}
              </p>
            </div>

            {mode === 'wallet' ? (
              <div className="space-y-4">
                {/* Detected Browser / In-App Wallets */}
                <div className="bg-[#090B0F] border border-white/10 rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-medium text-[#F4F6F9]">
                      <Wallet className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>
                        {inAppBrowser
                          ? 'In-App Mobile Wallet Detected'
                          : 'Detected Browser Wallets'}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={handleRescanWallets}
                      className="inline-flex items-center gap-1.5 text-[11px] text-[#8A94A6] hover:text-[#F4F6F9] transition-colors shrink-0"
                    >
                      <RefreshCw className={`w-3 h-3 ${scanningWallets ? 'animate-spin' : ''}`} />
                      <span>Re-scan</span>
                    </button>
                  </div>

                  {discoveredWallets.length > 0 ? (
                    <div className="space-y-2">
                      {discoveredWallets.map((prov) => {
                        const isConnecting = connectingUuid === prov.uuid;
                        return (
                          <div
                            key={prov.uuid}
                            className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 p-3 rounded-lg bg-[#11151C] border border-white/10 hover:border-emerald-500/40 transition-colors"
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              {prov.icon ? (
                                <img
                                  src={prov.icon}
                                  alt={prov.name}
                                  className="w-8 h-8 rounded-lg object-contain bg-[#090B0F] p-1 shrink-0"
                                />
                              ) : (
                                <div className="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-xs font-bold text-emerald-400 shrink-0">
                                  {prov.name.slice(0, 1).toUpperCase()}
                                </div>
                              )}
                              <div className="min-w-0">
                                <div className="text-xs font-semibold text-[#F4F6F9] truncate">
                                  {prov.name}
                                </div>
                                <div className="text-[11px] text-[#64748B] truncate">
                                  {prov.kind === 'solana' ? 'Solana Network' : 'EVM Multi-Chain'}
                                </div>
                              </div>
                            </div>

                            <button
                              type="button"
                              disabled={Boolean(connectingUuid)}
                              onClick={() => handleWalletAuthenticate(prov)}
                              className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
                            >
                              <span>{isConnecting ? 'Pairing...' : 'Pair & Open Assets'}</span>
                              <ArrowRight className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="p-3.5 rounded-lg bg-[#11151C] border border-white/[0.07] text-xs text-[#8A94A6] space-y-1.5">
                      <p className="text-[#CBD5E1] font-medium">
                        {mobileDevice
                          ? 'No injected wallet detected in this mobile browser.'
                          : 'No browser wallet extension detected yet.'}
                      </p>
                      <p className="text-[11px] leading-relaxed">
                        {mobileDevice
                          ? 'Tap any installed wallet app below to open Obsidian Vault directly inside its secure Web3 DApp browser and authenticate automatically.'
                          : 'Install or unlock MetaMask, Rabby, Phantom, Coinbase Wallet, or Trust Wallet, then click Re-scan above — or open this page inside a mobile wallet app below.'}
                      </p>
                    </div>
                  )}
                </div>

                {/* Mobile Wallet App Deep-Link Launchers */}
                {(!inAppBrowser && (mobileDevice || discoveredWallets.length === 0)) && (
                  <div className="bg-[#090B0F] border border-white/10 rounded-xl p-4 space-y-3">
                    <div className="flex items-center gap-2 text-xs font-medium text-[#F4F6F9]">
                      <Smartphone className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>Open in Installed Mobile Wallet App</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {MOBILE_WALLET_APPS.slice(0, 6).map((app) => (
                        <a
                          key={app.id}
                          href={sanitizeExternalUrl(app.buildDeepLink(walletAuthDeepLinkUrl))}
                          className="flex items-center justify-between gap-2.5 p-2.5 rounded-lg bg-[#11151C] border border-white/10 hover:border-emerald-500/40 transition-colors"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span
                              className="w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: app.color }}
                            />
                            <div className="min-w-0">
                              <div className="text-xs font-medium text-[#F4F6F9] truncate">
                                {app.name}
                              </div>
                              <div className="text-[10px] text-[#64748B] truncate">{app.chains}</div>
                            </div>
                          </div>
                          <ExternalLink className="w-3.5 h-3.5 text-[#8A94A6] shrink-0" />
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {error && (
                  <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5">
                    <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{error}</span>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#64748B] pt-1">
                  <span>Session stays paired across reloads without email login</span>
                  <button
                    type="button"
                    onClick={() => {
                      setMode('signin');
                      setError('');
                    }}
                    className="text-[#CBD5E1] hover:text-[#F4F6F9] underline underline-offset-4"
                  >
                    Use Email or Google instead
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="space-y-2.5">
                  {/* Google Sign-In Primary Button */}
                  <button
                    type="button"
                    disabled={loading}
                    onClick={handleGoogleSignIn}
                    className="w-full flex items-center justify-center gap-3 py-2.5 px-4 rounded-lg bg-[#F4F6F9] hover:bg-white text-[#090B0F] font-semibold text-sm transition-colors disabled:opacity-50"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        fill="#4285F4"
                        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
                      />
                      <path
                        fill="#34A853"
                        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
                      />
                    </svg>
                    <span>Continue with Google</span>
                  </button>

                  {/* Wallet Auth Secondary Button */}
                  <button
                    type="button"
                    onClick={() => {
                      setMode('wallet');
                      setError('');
                      setInfoMessage('');
                    }}
                    className="w-full flex items-center justify-between gap-3 py-2.5 px-4 rounded-lg bg-[#090B0F] hover:bg-[#171E2B] border border-emerald-500/35 text-[#F4F6F9] font-medium text-sm transition-colors"
                  >
                    <span className="inline-flex items-center gap-2.5 min-w-0">
                      <Link2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span className="truncate">Connect Paired Wallet (No Login Required)</span>
                    </span>
                    <span className="font-mono text-[11px] text-emerald-400 shrink-0">
                      {discoveredWallets.length > 0
                        ? `${discoveredWallets.length} ready`
                        : 'Pair'}
                    </span>
                  </button>
                </div>

                <div className="relative flex items-center py-1">
                  <div className="flex-grow border-t border-white/10" />
                  <span className="shrink mx-3 text-[11px] text-[#64748B]">or with email</span>
                  <div className="flex-grow border-t border-white/10" />
                </div>

                <form onSubmit={handleEmailSubmit} className="space-y-4">
                  {mode === 'signup' && (
                    <div>
                      <label className="block text-xs text-[#8A94A6] mb-1">Full Name</label>
                      <input
                        type="text"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="Alex Mercer"
                        className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3.5 py-2.5 text-base sm:text-sm text-[#F4F6F9] placeholder-[#525D70] focus:outline-none focus:border-emerald-500/60"
                      />
                    </div>
                  )}

                  <div>
                    <label className="block text-xs text-[#8A94A6] mb-1">Email Address</label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@domain.com"
                      required
                      className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3.5 py-2.5 text-base sm:text-sm text-[#F4F6F9] placeholder-[#525D70] focus:outline-none focus:border-emerald-500/60"
                    />
                  </div>

                  {mode !== 'reset' && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className={mode === 'signin' ? 'sm:col-span-2' : ''}>
                        <label className="block text-xs text-[#8A94A6] mb-1">Password</label>
                        <input
                          type="password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="Minimum 6 characters"
                          required
                          className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3.5 py-2.5 text-base sm:text-sm text-[#F4F6F9] placeholder-[#525D70] focus:outline-none focus:border-emerald-500/60"
                        />
                      </div>
                      {mode === 'signup' && (
                        <div>
                          <label className="block text-xs text-[#8A94A6] mb-1">
                            Confirm Password
                          </label>
                          <input
                            type="password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            placeholder="Repeat password"
                            required
                            className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3.5 py-2.5 text-base sm:text-sm text-[#F4F6F9] placeholder-[#525D70] focus:outline-none focus:border-emerald-500/60"
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {error && (
                    <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5">
                      <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{error}</span>
                    </div>
                  )}

                  {showConsoleHelp && (
                    <div className="p-3.5 rounded-lg bg-[#090B0F] border border-amber-500/30 text-xs text-[#CBD5E1] space-y-1">
                      <p className="font-semibold text-amber-400">
                        Enable Email/Password Sign-In in Firebase Console:
                      </p>
                      <p className="text-[#8A94A6]">
                        Open Firebase Console → Project gen-lang-client-0670666479 → Authentication → Sign-in method → Add new provider → Email/Password → Enable & Save.
                      </p>
                    </div>
                  )}

                  {infoMessage && (
                    <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2.5">
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      <span>{infoMessage}</span>
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-3 pt-1">
                    {mode === 'signin' ? (
                      <button
                        type="button"
                        onClick={() => setMode('reset')}
                        className="text-xs text-[#8A94A6] hover:text-[#F4F6F9]"
                      >
                        Forgot password?
                      </button>
                    ) : mode === 'reset' ? (
                      <button
                        type="button"
                        onClick={() => setMode('signin')}
                        className="text-xs text-[#8A94A6] hover:text-[#F4F6F9]"
                      >
                        Back to Sign In
                      </button>
                    ) : (
                      <span className="text-[11px] text-[#64748B]">
                        Verification link sent on sign up
                      </span>
                    )}

                    <button
                      type="submit"
                      disabled={loading}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-sm transition-colors whitespace-nowrap"
                    >
                      <span>
                        {loading
                          ? 'Authenticating...'
                          : mode === 'signup'
                          ? 'Create Account'
                          : mode === 'reset'
                          ? 'Send Reset Link'
                          : 'Sign In'}
                      </span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>

          <div className="pt-4 border-t border-white/10 flex flex-wrap items-center justify-between gap-3 text-xs text-[#64748B]">
            <span>Zero-trust AES-256-GCM wallet encryption</span>
            <span>BIP-39 / BIP-44 / CryptoNote</span>
          </div>
        </div>

        {/* Right Editorial Hardware Showcase */}
        <div className="lg:col-span-5 bg-[#0D1017] border-t lg:border-t-0 lg:border-l border-white/10 flex flex-col justify-between overflow-hidden">
          <div className="relative h-56 lg:h-72 w-full">
            <img
              src="/src/assets/images/vault_monolith_hero_1794846319768.jpg"
              alt="Obsidian Vault hardware key"
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover opacity-85"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-[#0D1017] via-[#0D1017]/30 to-transparent" />
          </div>

          <div className="p-6 sm:p-8 space-y-5">
            <div className="flex items-center gap-2 text-xs font-medium text-emerald-400">
              <ShieldCheck className="w-4 h-4" />
              <span>Non-Custodial Cloud Sync Architecture</span>
            </div>
            <p className="text-sm text-[#CBD5E1] leading-relaxed">
              Your 12, 18, and 24-word seed phrases and private keys are encrypted client-side with your Vault Password before syncing. Only you can decrypt and reveal your private keys.
            </p>
            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-white/10 text-xs">
              <div>
                <div className="font-mono font-semibold text-[#F4F6F9]">10 Networks</div>
                <div className="text-[#64748B] mt-0.5">EVM, Solana & Bitcoin</div>
              </div>
              <div>
                <div className="font-mono font-semibold text-[#F4F6F9]">Live SSE</div>
                <div className="text-[#64748B] mt-0.5">Real-time price alerts</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
