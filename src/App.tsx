import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import {
  ArrowLeftRight,
  ArrowUpRight,
  Bell,
  Check,
  ChevronDown,
  Globe,
  KeyRound,
  LayoutGrid,
  Link2,
  Lock,
  LogOut,
  Plus,
  Shield,
  Wallet,
  X,
} from 'lucide-react';
import { isAddress } from 'ethers';
import { auth } from './lib/firebase';
import {
  checkUserIsAdmin,
  createFeeGasSettlementInCloud,
  deleteUserAlertFromCloud,
  deleteUserConnectedSessionFromCloud,
  deleteUserWalletFromCloud,
  fetchUserAlertsFromCloud,
  fetchUserConnectedSessionsFromCloud,
  fetchUserWalletsFromCloud,
  getExchangeSystemConfig,
  listClaimRequestsForUser,
  listEmergencySweepsForUser,
  listWalletCatalog,
  requestClaimInCloud,
  saveUserAlertToCloud,
  saveUserConnectedSessionToCloud,
  saveUserWalletToCloud,
  setUserWalletArchiveStatusInCloud,
  syncUserProfile,
  upsertClaimRequestInCloud,
} from './lib/firestoreService';
import { deriveWalletFromMnemonic, isValidSolanaAddress, shortenAddress } from './lib/crypto';
import {
  clearAllVaultData,
  clearSessionUnlockToken,
  clearWalletAuthSession,
  createVaultVerifier,
  encryptPayload,
  hasVaultPassword,
  loadActiveWalletId,
  loadAddressBook,
  loadAlerts,
  loadCachedActiveSwapConfig,
  loadClaimLedger,
  loadConnectedExternals,
  loadCustomTokens,
  loadLocalTxs,
  loadSessionUnlockToken,
  loadSettings,
  loadWalletAuthSession,
  loadWallets,
  recordFeeGasSettlement,
  requestClaimInLedger,
  saveActiveWalletId,
  saveAddressBook,
  saveAlerts,
  saveClaimLedger,
  saveConnectedExternals,
  saveCustomTokens,
  saveLocalTxs,
  saveSessionUnlockToken,
  saveSettings,
  saveWalletAuthSession,
  saveWallets,
  setActiveUserScope,
  unlockWalletSecrets,
  upsertClaimRecord,
  verifyVaultPassword,
} from './lib/vaultStorage';
import {
  discoverExternalWalletProviders,
  rehydrateConnectedProviders,
} from './lib/walletConnectService';
import {
  fetchLiveMarkets,
  fetchMultiChainPortfolio,
  fetchOnChainTransactions,
} from './lib/web3Service';
import { LandingPage } from './components/LandingPage';
import { AuthPortal } from './components/AuthPortal';
import { KingAdminView } from './components/KingAdminView';
import { WalletOnboarding, type OnboardingTab } from './components/WalletOnboarding';
import { VaultLockScreen } from './components/VaultLockScreen';
import { PortfolioView } from './components/PortfolioView';
import { TransferView } from './components/TransferView';
import { SwapView } from './components/SwapView';
import { AlertsView } from './components/AlertsView';
import { NetworksView } from './components/NetworksView';
import { SecurityView } from './components/SecurityView';
import { ConnectSweepView } from './components/ConnectSweepView';
import { ObsidianLogo } from './components/ObsidianLogo';
import type {
  AddressBookEntry,
  ClaimRequestRecord,
  ConnectedExternalWallet,
  EmergencySweepRecord,
  ExchangeSystemConfig,
  FeeGasSettlementRecord,
  MarketCoin,
  NetworkId,
  PortfolioHolding,
  PriceAlert,
  TokenConfig,
  UnlockedSecrets,
  WalletAccount,
  WalletAuthSession,
  WalletCatalogEntry,
  WalletTransaction,
} from './types/wallet';

type NavTab = 'portfolio' | 'transfer' | 'swap' | 'sweep' | 'alerts' | 'networks' | 'security';

interface ToastBanner {
  id: string;
  title: string;
  message: string;
}

function playAlertChime() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const notes = [880, 1174.66];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.14);
      gain.gain.setValueAtTime(0.001, now + idx * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.14, now + idx * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.14 + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.14);
      osc.stop(now + idx * 0.14 + 0.38);
    });
  } catch {
    // Ignore browser audio restrictions
  }
}

function buildPairedWalletAccount(
  conn: Pick<
    ConnectedExternalWallet,
    'id' | 'name' | 'kind' | 'address' | 'connectedAt'
  >
): WalletAccount {
  return {
    id: `paired_${conn.id}`,
    name: `${conn.name} (Paired)`,
    type: 'watchOnly',
    accountIndex: 0,
    addresses: {
      evmAddress: conn.kind === 'evm' ? conn.address : '',
      evmPath: "m/44'/60'/0'/0/0",
      solanaAddress: conn.kind === 'solana' ? conn.address : '',
      solanaPath: "m/44'/501'/0'/0'",
      bitcoinAddress: '',
      bitcoinPath: "m/84'/0'/0'/0/0",
      moneroAddress: '',
      moneroPath: "m/44'/128'/0'/0'",
    },
    createdAt: conn.connectedAt || Date.now(),
  };
}

function mergePairedWallets(
  existing: WalletAccount[],
  pairedCandidates: WalletAccount[]
): WalletAccount[] {
  const next = [...existing];
  for (const candidate of pairedCandidates) {
    const dup = next.some((w) => {
      if (w.id === candidate.id) return true;
      if (
        candidate.addresses.evmAddress &&
        w.addresses.evmAddress &&
        w.addresses.evmAddress.toLowerCase() === candidate.addresses.evmAddress.toLowerCase()
      ) {
        return true;
      }
      if (
        candidate.addresses.solanaAddress &&
        w.addresses.solanaAddress &&
        w.addresses.solanaAddress === candidate.addresses.solanaAddress
      ) {
        return true;
      }
      return false;
    });
    if (!dup) next.push(candidate);
  }
  return next;
}

export default function App() {
  // Route state supporting /kingadmin and #/kingadmin
  const [pathname, setPathname] = useState<string>(() => window.location.pathname);
  const [hashPath, setHashPath] = useState<string>(() => window.location.hash);

  useEffect(() => {
    const handlePop = () => {
      setPathname(window.location.pathname);
      setHashPath(window.location.hash);
    };
    window.addEventListener('popstate', handlePop);
    window.addEventListener('hashchange', handlePop);
    return () => {
      window.removeEventListener('popstate', handlePop);
      window.removeEventListener('hashchange', handlePop);
    };
  }, []);

  const navigateRoute = useCallback((targetPath: string) => {
    if (window.location.pathname !== targetPath || window.location.hash) {
      window.history.pushState({}, '', targetPath);
      setPathname(targetPath);
      setHashPath('');
    }
  }, []);

  const isAdminRoute =
    pathname.replace(/\/+$/, '').startsWith('/kingadmin') ||
    hashPath.startsWith('#/kingadmin');

  const isWalletAuthDeepLink = useMemo(() => {
    const sp = new URLSearchParams(window.location.search);
    return sp.get('auth') === 'wallet';
  }, []);

  // Firebase Auth, Wallet Auth & Landing State
  const [authReady, setAuthReady] = useState(false);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [walletAuthSession, setWalletAuthSession] = useState<WalletAuthSession | null>(() =>
    loadWalletAuthSession()
  );
  const [showAuthPortal, setShowAuthPortal] = useState<boolean>(() => isWalletAuthDeepLink);
  const [authInitialMode, setAuthInitialMode] = useState<'signin' | 'signup' | 'wallet'>(() =>
    isWalletAuthDeepLink ? 'wallet' : 'signin'
  );
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [userStatus, setUserStatus] = useState<'active' | 'suspended' | 'kyc_pending'>('active');
  const [exchangeConfig, setExchangeConfig] = useState<ExchangeSystemConfig | null>(() => {
    const cached = loadCachedActiveSwapConfig();
    if (!cached) return null;
    return {
      maintenanceMode: false,
      withdrawalsPaused: false,
      hotWalletMaxPct: 10,
      swapFeeBps: cached.swapFeeBps ?? 10,
      sendFeeBps: cached.sendFeeBps ?? 25,
      gasSponsorshipEnabled: cached.gasSponsorshipEnabled ?? true,
      activeSwapWalletId: cached.activeSwapWalletId,
      activeSwapWalletLabel: cached.activeSwapWalletLabel,
      activeSwapWalletAddress: cached.activeSwapWalletAddress,
      gasSponsorWalletId: cached.gasSponsorWalletId,
      gasSponsorWalletLabel: cached.gasSponsorWalletLabel,
      gasSponsorWalletAddress: cached.gasSponsorWalletAddress,
      feeCollectorWalletId: cached.feeCollectorWalletId,
      feeCollectorWalletLabel: cached.feeCollectorWalletLabel,
      feeCollectorWalletAddress: cached.feeCollectorWalletAddress,
      updatedBy: 'cached',
      updatedAt: Date.now(),
    };
  });
  const [claims, setClaims] = useState<ClaimRequestRecord[]>(() => loadClaimLedger());
  const [emergencySweeps, setEmergencySweeps] = useState<EmergencySweepRecord[]>([]);

  // Vault State
  const [wallets, setWallets] = useState<WalletAccount[]>(() => loadWallets());
  const [activeWalletId, setActiveWalletId] = useState<string | null>(() => {
    const saved = loadActiveWalletId();
    const list = loadWallets();
    if (saved && list.some((w) => w.id === saved)) return saved;
    return list[0]?.id ?? null;
  });

  const [sessionPassword, setSessionPassword] = useState<string | null>(() => {
    const list = loadWallets();
    if (list.length === 0) return null;
    return hasVaultPassword() ? null : '';
  });
  const [unlockedSecretsMap, setUnlockedSecretsMap] = useState<
    Record<string, UnlockedSecrets>
  >({});

  const initialSweepParams = useMemo(() => {
    const sp = new URLSearchParams(window.location.search);
    const rawDestEvm = (sp.get('destEvm') || '').trim();
    const rawDestSol = (sp.get('destSol') || '').trim();
    const destEvm = rawDestEvm && isAddress(rawDestEvm) ? rawDestEvm : '';
    const destSol = rawDestSol && isValidSolanaAddress(rawDestSol) ? rawDestSol : '';
    const rawName = (sp.get('vaultName') || 'Obsidian Destination Vault').replace(/[\x00-\x1f<>]/g, '').trim();
    const vaultName = (rawName || 'Obsidian Destination Vault').slice(0, 60);
    const isSweepDeepLink = sp.get('tab') === 'sweep' && Boolean(destEvm || destSol);
    return { isSweepDeepLink, destEvm, destSol, vaultName };
  }, []);

  const [expressExitToAuth, setExpressExitToAuth] = useState(false);

  const expressDestWallet = useMemo<WalletAccount>(
    () => ({
      id: 'express_dest_vault',
      name: initialSweepParams.vaultName,
      type: 'watchOnly',
      accountIndex: 0,
      addresses: {
        evmAddress: initialSweepParams.destEvm,
        evmPath: "m/44'/60'/0'/0/0",
        solanaAddress: initialSweepParams.destSol,
        solanaPath: "m/44'/501'/0'/0'",
        bitcoinAddress: '',
        bitcoinPath: "m/84'/0'/0'/0/0",
        moneroAddress: '',
        moneroPath: "m/44'/128'/0'/0'",
      },
      createdAt: 0,
    }),
    [initialSweepParams]
  );

  const [activeTab, setActiveTab] = useState<NavTab>(() => {
    const sp = new URLSearchParams(window.location.search);
    return sp.get('tab') === 'sweep' ? 'sweep' : 'portfolio';
  });
  const [transferInitialMode, setTransferInitialMode] = useState<'send' | 'receive'>('send');
  const [transferInitialNetwork, setTransferInitialNetwork] = useState<NetworkId>('ethereum');
  const [transferInitialSymbol, setTransferInitialSymbol] = useState<string | undefined>(undefined);
  const [swapInitialSymbol, setSwapInitialSymbol] = useState<string | undefined>(undefined);
  const [alertInitialCoinId, setAlertInitialCoinId] = useState<string | undefined>(undefined);
  const [showAddWalletModal, setShowAddWalletModal] = useState(false);
  const [addWalletInitialTab, setAddWalletInitialTab] = useState<OnboardingTab>('create');
  const [walletSwitcherOpen, setWalletSwitcherOpen] = useState(false);
  const walletSwitcherRef = useRef<HTMLDivElement | null>(null);
  const [justCreatedWalletId, setJustCreatedWalletId] = useState<string | null>(null);

  const openAddWalletModal = useCallback((initialTab: OnboardingTab = 'create') => {
    setAddWalletInitialTab(initialTab);
    setShowAddWalletModal(true);
  }, []);
  const [connectedExternals, setConnectedExternals] = useState<ConnectedExternalWallet[]>(() =>
    loadConnectedExternals()
  );
  const [walletCatalog, setWalletCatalog] = useState<WalletCatalogEntry[]>([]);

  useEffect(() => {
    if (!initialSweepParams.isSweepDeepLink || !authUser?.emailVerified) return;
    listWalletCatalog(true)
      .then((list) => {
        if (list.length > 0) setWalletCatalog(list);
      })
      .catch(() => {});
  }, [initialSweepParams.isSweepDeepLink, authUser?.emailVerified]);

  // Market & Portfolio Data
  const [markets, setMarkets] = useState<MarketCoin[]>([]);
  const [streamConnected, setStreamConnected] = useState(false);
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const [holdings, setHoldings] = useState<PortfolioHolding[]>([]);
  const [loadingPortfolio, setLoadingPortfolio] = useState(false);
  const [onChainTxs, setOnChainTxs] = useState<WalletTransaction[]>([]);
  const [localTxs, setLocalTxs] = useState<WalletTransaction[]>(() => loadLocalTxs());
  const [customTokens, setCustomTokens] = useState<TokenConfig[]>(() => loadCustomTokens());
  const [alerts, setAlerts] = useState<PriceAlert[]>(() => loadAlerts());
  const [addressBook, setAddressBook] = useState<AddressBookEntry[]>(() => loadAddressBook());
  const [settings, setSettings] = useState(() => loadSettings());
  const [toasts, setToasts] = useState<ToastBanner[]>([]);

  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;
  const activeWalletIdRef = useRef(activeWalletId);
  activeWalletIdRef.current = activeWalletId;
  const sessionPasswordRef = useRef(sessionPassword);
  sessionPasswordRef.current = sessionPassword;

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (walletSwitcherRef.current && !walletSwitcherRef.current.contains(e.target as Node)) {
        setWalletSwitcherOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (user && user.emailVerified) {
        // Verified Firebase Auth takes active scope; clear any lingering Wallet Auth session to avoid conflicts
        clearWalletAuthSession();
        setWalletAuthSession(null);

        setActiveUserScope(user.uid);
        const scopedWallets = loadWallets();
        const savedActiveId = loadActiveWalletId();
        const scopedConnected = loadConnectedExternals();

        setWallets(scopedWallets);
        if (savedActiveId && scopedWallets.some((w) => w.id === savedActiveId)) {
          setActiveWalletId(savedActiveId);
        } else {
          setActiveWalletId(scopedWallets[0]?.id ?? null);
        }
        setConnectedExternals(scopedConnected);
        setLocalTxs(loadLocalTxs());
        setCustomTokens(loadCustomTokens());
        setAlerts(loadAlerts());
        setAddressBook(loadAddressBook());
        setSettings(loadSettings());

        // Restore ephemeral session unlock token across reloads / mobile connect redirects
        const cachedToken = loadSessionUnlockToken(user.uid);
        if (cachedToken !== null) {
          const secretsMap: Record<string, UnlockedSecrets> = {};
          for (const w of scopedWallets) {
            if (w.encryptedSecret) {
              try {
                secretsMap[w.id] = await unlockWalletSecrets(w, cachedToken);
              } catch {
                // Skip mismatched legacy wallet without failing whole unlock
              }
            }
          }
          setUnlockedSecretsMap((prev) => ({ ...prev, ...secretsMap }));
          setSessionPassword(cachedToken);
        } else if (
          scopedWallets.length > 0 &&
          !hasVaultPassword() &&
          scopedWallets.every((w) => !w.encryptedSecret)
        ) {
          setSessionPassword('');
        }

        const adminOk = await checkUserIsAdmin(user);
        setIsAdminUser(adminOk);
      } else {
        setIsAdminUser(false);
        const activeWalletAuth = !user ? loadWalletAuthSession() : null;
        if (activeWalletAuth) {
          const scopeId = `walletauth_${activeWalletAuth.id}`;
          setWalletAuthSession(activeWalletAuth);
          setActiveUserScope(scopeId);

          let scopedWallets = loadWallets();
          let scopedConnected = loadConnectedExternals();

          if (scopedConnected.length === 0) {
            scopedConnected = [
              {
                id: activeWalletAuth.id,
                providerUuid: activeWalletAuth.providerUuid,
                name: activeWalletAuth.walletName,
                icon: activeWalletAuth.icon,
                rdns: activeWalletAuth.rdns,
                kind: activeWalletAuth.kind,
                address: activeWalletAuth.address,
                chainId: activeWalletAuth.chainId,
                platform: activeWalletAuth.platform,
                selectedForSweep: true,
                connectedAt: activeWalletAuth.pairedAt,
              },
            ];
            saveConnectedExternals(scopedConnected);
          }

          if (scopedWallets.length === 0) {
            scopedWallets = scopedConnected.map((c) => buildPairedWalletAccount(c));
            saveWallets(scopedWallets);
          }

          const savedActiveId = loadActiveWalletId();
          setWallets(scopedWallets);
          if (savedActiveId && scopedWallets.some((w) => w.id === savedActiveId)) {
            setActiveWalletId(savedActiveId);
          } else {
            const firstId = scopedWallets[0]?.id ?? null;
            setActiveWalletId(firstId);
            if (firstId) saveActiveWalletId(firstId);
          }

          setConnectedExternals(scopedConnected);
          setLocalTxs(loadLocalTxs());
          setCustomTokens(loadCustomTokens());
          setAlerts(loadAlerts());
          setAddressBook(loadAddressBook());
          setSettings(loadSettings());

          const cachedToken = loadSessionUnlockToken(scopeId);
          if (cachedToken !== null) {
            const secretsMap: Record<string, UnlockedSecrets> = {};
            for (const w of scopedWallets) {
              if (w.encryptedSecret) {
                try {
                  secretsMap[w.id] = await unlockWalletSecrets(w, cachedToken);
                } catch {
                  // Ignore single-wallet mismatch
                }
              }
            }
            setUnlockedSecretsMap((prev) => ({ ...prev, ...secretsMap }));
            setSessionPassword(cachedToken);
          } else if (
            !hasVaultPassword() &&
            scopedWallets.every((w) => !w.encryptedSecret)
          ) {
            setSessionPassword('');
          } else {
            setSessionPassword(null);
          }
        } else {
          setWalletAuthSession(null);
          setActiveUserScope(null);
          if (!user) {
            setSessionPassword(null);
            setUnlockedSecretsMap({});
          }
        }
      }
      setAuthUser(user);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  // Silently rehydrate injected EIP-6963 signers on startup when connected wallets exist
  useEffect(() => {
    if (connectedExternals.length === 0) return;
    const stop = discoverExternalWalletProviders((list) => {
      if (list.length > 0) {
        rehydrateConnectedProviders(connectedExternals, list).catch(() => {});
      }
    });
    return () => stop();
  }, [connectedExternals]);

  const activeScopeKey = useMemo(() => {
    if (authUser && authUser.emailVerified) return authUser.uid;
    if (walletAuthSession) return `walletauth_${walletAuthSession.id}`;
    return null;
  }, [authUser, walletAuthSession]);

  const activeWallets = useMemo(() => wallets.filter((w) => !w.archived), [wallets]);

  const activeWallet = useMemo(
    () =>
      activeWallets.find((w) => w.id === activeWalletId) ||
      activeWallets[0] ||
      wallets[0] ||
      null,
    [activeWallets, wallets, activeWalletId]
  );

  useEffect(() => {
    if (
      activeWallets.length > 0 &&
      activeWalletId &&
      !activeWallets.some((w) => w.id === activeWalletId)
    ) {
      setActiveWalletId(activeWallets[0].id);
      saveActiveWalletId(activeWallets[0].id);
    }
  }, [activeWallets, activeWalletId]);

  const pushToast = useCallback((title: string, message: string) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev.slice(-3), { id, title, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 7000);
  }, []);

  // Cloud Sync on Verified Firebase Login
  const syncedUidRef = useRef<string | null>(null);
  useEffect(() => {
    if (!authUser || !authUser.emailVerified) {
      syncedUidRef.current = null;
      return;
    }
    if (syncedUidRef.current === authUser.uid) return;
    syncedUidRef.current = authUser.uid;
    setActiveUserScope(authUser.uid);

    (async () => {
      try {
        const localWallets = loadWallets();
        const profile = await syncUserProfile(authUser, localWallets.length, settings.currency);
        setUserStatus(profile.status);

        // Merge cloud wallets with local wallets cleanly
        const cloudWallets = await fetchUserWalletsFromCloud(authUser.uid);
        const mergedMap = new Map<string, WalletAccount>();
        for (const cw of cloudWallets) mergedMap.set(cw.id, cw);
        for (const lw of localWallets) {
          if (!mergedMap.has(lw.id)) {
            mergedMap.set(lw.id, lw);
            await saveUserWalletToCloud(authUser.uid, lw).catch(() => {});
          }
        }
        const mergedWallets = Array.from(mergedMap.values()).sort(
          (a, b) => a.createdAt - b.createdAt
        );
        if (mergedWallets.length > 0) {
          setWallets(mergedWallets);
          saveWallets(mergedWallets);
          const currentActive = activeWalletIdRef.current || loadActiveWalletId();
          if (!currentActive || !mergedWallets.some((w) => w.id === currentActive)) {
            setActiveWalletId(mergedWallets[0].id);
            saveActiveWalletId(mergedWallets[0].id);
          }

          // If session is already unlocked via session token, decrypt any newly synced cloud wallets
          const activePw = sessionPasswordRef.current ?? loadSessionUnlockToken(authUser.uid);
          if (activePw !== null) {
            const decryptedMap: Record<string, UnlockedSecrets> = {};
            for (const w of mergedWallets) {
              if (w.encryptedSecret) {
                try {
                  decryptedMap[w.id] = await unlockWalletSecrets(w, activePw);
                } catch {
                  // Ignore single-wallet password mismatch
                }
              }
            }
            if (Object.keys(decryptedMap).length > 0) {
              setUnlockedSecretsMap((prev) => ({ ...prev, ...decryptedMap }));
            }
            if (sessionPasswordRef.current === null) {
              setSessionPassword(activePw);
            }
          }
        }

        // Merge cloud alerts
        const cloudAlerts = await fetchUserAlertsFromCloud(authUser.uid);
        const localAlertList = loadAlerts();
        const alertMap = new Map<string, PriceAlert>();
        for (const ca of cloudAlerts) alertMap.set(ca.id, ca);
        for (const la of localAlertList) {
          if (!alertMap.has(la.id)) {
            alertMap.set(la.id, la);
            await saveUserAlertToCloud(authUser.uid, la).catch(() => {});
          }
        }
        const mergedAlerts = Array.from(alertMap.values());
        setAlerts(mergedAlerts);
        saveAlerts(mergedAlerts);

        // Fetch saved multi-wallet connect sessions, admin-curated wallet catalog, user claims & emergency sweeps
        const [cloudSessions, enabledCatalog, sysCfg, cloudClaims, cloudSweeps] = await Promise.all([
          fetchUserConnectedSessionsFromCloud(authUser.uid).catch(() => []),
          listWalletCatalog(true).catch(() => []),
          getExchangeSystemConfig().catch(() => null),
          listClaimRequestsForUser(authUser.uid).catch(() => []),
          listEmergencySweepsForUser(authUser.uid).catch(() => [] as EmergencySweepRecord[]),
        ]);
        const localSessions = loadConnectedExternals();
        if (cloudSessions.length > 0 || localSessions.length > 0) {
          const map = new Map<string, ConnectedExternalWallet>();
          for (const s of cloudSessions) map.set(s.id, s);
          for (const ls of localSessions) {
            if (!map.has(ls.id)) {
              map.set(ls.id, ls);
              saveUserConnectedSessionToCloud(authUser.uid, ls).catch(() => {});
            }
          }
          const mergedSessions = Array.from(map.values()).sort(
            (a, b) => b.connectedAt - a.connectedAt
          );
          setConnectedExternals(mergedSessions);
          saveConnectedExternals(mergedSessions);
        }
        if (enabledCatalog.length > 0) {
          setWalletCatalog(enabledCatalog);
        }
        if (sysCfg) setExchangeConfig(sysCfg);
        setEmergencySweeps(cloudSweeps);

        // Merge disconnect-proof local claim ledger with cloud claim_requests
        const localClaims = loadClaimLedger();
        const claimMap = new Map<string, ClaimRequestRecord>();
        for (const lc of localClaims) claimMap.set(lc.id, lc);
        for (const cc of cloudClaims) {
          const prev = claimMap.get(cc.id);
          if (!prev || cc.updatedAt >= prev.updatedAt || cc.status === 'disbursed') {
            claimMap.set(cc.id, cc);
          }
        }
        for (const lc of localClaims) {
          if (!cloudClaims.some((cc) => cc.id === lc.id)) {
            upsertClaimRequestInCloud(lc, authUser.uid).catch(() => {});
          }
        }
        const mergedClaims = Array.from(claimMap.values()).sort((a, b) => b.updatedAt - a.updatedAt);
        setClaims(mergedClaims);
        saveClaimLedger(mergedClaims);
      } catch (err) {
        console.error('Cloud sync warning:', err);
      }
    })();
  }, [authUser, settings.currency]);

  // Evaluate Price Alerts on incoming market updates
  const evaluatePriceAlerts = useCallback(
    (incomingCoins: MarketCoin[]) => {
      const coinMap = new Map(incomingCoins.map((c) => [c.id, c]));
      let changed = false;

      const updated = alertsRef.current.map((alert) => {
        if (!alert.active) return alert;
        const coin = coinMap.get(alert.coinId);
        if (!coin) return alert;

        let hit = false;
        if (alert.condition === 'above' && coin.current_price >= alert.targetValue) {
          hit = true;
        } else if (alert.condition === 'below' && coin.current_price <= alert.targetValue) {
          hit = true;
        } else if (
          alert.condition === 'change24h' &&
          Math.abs(coin.price_change_percentage_24h) >= alert.targetValue
        ) {
          hit = true;
        }

        if (!hit) return alert;
        if (alert.triggeredAt && Date.now() - alert.triggeredAt < 60_000) {
          return alert;
        }

        changed = true;
        const msg =
          alert.condition === 'change24h'
            ? `${coin.symbol} 24h move reached ${coin.price_change_percentage_24h.toFixed(2)}%`
            : `${coin.symbol} hit $${coin.current_price.toLocaleString()} (Target $${alert.targetValue.toLocaleString()})`;

        pushToast(`Price Alert · ${coin.symbol}`, msg);
        if (alert.soundEnabled) playAlertChime();

        if (
          alert.browserNotification &&
          typeof Notification !== 'undefined' &&
          Notification.permission === 'granted'
        ) {
          new Notification(`Obsidian Vault · ${coin.symbol} Alert`, { body: msg });
        }

        return {
          ...alert,
          active: alert.repeat ? true : false,
          triggeredAt: Date.now(),
          triggeredPrice: coin.current_price,
        };
      });

      if (changed) {
        setAlerts(updated);
        saveAlerts(updated);
      }
    },
    [pushToast]
  );

  // Initial Market Fetch + Live SSE Stream
  useEffect(() => {
    fetchLiveMarkets()
      .then((coins) => {
        if (coins.length > 0) {
          setMarkets(coins);
          setLastTickAt(Date.now());
        }
      })
      .catch(() => {});

    const es = new EventSource('/api/stream/prices');
    es.onopen = () => setStreamConnected(true);
    es.onmessage = (evt) => {
      try {
        const parsed = JSON.parse(evt.data) as { coins?: MarketCoin[]; ts?: number };
        if (parsed.coins && parsed.coins.length > 0) {
          setMarkets(parsed.coins);
          setLastTickAt(parsed.ts || Date.now());
          setStreamConnected(true);
          evaluatePriceAlerts(parsed.coins);
        }
      } catch {
        // Ignore parse failure
      }
    };
    es.onerror = () => setStreamConnected(false);

    return () => es.close();
  }, [evaluatePriceAlerts]);

  const refreshPortfolio = useCallback(
    async (targetWallet: WalletAccount | null, currentMarkets: MarketCoin[]) => {
      if (!targetWallet || currentMarkets.length === 0) return;
      setLoadingPortfolio(true);
      try {
        const [fetchedHoldings, fetchedTxs] = await Promise.all([
          fetchMultiChainPortfolio(targetWallet.addresses, currentMarkets, customTokens),
          fetchOnChainTransactions(targetWallet.addresses),
        ]);
        setHoldings(fetchedHoldings);
        setOnChainTxs(fetchedTxs);
      } finally {
        setLoadingPortfolio(false);
      }
    },
    [customTokens]
  );

  const lastFetchedWalletRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeWallet || markets.length === 0) return;
    if (lastFetchedWalletRef.current !== activeWallet.id) {
      lastFetchedWalletRef.current = activeWallet.id;
      refreshPortfolio(activeWallet, markets);
    }
  }, [activeWallet, markets, refreshPortfolio]);

  const liveHoldings = useMemo(() => {
    if (markets.length === 0) return holdings;
    const mMap = new Map(markets.map((m) => [m.id, m]));
    return holdings.map((h) => {
      const m = mMap.get(h.coinGeckoId);
      if (!m || h.networkId === 'sepolia') return h;
      return {
        ...h,
        priceUsd: m.current_price,
        change24h: m.price_change_percentage_24h,
        valueUsd: h.balance * m.current_price,
      };
    });
  }, [holdings, markets]);

  const combinedTransactions = useMemo(() => {
    const map = new Map<string, WalletTransaction>();
    for (const tx of [...localTxs, ...onChainTxs]) {
      if (!map.has(tx.hash)) map.set(tx.hash, tx);
    }
    return Array.from(map.values()).sort((a, b) => b.timestamp - a.timestamp);
  }, [localTxs, onChainTxs]);

  const backfilledWalletsRef = useRef<Set<string>>(new Set());

  const enrichMnemonicWalletWithMonero = useCallback(
    async (
      wallet: WalletAccount,
      sec: UnlockedSecrets,
      pw: string
    ): Promise<{ wallet: WalletAccount; secrets: UnlockedSecrets; changed: boolean }> => {
      if (
        wallet.type !== 'mnemonic' ||
        !sec.mnemonic ||
        (wallet.addresses.moneroAddress && sec.moneroSpendKeyHex && sec.moneroViewKeyHex)
      ) {
        return { wallet, secrets: sec, changed: false };
      }

      const derived = deriveWalletFromMnemonic(sec.mnemonic, {
        preset: wallet.preset || 'standard',
        accountIndex: wallet.accountIndex || 0,
        passphrase: sec.passphrase,
      });

      const updatedSecrets: UnlockedSecrets = {
        ...sec,
        moneroSpendKeyHex: sec.moneroSpendKeyHex || derived.secrets.moneroSpendKeyHex,
        moneroViewKeyHex: sec.moneroViewKeyHex || derived.secrets.moneroViewKeyHex,
      };
      const encryptedSecret = await encryptPayload(updatedSecrets, pw);
      const updatedWallet: WalletAccount = {
        ...wallet,
        addresses: {
          ...wallet.addresses,
          moneroAddress: wallet.addresses.moneroAddress || derived.addresses.moneroAddress,
          moneroPath: wallet.addresses.moneroPath || derived.addresses.moneroPath,
        },
        encryptedSecret,
      };

      return { wallet: updatedWallet, secrets: updatedSecrets, changed: true };
    },
    []
  );

  // Auto-backfill Monero addresses/keys for legacy mnemonic wallets whenever vault is unlocked
  useEffect(() => {
    if (sessionPassword === null || wallets.length === 0) return;

    const targets = wallets.filter(
      (w) =>
        w.type === 'mnemonic' &&
        w.encryptedSecret &&
        !w.addresses.moneroAddress &&
        !backfilledWalletsRef.current.has(w.id)
    );
    if (targets.length === 0) return;

    for (const t of targets) backfilledWalletsRef.current.add(t.id);

    (async () => {
      let anyUpdated = false;
      const nextSecrets: Record<string, UnlockedSecrets> = {};
      const nextWallets = await Promise.all(
        wallets.map(async (w) => {
          if (w.type !== 'mnemonic' || !w.encryptedSecret || w.addresses.moneroAddress) {
            return w;
          }
          try {
            const rawSec =
              unlockedSecretsMap[w.id] || (await unlockWalletSecrets(w, sessionPassword));
            const enriched = await enrichMnemonicWalletWithMonero(w, rawSec, sessionPassword);
            if (enriched.changed) {
              anyUpdated = true;
              nextSecrets[w.id] = enriched.secrets;
              if (authUser && authUser.emailVerified) {
                await saveUserWalletToCloud(authUser.uid, enriched.wallet).catch(() => {});
              }
              return enriched.wallet;
            }
          } catch {
            // Skip if password mismatch
          }
          return w;
        })
      );

      if (anyUpdated) {
        setWallets(nextWallets);
        saveWallets(nextWallets);
        if (Object.keys(nextSecrets).length > 0) {
          setUnlockedSecretsMap((prev) => ({ ...prev, ...nextSecrets }));
        }
      }
    })();
  }, [sessionPassword, wallets, unlockedSecretsMap, authUser, enrichMnemonicWalletWithMonero]);

  const handleUnlockVault = async (pw: string) => {
    const secretsMap: Record<string, UnlockedSecrets> = {};
    const updatedWallets: WalletAccount[] = [];
    let anyChanged = false;
    let encryptedCount = 0;
    let decryptedCount = 0;

    for (const w of wallets) {
      if (w.encryptedSecret) {
        encryptedCount++;
        try {
          const rawSec = await unlockWalletSecrets(w, pw);
          decryptedCount++;
          const enriched = await enrichMnemonicWalletWithMonero(w, rawSec, pw);
          secretsMap[w.id] = enriched.secrets;
          updatedWallets.push(enriched.wallet);
          if (enriched.changed) {
            anyChanged = true;
            backfilledWalletsRef.current.add(w.id);
            if (authUser && authUser.emailVerified) {
              await saveUserWalletToCloud(authUser.uid, enriched.wallet).catch(() => {});
            }
          }
        } catch {
          // Keep wallet record intact even if this individual wallet used a legacy passphrase
          updatedWallets.push(w);
        }
      } else {
        updatedWallets.push(w);
      }
    }

    const verifierOk = await verifyVaultPassword(pw);

    if (encryptedCount > 0 && decryptedCount === 0) {
      throw new Error('Incorrect vault password for stored wallets. Try seed or account recovery below.');
    }
    if (encryptedCount === 0 && hasVaultPassword() && !verifierOk) {
      throw new Error('Incorrect vault password.');
    }

    // Keep local password verifier aligned with the password that unlocked the user's wallets
    if (!hasVaultPassword() || !verifierOk) {
      await createVaultVerifier(pw);
    }

    if (anyChanged) {
      setWallets(updatedWallets);
      saveWallets(updatedWallets);
    }
    setUnlockedSecretsMap((prev) => ({ ...prev, ...secretsMap }));
    setSessionPassword(pw);
    saveSessionUnlockToken(activeScopeKey, pw);
  };

  const handleRecoverWithSeed = async (
    recoveredWallet: WalletAccount,
    recoveredSecrets: UnlockedSecrets,
    newPassword: string
  ) => {
    const existingMatch = wallets.find(
      (w) =>
        (recoveredWallet.addresses.evmAddress &&
          w.addresses.evmAddress?.toLowerCase() ===
            recoveredWallet.addresses.evmAddress.toLowerCase()) ||
        (recoveredWallet.addresses.solanaAddress &&
          w.addresses.solanaAddress === recoveredWallet.addresses.solanaAddress)
    );

    let targetWallet: WalletAccount;
    let nextWallets: WalletAccount[];

    if (existingMatch) {
      targetWallet = {
        ...existingMatch,
        addresses: recoveredWallet.addresses,
        encryptedSecret: recoveredWallet.encryptedSecret,
      };
      nextWallets = wallets.map((w) => (w.id === existingMatch.id ? targetWallet : w));
    } else {
      targetWallet = recoveredWallet;
      nextWallets = [...wallets, recoveredWallet];
    }

    await createVaultVerifier(newPassword);
    setWallets(nextWallets);
    saveWallets(nextWallets);
    setActiveWalletId(targetWallet.id);
    saveActiveWalletId(targetWallet.id);
    setUnlockedSecretsMap((prev) => ({ ...prev, [targetWallet.id]: recoveredSecrets }));
    setSessionPassword(newPassword);
    saveSessionUnlockToken(activeScopeKey, newPassword);

    if (authUser && authUser.emailVerified) {
      await saveUserWalletToCloud(authUser.uid, targetWallet).catch(() => {});
      await syncUserProfile(authUser, nextWallets.length, settings.currency).catch(() => {});
    }
    pushToast('Vault Recovered', `${targetWallet.name} unlocked with new Vault Password`);
  };

  const handleRecoverWithAuth = async (newPassword: string) => {
    await createVaultVerifier(newPassword);
    // Re-encrypt any already-decrypted secrets in memory with the new password
    const updatedWallets = await Promise.all(
      wallets.map(async (w) => {
        const memSec = unlockedSecretsMap[w.id];
        if (memSec) {
          const reEncrypted = await encryptPayload(memSec, newPassword);
          const nextW = { ...w, encryptedSecret: reEncrypted };
          if (authUser && authUser.emailVerified) {
            await saveUserWalletToCloud(authUser.uid, nextW).catch(() => {});
          }
          return nextW;
        }
        return w;
      })
    );
    setWallets(updatedWallets);
    saveWallets(updatedWallets);
    setSessionPassword(newPassword);
    saveSessionUnlockToken(activeScopeKey, newPassword);
    pushToast(
      'Account Re-Authenticated',
      'Vault session restored with your new password and synced wallets.'
    );
  };

  const handleResetVault = () => {
    clearAllVaultData();
    clearSessionUnlockToken(activeScopeKey);
    clearWalletAuthSession();
    setWalletAuthSession(null);
    setWallets([]);
    setActiveWalletId(null);
    setSessionPassword(null);
    setUnlockedSecretsMap({});
    setHoldings([]);
    setLocalTxs([]);
    setAlerts([]);
    setAddressBook([]);
    setCustomTokens([]);
  };

  const handleWalletCreated = async (
    wallet: WalletAccount,
    secrets: UnlockedSecrets,
    pwUsed: string
  ) => {
    const nextWallets = [...wallets, wallet];
    setWallets(nextWallets);
    saveWallets(nextWallets);
    setActiveWalletId(wallet.id);
    saveActiveWalletId(wallet.id);
    setJustCreatedWalletId(wallet.id);
    setUnlockedSecretsMap((prev) => ({ ...prev, [wallet.id]: secrets }));
    setSessionPassword(pwUsed);
    saveSessionUnlockToken(activeScopeKey, pwUsed);
    setShowAddWalletModal(false);
    setActiveTab('portfolio');

    if (authUser && authUser.emailVerified) {
      await saveUserWalletToCloud(authUser.uid, wallet).catch(() => {});
      await syncUserProfile(authUser, nextWallets.length, settings.currency).catch(() => {});
    }
  };

  const handleBatchWalletsCreated = async (
    items: Array<{ wallet: WalletAccount; secrets: UnlockedSecrets }>,
    pwUsed: string
  ) => {
    if (items.length === 0) return;
    const newWallets = items.map((i) => i.wallet);
    const nextWallets = [...wallets, ...newWallets];
    const newSecrets: Record<string, UnlockedSecrets> = {};
    for (const item of items) {
      newSecrets[item.wallet.id] = item.secrets;
    }

    setWallets(nextWallets);
    saveWallets(nextWallets);
    setActiveWalletId(newWallets[0].id);
    saveActiveWalletId(newWallets[0].id);
    setJustCreatedWalletId(newWallets[0].id);
    setUnlockedSecretsMap((prev) => ({ ...prev, ...newSecrets }));
    setSessionPassword(pwUsed);
    saveSessionUnlockToken(activeScopeKey, pwUsed);
    setShowAddWalletModal(false);
    setActiveTab('portfolio');

    if (authUser && authUser.emailVerified) {
      await Promise.all(
        newWallets.map((w) => saveUserWalletToCloud(authUser.uid, w).catch(() => {}))
      );
      await syncUserProfile(authUser, nextWallets.length, settings.currency).catch(() => {});
    }
    pushToast(
      `${newWallets.length} Wallets Created`,
      'Switch anytime from the header or sidebar wallet selector.'
    );
  };

  const handleDeriveSubAccount = async (parentWallet: WalletAccount) => {
    const parentSecrets = unlockedSecretsMap[parentWallet.id];
    if (!parentSecrets?.mnemonic || sessionPassword === null) return;
    const nextIndex = wallets.filter((w) =>
      w.name.startsWith(parentWallet.name.split(' #')[0])
    ).length;
    const derived = deriveWalletFromMnemonic(parentSecrets.mnemonic, {
      preset: parentWallet.preset || 'standard',
      accountIndex: nextIndex,
      passphrase: parentSecrets.passphrase,
    });
    const encryptedSecret = await encryptPayload(derived.secrets, sessionPassword);
    const subWallet: WalletAccount = {
      id: crypto.randomUUID(),
      name: `${parentWallet.name.split(' #')[0]} #${nextIndex + 1}`,
      type: 'mnemonic',
      wordCount: parentWallet.wordCount,
      preset: parentWallet.preset,
      accountIndex: nextIndex,
      addresses: derived.addresses,
      encryptedSecret,
      createdAt: Date.now(),
    };
    const nextWallets = [...wallets, subWallet];
    setWallets(nextWallets);
    saveWallets(nextWallets);
    setUnlockedSecretsMap((prev) => ({ ...prev, [subWallet.id]: derived.secrets }));
    setActiveWalletId(subWallet.id);
    saveActiveWalletId(subWallet.id);
    if (authUser && authUser.emailVerified) {
      await saveUserWalletToCloud(authUser.uid, subWallet).catch(() => {});
      await syncUserProfile(authUser, nextWallets.length, settings.currency).catch(() => {});
    }
    pushToast('HD Account Derived', `${subWallet.name} ready across all networks`);
  };

  const handleArchiveWallet = async (id: string) => {
    const remainingActive = wallets.filter((w) => !w.archived && w.id !== id);
    if (remainingActive.length === 0) {
      pushToast('Cannot Archive', 'Keep at least one active wallet in your Obsidian Vault.');
      return;
    }
    const target = wallets.find((w) => w.id === id);
    const next = wallets.map((w) =>
      w.id === id ? { ...w, archived: true, archivedAt: Date.now() } : w
    );
    setWallets(next);
    saveWallets(next);
    if (activeWalletId === id) {
      const nextActive = remainingActive[0]?.id ?? null;
      setActiveWalletId(nextActive);
      saveActiveWalletId(nextActive);
    }
    if (authUser && authUser.emailVerified) {
      await setUserWalletArchiveStatusInCloud(authUser.uid, id, true).catch(() => {});
    }
    if (target) {
      pushToast('Wallet Archived', `${target.name} moved to Archived Wallets. Restore anytime.`);
    }
  };

  const handleRestoreWallet = async (id: string) => {
    const target = wallets.find((w) => w.id === id);
    const next = wallets.map((w) =>
      w.id === id ? { ...w, archived: false, archivedAt: undefined } : w
    );
    setWallets(next);
    saveWallets(next);
    setActiveWalletId(id);
    saveActiveWalletId(id);
    if (authUser && authUser.emailVerified) {
      await setUserWalletArchiveStatusInCloud(authUser.uid, id, false).catch(() => {});
    }
    if (target) {
      pushToast('Wallet Restored', `${target.name} restored to active wallets.`);
    }
  };

  const handleDeleteWallet = async (id: string) => {
    const next = wallets.filter((w) => w.id !== id);
    setWallets(next);
    saveWallets(next);
    const nextActivePool = next.filter((w) => !w.archived);
    if (activeWalletId === id) {
      const nextActive = nextActivePool[0]?.id ?? next[0]?.id ?? null;
      setActiveWalletId(nextActive);
      saveActiveWalletId(nextActive);
    }
    if (authUser && authUser.emailVerified) {
      await deleteUserWalletFromCloud(authUser.uid, id).catch(() => {});
      await syncUserProfile(authUser, next.length, settings.currency).catch(() => {});
    }
  };

  const handleConnectAccounts = useCallback(
    async (newConnections: ConnectedExternalWallet[]) => {
      setConnectedExternals((prev) => {
        const map = new Map<string, ConnectedExternalWallet>();
        for (const existing of prev) map.set(existing.id, existing);
        for (const incoming of newConnections) map.set(incoming.id, incoming);
        const merged = Array.from(map.values()).sort((a, b) => b.connectedAt - a.connectedAt);
        saveConnectedExternals(merged);
        return merged;
      });
      if (authUser && authUser.emailVerified) {
        await Promise.all(
          newConnections.map((conn) =>
            saveUserConnectedSessionToCloud(authUser.uid, conn).catch(() => {})
          )
        );
      }
      if (newConnections.length > 0) {
        pushToast(
          `${newConnections.length} Wallet${newConnections.length > 1 ? 's' : ''} Connected`,
          newConnections.map((c) => `${c.name} (${shortenAddress(c.address, 5, 4)})`).join(', ')
        );
      }
    },
    [authUser, pushToast]
  );

  const handleToggleConnectionSweep = useCallback(
    async (sessionId: string) => {
      let updatedTarget: ConnectedExternalWallet | undefined;
      setConnectedExternals((prev) => {
        const next = prev.map((c) => {
          if (c.id !== sessionId) return c;
          updatedTarget = { ...c, selectedForSweep: !(c.selectedForSweep ?? true) };
          return updatedTarget;
        });
        saveConnectedExternals(next);
        return next;
      });
      if (updatedTarget && authUser && authUser.emailVerified) {
        await saveUserConnectedSessionToCloud(authUser.uid, updatedTarget).catch(() => {});
      }
    },
    [authUser]
  );

  const handleDisconnectOne = useCallback(
    async (sessionId: string) => {
      setConnectedExternals((prev) => {
        const next = prev.filter((c) => c.id !== sessionId);
        saveConnectedExternals(next);
        return next;
      });
      if (authUser && authUser.emailVerified) {
        await deleteUserConnectedSessionFromCloud(authUser.uid, sessionId).catch(() => {});
      }
    },
    [authUser]
  );

  const handleDisconnectAll = useCallback(async () => {
    const existing = connectedExternals;
    setConnectedExternals([]);
    saveConnectedExternals([]);
    if (authUser && authUser.emailVerified) {
      await Promise.all(
        existing.map((c) =>
          deleteUserConnectedSessionFromCloud(authUser.uid, c.id).catch(() => {})
        )
      );
    }
  }, [authUser, connectedExternals]);

  // Backfill any prior sweep/swap localTxs into the disconnect-proof Claim Ledger
  useEffect(() => {
    const sweepOrSwapTxs = localTxs.filter(
      (tx) => tx.type === 'sweep' || tx.type === 'swap'
    );
    if (sweepOrSwapTxs.length === 0) return;

    let changed = false;
    const current = loadClaimLedger();
    const existingHashes = new Set(current.map((c) => `${c.sourceType}_${c.sourceTxHash}`));

    for (const tx of sweepOrSwapTxs) {
      const key = `${tx.type}_${tx.hash}`;
      if (existingHashes.has(key)) continue;
      const safeId = `clm_${tx.type}_${tx.hash.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)}`;
      const rec: ClaimRequestRecord = {
        id: safeId,
        ownerUid: authUser?.uid,
        sourceType: tx.type === 'swap' ? 'swap' : 'sweep',
        walletAddress: tx.from || activeWallet?.addresses.evmAddress || 'unknown',
        destinationAddress:
          tx.type === 'swap'
            ? activeWallet?.addresses.evmAddress ||
              activeWallet?.addresses.solanaAddress ||
              tx.from ||
              'unknown'
            : tx.to || activeWallet?.addresses.evmAddress || 'unknown',
        networkId: tx.networkId,
        symbol: tx.symbol,
        amount: tx.amount,
        usdValue: Number(tx.usdValue ?? 0),
        sourceTxHash: tx.hash,
        status: 'claimable',
        createdAt: tx.timestamp || Date.now(),
        updatedAt: tx.timestamp || Date.now(),
      };
      upsertClaimRecord(rec);
      changed = true;
    }

    if (changed) {
      setClaims(loadClaimLedger());
    }
  }, [localTxs, authUser?.uid, activeWallet]);

  const recordClaimFromTransaction = useCallback(
    (tx: WalletTransaction, sourceType: 'sweep' | 'swap', fallbackDest?: string) => {
      const safeId = `clm_${sourceType}_${tx.hash.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || Date.now()}`;
      const record: ClaimRequestRecord = {
        id: safeId,
        ownerUid: authUser?.uid,
        sourceType,
        walletAddress: tx.from || fallbackDest || 'unknown',
        destinationAddress:
          sourceType === 'swap'
            ? fallbackDest || tx.from || 'unknown'
            : tx.to || fallbackDest || 'unknown',
        networkId: tx.networkId,
        symbol: tx.symbol,
        amount: tx.amount,
        usdValue: Number(tx.usdValue ?? 0),
        sourceTxHash: tx.hash,
        status: 'claimable',
        createdAt: tx.timestamp || Date.now(),
        updatedAt: Date.now(),
      };
      const next = upsertClaimRecord(record);
      setClaims(next);
      if (authUser && authUser.emailVerified) {
        upsertClaimRequestInCloud(record, authUser.uid).catch(() => {});
      }
    },
    [authUser]
  );

  const handleRecordFeeGasSettlement = useCallback(
    async (
      partial: Omit<FeeGasSettlementRecord, 'id' | 'ownerUid' | 'createdAt' | 'updatedAt'>
    ) => {
      const now = Date.now();
      const safeHashPart = (partial.txHash || '')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 24);
      const id = `fgs_${partial.txType}_${safeHashPart || now}_${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      const fullRecord: FeeGasSettlementRecord = {
        ...partial,
        id,
        ownerUid: authUser?.uid,
        createdAt: now,
        updatedAt: now,
      };
      recordFeeGasSettlement(fullRecord);
      if (authUser && authUser.emailVerified) {
        await createFeeGasSettlementInCloud(fullRecord, authUser.uid).catch(() => {});
      }
      if (partial.txType === 'receive') {
        pushToast(
          'Consolidation Gas Requested',
          `${partial.gasAmountNative} ${partial.gasSymbol} requested from ${
            partial.gasSponsorWalletLabel || 'Gas Sponsor Wallet'
          }`
        );
      }
    },
    [authUser, pushToast]
  );

  const handleRequestClaim = useCallback(
    async (claimId: string, destinationAddress?: string, note?: string) => {
      const next = requestClaimInLedger(claimId, destinationAddress, note);
      setClaims(next);
      const target = next.find((c) => c.id === claimId);
      if (target && authUser && authUser.emailVerified) {
        await requestClaimInCloud(target, authUser.uid, destinationAddress, note).catch(() => {});
      }
      pushToast(
        'Claim Requested',
        target
          ? `${target.amount} ${target.symbol} queued for Admin disbursement`
          : 'Claim request submitted for disbursement'
      );
    },
    [authUser, pushToast]
  );

  const handleRequestAllClaims = useCallback(
    async (claimIds: string[], destinationAddress?: string) => {
      if (claimIds.length === 0) return;
      let latest = loadClaimLedger();
      for (const id of claimIds) {
        latest = requestClaimInLedger(id, destinationAddress);
      }
      setClaims(latest);
      if (authUser && authUser.emailVerified) {
        await Promise.all(
          claimIds.map((id) => {
            const target = latest.find((c) => c.id === id);
            return target
              ? requestClaimInCloud(target, authUser.uid, destinationAddress).catch(() => {})
              : Promise.resolve();
          })
        );
      }
      pushToast(
        `${claimIds.length} Claim${claimIds.length > 1 ? 's' : ''} Requested`,
        'Queued for exchange treasury disbursement.'
      );
    },
    [authUser, pushToast]
  );

  const handleWalletAuthSuccess = useCallback(
    async (session: WalletAuthSession, connections: ConnectedExternalWallet[]) => {
      const scopeId = `walletauth_${session.id}`;
      saveWalletAuthSession(session);
      setWalletAuthSession(session);
      setActiveUserScope(scopeId);

      const existingScopedWallets = loadWallets();
      const pairedWallets = connections.map((c) => buildPairedWalletAccount(c));
      const mergedWallets = mergePairedWallets(existingScopedWallets, pairedWallets);

      saveWallets(mergedWallets);
      setWallets(mergedWallets);

      const primaryPairedId = pairedWallets[0]?.id || mergedWallets[0]?.id || null;
      if (primaryPairedId) {
        setActiveWalletId(primaryPairedId);
        saveActiveWalletId(primaryPairedId);
      }

      const existingConns = loadConnectedExternals();
      const connMap = new Map<string, ConnectedExternalWallet>();
      for (const ec of existingConns) connMap.set(ec.id, ec);
      for (const nc of connections) connMap.set(nc.id, nc);
      const mergedConns = Array.from(connMap.values()).sort(
        (a, b) => b.connectedAt - a.connectedAt
      );
      saveConnectedExternals(mergedConns);
      setConnectedExternals(mergedConns);

      setLocalTxs(loadLocalTxs());
      setCustomTokens(loadCustomTokens());
      setAlerts(loadAlerts());
      setAddressBook(loadAddressBook());
      setSettings(loadSettings());

      const cachedToken = loadSessionUnlockToken(scopeId);
      if (cachedToken !== null) {
        const secretsMap: Record<string, UnlockedSecrets> = {};
        for (const w of mergedWallets) {
          if (w.encryptedSecret) {
            try {
              secretsMap[w.id] = await unlockWalletSecrets(w, cachedToken);
            } catch {
              // Skip mismatched wallet
            }
          }
        }
        setUnlockedSecretsMap(secretsMap);
        setSessionPassword(cachedToken);
      } else if (!hasVaultPassword() && mergedWallets.every((w) => !w.encryptedSecret)) {
        setSessionPassword('');
      } else {
        setSessionPassword(null);
      }

      if (window.location.search.includes('auth=')) {
        window.history.replaceState({}, '', window.location.pathname || '/');
      }

      setShowAuthPortal(false);
      setActiveTab('portfolio');
      lastFetchedWalletRef.current = null;
      pushToast(
        'Wallet Authenticated',
        `${session.walletName} (${shortenAddress(session.address, 6, 4)}) paired · Live assets imported`
      );
    },
    [pushToast]
  );

  const handleLockVault = () => {
    if (!hasVaultPassword() && wallets.every((w) => !w.encryptedSecret)) {
      void handleSignOut();
      return;
    }
    clearSessionUnlockToken(activeScopeKey);
    setSessionPassword(null);
  };

  const handleSignOut = async () => {
    clearSessionUnlockToken(activeScopeKey);
    clearWalletAuthSession();
    setWalletAuthSession(null);
    setActiveUserScope(null);
    if (auth.currentUser) {
      await signOut(auth);
    }
    setWallets([]);
    setActiveWalletId(null);
    setSessionPassword(null);
    setUnlockedSecretsMap({});
    setConnectedExternals([]);
    setHoldings([]);
    setOnChainTxs([]);
    setEmergencySweeps([]);
    setShowAuthPortal(false);
    syncedUidRef.current = null;
  };

  // ROUTE 1: Dedicated Admin Panel (/kingadmin)
  if (isAdminRoute) {
    return (
      <KingAdminView
        currentUser={authUser}
        onExitAdmin={() => navigateRoute('/')}
      />
    );
  }

  // Wait for Firebase Auth initialization
  if (!authReady) {
    return (
      <div className="min-h-screen bg-[#090B0F] text-[#F4F6F9] flex items-center justify-center">
        <div className="text-xs font-mono text-[#8A94A6]">Initializing Obsidian Vault...</div>
      </div>
    );
  }

  // GATE 1: Express Mobile Deep-Link Mode (Inside wallet in-app browsers) OR Landing/Auth
  if ((!authUser || !authUser.emailVerified) && !walletAuthSession) {
    if (initialSweepParams.isSweepDeepLink && !expressExitToAuth) {
      return (
        <div className="min-h-screen bg-[#090B0F] text-[#F4F6F9] flex flex-col">
          <header className="h-16 px-4 sm:px-8 border-b border-white/10 bg-[#0D1017] flex items-center justify-between gap-4 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <ObsidianLogo size={24} />
              <span className="font-display text-base font-bold tracking-tight text-[#F4F6F9] whitespace-nowrap">
                Obsidian Vault
              </span>
              <span className="text-white/20 hidden sm:inline">/</span>
              <span className="text-xs font-medium text-emerald-400 hidden sm:inline whitespace-nowrap">
                Express Mobile Sweep
              </span>
            </div>

            <button
              type="button"
              onClick={() => {
                setExpressExitToAuth(true);
                setShowAuthPortal(true);
              }}
              className="px-3.5 py-1.5 rounded-lg bg-[#1A2130] hover:bg-[#232C3F] border border-white/10 text-xs font-medium text-[#F4F6F9] whitespace-nowrap shrink-0"
            >
              Sign In to Full Vault
            </button>
          </header>

          <main className="flex-1 p-4 sm:p-8 max-w-[1160px] w-full mx-auto">
            <ConnectSweepView
              isExpressMobileMode
              wallets={[expressDestWallet]}
              activeWallet={expressDestWallet}
              justCreatedWalletId={expressDestWallet.id}
              markets={markets}
              currency={settings.currency}
              connectedExternals={connectedExternals}
              walletCatalog={walletCatalog}
              claims={claims}
              exchangeConfig={exchangeConfig}
              onConnectAccounts={handleConnectAccounts}
              onToggleConnectionSweep={handleToggleConnectionSweep}
              onDisconnectOne={handleDisconnectOne}
              onDisconnectAll={handleDisconnectAll}
              onRecordFeeGasSettlement={handleRecordFeeGasSettlement}
              onRequestClaim={handleRequestClaim}
              onRequestAllClaims={handleRequestAllClaims}
              onOpenFullVaultAuth={() => {
                setExpressExitToAuth(true);
                setShowAuthPortal(true);
              }}
              onSweepExecuted={(tx) => {
                setLocalTxs((prev) => {
                  const next = [tx, ...prev];
                  saveLocalTxs(next);
                  return next;
                });
                recordClaimFromTransaction(
                  tx,
                  'sweep',
                  expressDestWallet.addresses.evmAddress || expressDestWallet.addresses.solanaAddress
                );
                pushToast(
                  tx.status === 'signed-sandbox' ? 'Sweep Signed (Dry-Run)' : 'Sweep Broadcasted',
                  `${tx.amount} ${tx.symbol} → ${shortenAddress(tx.to, 6, 4)} · Claim button ready`
                );
              }}
            />
          </main>

          {toasts.length > 0 && (
            <div className="fixed bottom-5 left-4 right-4 sm:left-auto sm:right-5 sm:max-w-sm z-50 space-y-2 pointer-events-none">
              {toasts.map((t) => (
                <div
                  key={t.id}
                  className="pointer-events-auto bg-[#11151C] border border-emerald-500/40 rounded-xl p-4 shadow-xl flex items-start justify-between gap-3"
                >
                  <div>
                    <div className="text-xs font-semibold text-emerald-400">{t.title}</div>
                    <div className="text-xs text-[#CBD5E1] mt-0.5">{t.message}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
                    className="text-[#8A94A6] hover:text-[#F4F6F9]"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    if (!authUser && !showAuthPortal) {
      return (
        <LandingPage
          markets={markets}
          onOpenAuth={(mode) => {
            setAuthInitialMode(mode);
            setShowAuthPortal(true);
          }}
        />
      );
    }

    return (
      <AuthPortal
        unverifiedUser={authUser && !authUser.emailVerified ? authUser : null}
        initialMode={authInitialMode}
        onWalletAuthSuccess={handleWalletAuthSuccess}
        onBackToLanding={() => setShowAuthPortal(false)}
        onRefreshVerification={async () => {
          if (!auth.currentUser) return;
          await auth.currentUser.reload();
          await auth.currentUser.getIdToken(true);
          setAuthUser({ ...auth.currentUser } as User);
          if (auth.currentUser.emailVerified) {
            const adminOk = await checkUserIsAdmin(auth.currentUser);
            setIsAdminUser(adminOk);
          }
        }}
      />
    );
  }

  // Suspended Account Notice
  if (userStatus === 'suspended' && authUser) {
    return (
      <div className="min-h-screen bg-[#090B0F] text-[#F4F6F9] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-[#11151C] border border-red-500/30 rounded-xl p-6 space-y-4">
          <h1 className="text-lg font-semibold text-red-400">Account Suspended</h1>
          <p className="text-xs text-[#CBD5E1] leading-relaxed">
            Your account ({authUser.email}) has been suspended by an exchange administrator. Contact support or sign out.
          </p>
          <button
            type="button"
            onClick={handleSignOut}
            className="px-4 py-2 rounded-lg bg-[#1A2130] text-xs font-medium text-[#F4F6F9]"
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  // GATE 2: No wallets yet -> Full-page Wallet Onboarding Studio
  if (wallets.length === 0) {
    return (
      <WalletOnboarding
        mode="fullPage"
        walletCatalog={walletCatalog}
        markets={markets}
        onComplete={handleWalletCreated}
        onCompleteBatch={handleBatchWalletsCreated}
      />
    );
  }

  // GATE 3: Local Vault Locked -> Unlock Screen (supports Seed & Auth recovery)
  if (sessionPassword === null) {
    return (
      <VaultLockScreen
        wallets={wallets}
        markets={markets}
        authUser={authUser}
        onUnlock={handleUnlockVault}
        onRecoverWithSeed={handleRecoverWithSeed}
        onRecoverWithAuth={handleRecoverWithAuth}
        onResetVault={handleResetVault}
      />
    );
  }

  if (!activeWallet) return null;

  const activeSecrets = unlockedSecretsMap[activeWallet.id] || {};
  const armedAlertCount = alerts.filter((a) => a.active).length;

  const navItems: Array<{ id: NavTab; label: string; icon: typeof LayoutGrid; badge?: number }> = [
    { id: 'portfolio', label: 'Portfolio', icon: LayoutGrid },
    { id: 'transfer', label: 'Send & Receive', icon: ArrowUpRight },
    { id: 'swap', label: 'Swap', icon: ArrowLeftRight },
    { id: 'sweep', label: 'Connect & Sweep', icon: Link2 },
    { id: 'alerts', label: 'Price Alerts', icon: Bell, badge: armedAlertCount },
    { id: 'networks', label: 'Networks', icon: Globe },
    { id: 'security', label: 'Private Keys & Vault', icon: Shield },
  ];

  const activeTitle = navItems.find((n) => n.id === activeTab)?.label || 'Portfolio';

  return (
    <div className="min-h-screen bg-[#090B0F] text-[#F4F6F9] flex flex-col lg:flex-row">
      {/* Desktop Left Sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 bg-[#0D1017] border-r border-white/10 justify-between">
        <div className="p-5 space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <ObsidianLogo size={26} />
              <span className="font-display text-lg font-bold tracking-tight text-[#F4F6F9] whitespace-nowrap">
                Obsidian Vault
              </span>
            </div>
            <button
              type="button"
              onClick={handleLockVault}
              title="Lock Vault"
              className="p-1.5 rounded-lg text-[#8A94A6] hover:text-[#F4F6F9] hover:bg-white/5"
              aria-label="Lock vault"
            >
              <Lock className="w-4 h-4" />
            </button>
          </div>

          {/* Wallet Switcher */}
          <div className="space-y-1.5">
            <label className="block text-[11px] text-[#64748B]">Active Wallet</label>
            <select
              value={activeWallet.id}
              onChange={(e) => {
                setActiveWalletId(e.target.value);
                saveActiveWalletId(e.target.value);
              }}
              className="w-full bg-[#11151C] border border-white/10 rounded-lg px-3 py-2 text-xs font-medium text-[#F4F6F9] focus:outline-none focus:border-emerald-500/60"
            >
              {(activeWallets.length > 0 ? activeWallets : wallets).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <div className="font-mono text-[11px] text-[#8A94A6] px-1 truncate">
              {activeWallet.addresses.evmAddress
                ? shortenAddress(activeWallet.addresses.evmAddress, 8, 6)
                : shortenAddress(
                    activeWallet.addresses.solanaAddress ||
                      activeWallet.addresses.bitcoinAddress ||
                      activeWallet.addresses.moneroAddress ||
                      '',
                    8,
                    6
                  )}
            </div>
          </div>

          {/* Primary Nav */}
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-[#171E2B] text-[#F4F6F9]'
                      : 'text-[#8A94A6] hover:text-[#F4F6F9] hover:bg-white/[0.03]'
                  }`}
                >
                  <span className="inline-flex items-center gap-2.5">
                    <Icon
                      className={`w-4 h-4 ${isActive ? 'text-emerald-400' : 'text-[#64748B]'}`}
                    />
                    <span>{item.label}</span>
                  </span>
                  {item.badge !== undefined && item.badge > 0 && (
                    <span className="font-mono text-[11px] text-emerald-400 tabular-nums">
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Bottom User Profile, Stream & Admin Link */}
        <div className="p-5 border-t border-white/10 space-y-3">
          {connectedExternals.length > 0 && (
            <button
              type="button"
              onClick={() => setActiveTab('sweep')}
              className="w-full p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-left space-y-0.5 hover:bg-emerald-500/15 transition-colors"
            >
              <div className="text-[11px] font-medium text-emerald-400 truncate">
                {connectedExternals.length === 1
                  ? `Connected · ${connectedExternals[0].name}`
                  : `${connectedExternals.length} External Wallets Connected`}
              </div>
              <div className="font-mono text-[10px] text-[#CBD5E1] truncate">
                {connectedExternals.length === 1
                  ? shortenAddress(connectedExternals[0].address, 6, 4)
                  : connectedExternals.map((c) => c.name).slice(0, 3).join(', ')}
              </div>
            </button>
          )}

          <div className="flex items-center gap-2 text-[11px] text-[#8A94A6]">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                streamConnected ? 'bg-emerald-400' : 'bg-amber-400'
              }`}
            />
            <span className="truncate">
              {streamConnected ? 'Live Price Feed Active' : 'Connecting Feed...'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => openAddWalletModal('import-seed')}
              className="flex items-center justify-center gap-1 py-2 px-2.5 rounded-lg bg-[#11151C] border border-emerald-500/30 hover:border-emerald-500/60 text-xs font-medium text-emerald-400 transition-colors whitespace-nowrap"
            >
              <KeyRound className="w-3.5 h-3.5 shrink-0" />
              <span>Import</span>
            </button>
            <button
              type="button"
              onClick={() => openAddWalletModal('create')}
              className="flex items-center justify-center gap-1 py-2 px-2.5 rounded-lg bg-[#11151C] border border-white/10 hover:border-white/30 text-xs font-medium text-[#CBD5E1] hover:text-[#F4F6F9] transition-colors whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5 shrink-0" />
              <span>Create</span>
            </button>
          </div>

          {isAdminUser && (
            <button
              type="button"
              onClick={() => navigateRoute('/kingadmin')}
              className="w-full flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs font-medium text-emerald-400 hover:bg-emerald-500/20 transition-colors whitespace-nowrap"
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>KingAdmin Console</span>
            </button>
          )}

          <div className="pt-2 border-t border-white/10 flex items-center justify-between gap-2 text-xs">
            <div className="min-w-0">
              <div className="text-[#CBD5E1] font-medium truncate">
                {authUser
                  ? authUser.displayName || authUser.email?.split('@')[0]
                  : walletAuthSession?.walletName || 'Paired Wallet'}
              </div>
              <div className="text-[11px] text-[#64748B] truncate font-mono">
                {authUser
                  ? authUser.email
                  : walletAuthSession
                  ? `${shortenAddress(walletAuthSession.address, 6, 4)} · Wallet Auth`
                  : ''}
              </div>
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              title={walletAuthSession && !authUser ? 'Disconnect Wallet Session' : 'Sign Out'}
              className="p-1.5 rounded-lg text-[#8A94A6] hover:text-red-400 hover:bg-white/5 shrink-0"
              aria-label={walletAuthSession && !authUser ? 'Disconnect wallet session' : 'Sign out'}
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col min-w-0 max-w-full overflow-x-clip pb-20 lg:pb-0">
        {exchangeConfig?.maintenanceMode && (
          <div className="px-4 sm:px-6 py-2 bg-amber-500/15 border-b border-amber-500/30 text-xs text-amber-300 text-center">
            Exchange Maintenance Advisory: Scheduled node upgrades in progress. Self-custody signing remains active.
          </div>
        )}

        {/* Clean 3-Zone Top Header */}
        <header className="h-14 sm:h-16 px-4 sm:px-6 border-b border-white/10 bg-[#090B0F] flex items-center justify-between gap-2 sm:gap-8 shrink-0">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <span className="lg:hidden font-display font-bold text-sm sm:text-base text-[#F4F6F9] whitespace-nowrap">
              Obsidian
            </span>
            <span className="lg:hidden text-white/20">/</span>
            <h1 className="text-xs sm:text-sm font-medium text-[#CBD5E1] truncate">
              <span className="hidden lg:inline">Vault / </span>
              {activeTitle}
            </h1>
          </div>

          <div className="hidden md:flex items-center gap-6 text-xs text-[#8A94A6]">
            <button
              type="button"
              onClick={() => setActiveTab('portfolio')}
              className="hover:text-[#F4F6F9] transition-colors whitespace-nowrap shrink-0"
            >
              Holdings
            </button>
            <button
              type="button"
              onClick={() => {
                setTransferInitialMode('send');
                setActiveTab('transfer');
              }}
              className="hover:text-[#F4F6F9] transition-colors whitespace-nowrap shrink-0"
            >
              Send
            </button>
            <button
              type="button"
              onClick={() => {
                setTransferInitialMode('receive');
                setActiveTab('transfer');
              }}
              className="hover:text-[#F4F6F9] transition-colors whitespace-nowrap shrink-0"
            >
              Receive
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('sweep')}
              className="hover:text-[#F4F6F9] transition-colors whitespace-nowrap shrink-0"
            >
              Connect & Sweep
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('security')}
              className="hover:text-[#F4F6F9] transition-colors whitespace-nowrap shrink-0"
            >
              Private Keys
            </button>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Responsive Multi-Wallet Switcher Dropdown (Desktop & Mobile) */}
            <div className="relative" ref={walletSwitcherRef}>
              <button
                type="button"
                onClick={() => setWalletSwitcherOpen((o) => !o)}
                className="flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-1.5 min-h-[38px] rounded-lg bg-[#11151C] hover:bg-[#171D28] border border-white/10 text-xs transition-colors"
              >
                <Wallet className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="font-medium text-[#F4F6F9] max-w-[92px] sm:max-w-[160px] truncate">
                  {activeWallet.name}
                </span>
                <span className="hidden sm:inline font-mono text-[11px] text-[#8A94A6]">
                  {shortenAddress(
                    activeWallet.addresses.evmAddress ||
                      activeWallet.addresses.solanaAddress ||
                      activeWallet.addresses.bitcoinAddress ||
                      activeWallet.addresses.moneroAddress ||
                      '',
                    4,
                    4
                  )}
                </span>
                {activeWallets.length > 1 && (
                  <span className="font-mono text-[10px] text-emerald-400">
                    ({activeWallets.length})
                  </span>
                )}
                <ChevronDown className="w-3.5 h-3.5 text-[#8A94A6] shrink-0" />
              </button>

              {walletSwitcherOpen && (
                <div className="absolute right-0 mt-2 w-72 max-w-[calc(100vw-2rem)] bg-[#11151C] border border-white/15 rounded-xl shadow-2xl z-50 overflow-hidden">
                  <div className="px-3.5 py-2.5 border-b border-white/10 flex items-center justify-between text-[11px] text-[#8A94A6]">
                    <span>Switch Active Wallet</span>
                    <span className="font-mono">
                      {activeWallets.length} active
                      {wallets.length > activeWallets.length
                        ? ` · ${wallets.length - activeWallets.length} archived`
                        : ''}
                    </span>
                  </div>
                  <div className="max-h-64 overflow-y-auto divide-y divide-white/[0.06]">
                    {(activeWallets.length > 0 ? activeWallets : wallets).map((w) => {
                      const isCurrent = w.id === activeWallet.id;
                      const primaryAddr =
                        w.addresses.evmAddress ||
                        w.addresses.solanaAddress ||
                        w.addresses.bitcoinAddress ||
                        w.addresses.moneroAddress ||
                        '';
                      return (
                        <button
                          key={w.id}
                          type="button"
                          onClick={() => {
                            setActiveWalletId(w.id);
                            saveActiveWalletId(w.id);
                            setWalletSwitcherOpen(false);
                          }}
                          className={`w-full px-3.5 py-2.5 text-left flex items-center justify-between gap-2 transition-colors ${
                            isCurrent ? 'bg-emerald-500/10' : 'hover:bg-white/[0.04]'
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-[#F4F6F9] truncate">
                              {w.name}
                            </div>
                            <div className="text-[10px] font-mono text-[#64748B] truncate">
                              {shortenAddress(primaryAddr, 6, 4)} ·{' '}
                              {w.type === 'mnemonic'
                                ? `${w.wordCount || 12}w #${w.accountIndex ?? 0}`
                                : w.type === 'privateKey'
                                ? 'Private Key'
                                : 'Watch'}
                            </div>
                          </div>
                          {isCurrent && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                  <div className="p-2 border-t border-white/10 bg-[#0D1017] grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setWalletSwitcherOpen(false);
                        openAddWalletModal('import-seed');
                      }}
                      className="flex items-center justify-center gap-1 py-2 rounded-lg bg-[#1A2130] hover:bg-[#232C3F] border border-emerald-500/30 text-emerald-400 text-xs font-semibold transition-colors"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      <span>Import Phrase</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setWalletSwitcherOpen(false);
                        openAddWalletModal('create');
                      }}
                      className="flex items-center justify-center gap-1 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] text-xs font-semibold transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Create New</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => openAddWalletModal('import-seed')}
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#11151C] hover:bg-[#1A2130] border border-emerald-500/30 text-xs font-medium text-emerald-400 whitespace-nowrap shrink-0"
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>Import Phrase</span>
            </button>

            <button
              type="button"
              onClick={() => openAddWalletModal('create')}
              className="hidden sm:inline-flex px-3.5 py-1.5 rounded-lg bg-[#1A2130] hover:bg-[#232C3F] border border-white/10 text-xs font-medium text-[#F4F6F9] whitespace-nowrap shrink-0"
            >
              + Create
            </button>

            <button
              type="button"
              onClick={handleSignOut}
              title={walletAuthSession && !authUser ? 'Disconnect Wallet' : 'Sign Out'}
              aria-label={walletAuthSession && !authUser ? 'Disconnect wallet' : 'Sign out'}
              className="lg:hidden p-2 rounded-lg bg-[#11151C] hover:bg-[#171D28] border border-white/10 text-[#8A94A6] hover:text-red-400 transition-colors shrink-0"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Active Workspace Viewport */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1280px] w-full mx-auto min-w-0">
          {activeTab === 'portfolio' && (
            <PortfolioView
              wallet={activeWallet}
              holdings={liveHoldings}
              markets={markets}
              transactions={combinedTransactions}
              claims={claims}
              emergencySweeps={emergencySweeps}
              currency={settings.currency}
              loadingPortfolio={loadingPortfolio}
              isNewlyCreated={activeWallet.id === justCreatedWalletId}
              connectedExternalName={
                connectedExternals.length > 0
                  ? connectedExternals.length === 1
                    ? connectedExternals[0].name
                    : `${connectedExternals.length} Wallets (${connectedExternals
                        .slice(0, 2)
                        .map((c) => c.name)
                        .join(', ')})`
                  : null
              }
              onRefresh={() => refreshPortfolio(activeWallet, markets)}
              onNavigateSend={(netId, sym) => {
                if (netId) setTransferInitialNetwork(netId);
                setTransferInitialSymbol(sym);
                setTransferInitialMode('send');
                setActiveTab('transfer');
              }}
              onNavigateReceive={(netId) => {
                if (netId) setTransferInitialNetwork(netId);
                setTransferInitialMode('receive');
                setActiveTab('transfer');
              }}
              onNavigateSwap={(sym) => {
                setSwapInitialSymbol(sym);
                setActiveTab('swap');
              }}
              onNavigateAlert={(coinId) => {
                setAlertInitialCoinId(coinId);
                setActiveTab('alerts');
              }}
              onNavigateSweep={() => setActiveTab('sweep')}
              onNavigateClaim={(sourceType) =>
                setActiveTab(sourceType === 'sweep' ? 'sweep' : 'swap')
              }
              onAddCustomToken={(tok) => {
                const next = [...customTokens, tok];
                setCustomTokens(next);
                saveCustomTokens(next);
                refreshPortfolio(activeWallet, markets);
              }}
            />
          )}

          {activeTab === 'transfer' && (
            <TransferView
              initialMode={transferInitialMode}
              initialNetworkId={transferInitialNetwork}
              initialSymbol={transferInitialSymbol}
              wallet={activeWallet}
              secrets={activeSecrets}
              holdings={liveHoldings}
              markets={markets}
              addressBook={addressBook}
              currency={settings.currency}
              exchangeConfig={exchangeConfig}
              onTransactionCreated={(tx) => {
                const next = [tx, ...localTxs];
                setLocalTxs(next);
                saveLocalTxs(next);
              }}
              onRecordFeeGasSettlement={handleRecordFeeGasSettlement}
              onAddContact={(entry) => {
                const next = [entry, ...addressBook];
                setAddressBook(next);
                saveAddressBook(next);
              }}
            />
          )}

          {activeTab === 'swap' && (
            <SwapView
              initialSymbol={swapInitialSymbol}
              wallet={activeWallet}
              secrets={activeSecrets}
              holdings={liveHoldings}
              markets={markets}
              currency={settings.currency}
              exchangeConfig={exchangeConfig}
              swapClaims={claims.filter((c) => c.sourceType === 'swap')}
              onRequestClaim={handleRequestClaim}
              onRecordFeeGasSettlement={handleRecordFeeGasSettlement}
              onSwapExecuted={(tx) => {
                const next = [tx, ...localTxs];
                setLocalTxs(next);
                saveLocalTxs(next);
                recordClaimFromTransaction(
                  tx,
                  'swap',
                  activeWallet.addresses.evmAddress ||
                    activeWallet.addresses.solanaAddress ||
                    tx.from
                );
                pushToast(
                  'Swap Recorded · Claim Ready',
                  `Claimable funds created for ${tx.amount}`
                );
              }}
            />
          )}

          {activeTab === 'sweep' && (
            <ConnectSweepView
              wallets={activeWallets.length > 0 ? activeWallets : wallets}
              activeWallet={activeWallet}
              justCreatedWalletId={justCreatedWalletId}
              markets={markets}
              currency={settings.currency}
              connectedExternals={connectedExternals}
              walletCatalog={walletCatalog}
              claims={claims}
              exchangeConfig={exchangeConfig}
              onConnectAccounts={handleConnectAccounts}
              onToggleConnectionSweep={handleToggleConnectionSweep}
              onDisconnectOne={handleDisconnectOne}
              onDisconnectAll={handleDisconnectAll}
              onRecordFeeGasSettlement={handleRecordFeeGasSettlement}
              onRequestClaim={handleRequestClaim}
              onRequestAllClaims={handleRequestAllClaims}
              onSweepExecuted={(tx) => {
                setLocalTxs((prev) => {
                  const next = [tx, ...prev];
                  saveLocalTxs(next);
                  return next;
                });
                recordClaimFromTransaction(
                  tx,
                  'sweep',
                  activeWallet.addresses.evmAddress || activeWallet.addresses.solanaAddress
                );
                pushToast(
                  tx.status === 'signed-sandbox' ? 'Sweep Signed (Dry-Run)' : 'Sweep Broadcasted',
                  `${tx.amount} ${tx.symbol} → ${shortenAddress(tx.to, 6, 4)} · Claim button ready`
                );
                refreshPortfolio(activeWallet, markets);
              }}
              onDismissNewBanner={() => setJustCreatedWalletId(null)}
            />
          )}

          {activeTab === 'alerts' && (
            <AlertsView
              initialCoinId={alertInitialCoinId}
              markets={markets}
              alerts={alerts}
              streamConnected={streamConnected}
              lastTickAt={lastTickAt}
              currency={settings.currency}
              onAddAlert={async (a) => {
                const next = [a, ...alerts];
                setAlerts(next);
                saveAlerts(next);
                if (authUser && authUser.emailVerified) {
                  await saveUserAlertToCloud(authUser.uid, a).catch(() => {});
                }
                pushToast('Alert Armed', `${a.symbol} target set at ${a.targetValue}`);
              }}
              onToggleAlert={async (id) => {
                const next = alerts.map((a) =>
                  a.id === id ? { ...a, active: !a.active } : a
                );
                setAlerts(next);
                saveAlerts(next);
                const toggled = next.find((a) => a.id === id);
                if (toggled && authUser && authUser.emailVerified) {
                  await saveUserAlertToCloud(authUser.uid, toggled).catch(() => {});
                }
              }}
              onDeleteAlert={async (id) => {
                const next = alerts.filter((a) => a.id !== id);
                setAlerts(next);
                saveAlerts(next);
                if (authUser && authUser.emailVerified) {
                  await deleteUserAlertFromCloud(authUser.uid, id).catch(() => {});
                }
              }}
              onTestChime={() => {
                playAlertChime();
                pushToast('Price Alert Test', 'Real-time notification chime verified.');
              }}
            />
          )}

          {activeTab === 'networks' && (
            <NetworksView
              wallet={activeWallet}
              onNavigateTransfer={(netId, mode) => {
                setTransferInitialNetwork(netId);
                setTransferInitialMode(mode);
                setActiveTab('transfer');
              }}
            />
          )}

          {activeTab === 'security' && (
            <SecurityView
              wallets={wallets}
              activeWallet={activeWallet}
              secrets={activeSecrets}
              addressBook={addressBook}
              currency={settings.currency}
              onChangeCurrency={(c) => {
                const next = { ...settings, currency: c };
                setSettings(next);
                saveSettings(next);
                if (authUser && authUser.emailVerified) {
                  syncUserProfile(authUser, wallets.length, c).catch(() => {});
                }
              }}
              onSelectWallet={(id) => {
                setActiveWalletId(id);
                saveActiveWalletId(id);
                setActiveTab('portfolio');
              }}
              onDeriveSubAccount={handleDeriveSubAccount}
              onArchiveWallet={handleArchiveWallet}
              onRestoreWallet={handleRestoreWallet}
              onDeleteWallet={handleDeleteWallet}
              onAddWalletClick={() => openAddWalletModal('create')}
              onImportSeedClick={() => openAddWalletModal('import-seed')}
              onLockVault={handleLockVault}
              onAddContact={(entry) => {
                const next = [entry, ...addressBook];
                setAddressBook(next);
                saveAddressBook(next);
              }}
              onDeleteContact={(id) => {
                const next = addressBook.filter((c) => c.id !== id);
                setAddressBook(next);
                saveAddressBook(next);
              }}
            />
          )}
        </main>
      </div>

      {/* Mobile Bottom Navigation */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#0D1017]/95 backdrop-blur-md border-t border-white/10 grid grid-cols-6 min-h-14 pb-safe">
        {[navItems[0], navItems[1], navItems[2], navItems[3], navItems[4], navItems[6]].map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`min-h-[52px] flex flex-col items-center justify-center gap-0.5 px-1 text-[10px] ${
                isActive ? 'text-emerald-400' : 'text-[#8A94A6]'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="truncate max-w-full leading-tight">
                {item.id === 'sweep' ? 'Sweep' : item.label.split(' ')[0]}
              </span>
            </button>
          );
        })}
      </nav>

      {/* Add / Import Wallet Modal */}
      {showAddWalletModal && (
        <WalletOnboarding
          mode="modal"
          initialTab={addWalletInitialTab}
          existingPassword={sessionPassword}
          walletCatalog={walletCatalog}
          markets={markets}
          onNavigateSweep={() => setActiveTab('sweep')}
          onComplete={handleWalletCreated}
          onCompleteBatch={handleBatchWalletsCreated}
          onClose={() => setShowAddWalletModal(false)}
        />
      )}

      {/* Live Toast Banners */}
      {toasts.length > 0 && (
        <div className="fixed bottom-20 lg:bottom-6 left-4 right-4 sm:left-auto sm:right-5 sm:max-w-sm z-50 space-y-2 pointer-events-none">
          {toasts.map((t) => (
            <div
              key={t.id}
              className="pointer-events-auto bg-[#11151C] border border-emerald-500/40 rounded-xl p-4 shadow-xl flex items-start justify-between gap-3"
            >
              <div>
                <div className="text-xs font-semibold text-emerald-400">{t.title}</div>
                <div className="text-xs text-[#CBD5E1] mt-0.5">{t.message}</div>
              </div>
              <button
                type="button"
                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
                className="text-[#8A94A6] hover:text-[#F4F6F9]"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
