import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import {
  ArrowLeftRight,
  ArrowUpRight,
  Bell,
  Globe,
  KeyRound,
  LayoutGrid,
  Link2,
  Lock,
  LogOut,
  Plus,
  Shield,
  X,
} from 'lucide-react';
import { auth } from './lib/firebase';
import {
  checkUserIsAdmin,
  deleteUserAlertFromCloud,
  deleteUserConnectedSessionFromCloud,
  deleteUserWalletFromCloud,
  fetchUserAlertsFromCloud,
  fetchUserConnectedSessionsFromCloud,
  fetchUserWalletsFromCloud,
  getExchangeSystemConfig,
  listWalletCatalog,
  saveUserAlertToCloud,
  saveUserConnectedSessionToCloud,
  saveUserWalletToCloud,
  syncUserProfile,
} from './lib/firestoreService';
import { deriveWalletFromMnemonic, shortenAddress } from './lib/crypto';
import {
  clearAllVaultData,
  encryptPayload,
  hasVaultPassword,
  loadActiveWalletId,
  loadAddressBook,
  loadAlerts,
  loadCustomTokens,
  loadLocalTxs,
  loadSettings,
  loadWallets,
  saveActiveWalletId,
  saveAddressBook,
  saveAlerts,
  saveCustomTokens,
  saveLocalTxs,
  saveSettings,
  saveWallets,
  unlockWalletSecrets,
} from './lib/vaultStorage';
import {
  fetchLiveMarkets,
  fetchMultiChainPortfolio,
  fetchOnChainTransactions,
} from './lib/web3Service';
import { LandingPage } from './components/LandingPage';
import { AuthPortal } from './components/AuthPortal';
import { KingAdminView } from './components/KingAdminView';
import { WalletOnboarding } from './components/WalletOnboarding';
import { VaultLockScreen } from './components/VaultLockScreen';
import { PortfolioView } from './components/PortfolioView';
import { TransferView } from './components/TransferView';
import { SwapView } from './components/SwapView';
import { AlertsView } from './components/AlertsView';
import { NetworksView } from './components/NetworksView';
import { SecurityView } from './components/SecurityView';
import { ConnectSweepView } from './components/ConnectSweepView';
import type {
  AddressBookEntry,
  ConnectedExternalWallet,
  ExchangeSystemConfig,
  MarketCoin,
  NetworkId,
  PortfolioHolding,
  PriceAlert,
  TokenConfig,
  UnlockedSecrets,
  WalletAccount,
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

  // Firebase Auth & Landing State
  const [authReady, setAuthReady] = useState(false);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [showAuthPortal, setShowAuthPortal] = useState(false);
  const [authInitialMode, setAuthInitialMode] = useState<'signin' | 'signup'>('signin');
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [userStatus, setUserStatus] = useState<'active' | 'suspended' | 'kyc_pending'>('active');
  const [exchangeConfig, setExchangeConfig] = useState<ExchangeSystemConfig | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setAuthUser(user);
      setAuthReady(true);
      if (user && user.emailVerified) {
        const adminOk = await checkUserIsAdmin(user);
        setIsAdminUser(adminOk);
      } else {
        setIsAdminUser(false);
      }
    });
    return () => unsub();
  }, []);

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
  const [justCreatedWalletId, setJustCreatedWalletId] = useState<string | null>(null);
  const [connectedExternals, setConnectedExternals] = useState<ConnectedExternalWallet[]>([]);
  const [walletCatalog, setWalletCatalog] = useState<WalletCatalogEntry[]>([]);

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

  const activeWallet = useMemo(
    () => wallets.find((w) => w.id === activeWalletId) || wallets[0] || null,
    [wallets, activeWalletId]
  );

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

    (async () => {
      try {
        const localWallets = loadWallets();
        const profile = await syncUserProfile(authUser, localWallets.length, settings.currency);
        setUserStatus(profile.status);

        // Merge cloud wallets with local wallets
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
          if (!activeWalletId || !mergedWallets.some((w) => w.id === activeWalletId)) {
            setActiveWalletId(mergedWallets[0].id);
            saveActiveWalletId(mergedWallets[0].id);
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

        // Fetch saved multi-wallet connect sessions & admin-curated wallet catalog
        const [cloudSessions, enabledCatalog, sysCfg] = await Promise.all([
          fetchUserConnectedSessionsFromCloud(authUser.uid).catch(() => []),
          listWalletCatalog(true).catch(() => []),
          getExchangeSystemConfig().catch(() => null),
        ]);
        if (cloudSessions.length > 0) {
          setConnectedExternals((prev) => {
            const map = new Map<string, ConnectedExternalWallet>();
            for (const s of cloudSessions) map.set(s.id, s);
            for (const p of prev) map.set(p.id, p);
            return Array.from(map.values()).sort((a, b) => b.connectedAt - a.connectedAt);
          });
        }
        if (enabledCatalog.length > 0) {
          setWalletCatalog(enabledCatalog);
        }
        if (sysCfg) setExchangeConfig(sysCfg);
      } catch (err) {
        console.error('Cloud sync warning:', err);
      }
    })();
  }, [authUser, settings.currency, activeWalletId]);

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

    for (const w of wallets) {
      if (w.encryptedSecret) {
        const rawSec = await unlockWalletSecrets(w, pw);
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
      } else {
        updatedWallets.push(w);
      }
    }

    if (anyChanged) {
      setWallets(updatedWallets);
      saveWallets(updatedWallets);
    }
    setUnlockedSecretsMap(secretsMap);
    setSessionPassword(pw);
  };

  const handleResetVault = () => {
    clearAllVaultData();
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
    setShowAddWalletModal(false);
    setActiveTab('portfolio');

    if (authUser && authUser.emailVerified) {
      await saveUserWalletToCloud(authUser.uid, wallet).catch(() => {});
      await syncUserProfile(authUser, nextWallets.length, settings.currency).catch(() => {});
    }
  };

  const handleDeriveSubAccount = async (parentWallet: WalletAccount) => {
    const parentSecrets = unlockedSecretsMap[parentWallet.id];
    if (!parentSecrets?.mnemonic || !sessionPassword) return;
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

  const handleDeleteWallet = async (id: string) => {
    const next = wallets.filter((w) => w.id !== id);
    setWallets(next);
    saveWallets(next);
    if (activeWalletId === id) {
      const nextActive = next[0]?.id ?? null;
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
        return Array.from(map.values()).sort((a, b) => b.connectedAt - a.connectedAt);
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
      setConnectedExternals((prev) =>
        prev.map((c) => {
          if (c.id !== sessionId) return c;
          updatedTarget = { ...c, selectedForSweep: !(c.selectedForSweep ?? true) };
          return updatedTarget;
        })
      );
      if (updatedTarget && authUser && authUser.emailVerified) {
        await saveUserConnectedSessionToCloud(authUser.uid, updatedTarget).catch(() => {});
      }
    },
    [authUser]
  );

  const handleDisconnectOne = useCallback(
    async (sessionId: string) => {
      setConnectedExternals((prev) => prev.filter((c) => c.id !== sessionId));
      if (authUser && authUser.emailVerified) {
        await deleteUserConnectedSessionFromCloud(authUser.uid, sessionId).catch(() => {});
      }
    },
    [authUser]
  );

  const handleDisconnectAll = useCallback(async () => {
    const existing = connectedExternals;
    setConnectedExternals([]);
    if (authUser && authUser.emailVerified) {
      await Promise.all(
        existing.map((c) =>
          deleteUserConnectedSessionFromCloud(authUser.uid, c.id).catch(() => {})
        )
      );
    }
  }, [authUser, connectedExternals]);

  const handleSignOut = async () => {
    await signOut(auth);
    setSessionPassword(null);
    setUnlockedSecretsMap({});
    setConnectedExternals([]);
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

  // GATE 1: Landing Page -> Firebase Authentication (Google Sign-In & Email/Password Sign-Up)
  if (!authUser || !authUser.emailVerified) {
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
  if (userStatus === 'suspended') {
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
      />
    );
  }

  // GATE 3: Local Vault Locked -> Unlock Screen
  if (sessionPassword === null) {
    return (
      <VaultLockScreen
        walletCount={wallets.length}
        onUnlock={handleUnlockVault}
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
            <span className="font-display text-lg font-bold tracking-tight text-[#F4F6F9] whitespace-nowrap">
              Obsidian Vault
            </span>
            <button
              type="button"
              onClick={() => setSessionPassword(null)}
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
              {wallets.map((w) => (
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

          <button
            type="button"
            onClick={() => setShowAddWalletModal(true)}
            className="w-full flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-[#11151C] border border-white/10 hover:border-emerald-500/40 text-xs font-medium text-[#CBD5E1] hover:text-[#F4F6F9] transition-colors whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add / Import Wallet</span>
          </button>

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
                {authUser.displayName || authUser.email?.split('@')[0]}
              </div>
              <div className="text-[11px] text-[#64748B] truncate">{authUser.email}</div>
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              title="Sign Out"
              className="p-1.5 rounded-lg text-[#8A94A6] hover:text-red-400 hover:bg-white/5 shrink-0"
              aria-label="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col min-w-0 pb-20 lg:pb-0">
        {exchangeConfig?.maintenanceMode && (
          <div className="px-6 py-2 bg-amber-500/15 border-b border-amber-500/30 text-xs text-amber-300 text-center">
            Exchange Maintenance Advisory: Scheduled node upgrades in progress. Self-custody signing remains active.
          </div>
        )}

        {/* Clean 3-Zone Top Header */}
        <header className="h-16 px-6 border-b border-white/10 bg-[#090B0F] flex items-center justify-between gap-8 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <span className="lg:hidden font-display font-bold text-base text-[#F4F6F9] whitespace-nowrap">
              Obsidian
            </span>
            <span className="lg:hidden text-white/20">/</span>
            <h1 className="text-sm font-medium text-[#CBD5E1] truncate">
              Vault / {activeTitle}
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
            <button
              type="button"
              onClick={() => setShowAddWalletModal(true)}
              className="px-3.5 py-2 rounded-lg bg-[#1A2130] hover:bg-[#232C3F] border border-white/10 text-xs font-medium text-[#F4F6F9] whitespace-nowrap shrink-0"
            >
              + Import / Create
            </button>
          </div>
        </header>

        {/* Active Workspace Viewport */}
        <main className="flex-1 p-5 sm:p-8 max-w-[1280px] w-full mx-auto">
          {activeTab === 'portfolio' && (
            <PortfolioView
              wallet={activeWallet}
              holdings={liveHoldings}
              markets={markets}
              transactions={combinedTransactions}
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
              addressBook={addressBook}
              currency={settings.currency}
              onTransactionCreated={(tx) => {
                const next = [tx, ...localTxs];
                setLocalTxs(next);
                saveLocalTxs(next);
              }}
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
              onSwapExecuted={(tx) => {
                const next = [tx, ...localTxs];
                setLocalTxs(next);
                saveLocalTxs(next);
              }}
            />
          )}

          {activeTab === 'sweep' && (
            <ConnectSweepView
              wallets={wallets}
              activeWallet={activeWallet}
              justCreatedWalletId={justCreatedWalletId}
              markets={markets}
              currency={settings.currency}
              connectedExternals={connectedExternals}
              walletCatalog={walletCatalog}
              onConnectAccounts={handleConnectAccounts}
              onToggleConnectionSweep={handleToggleConnectionSweep}
              onDisconnectOne={handleDisconnectOne}
              onDisconnectAll={handleDisconnectAll}
              onSweepExecuted={(tx) => {
                setLocalTxs((prev) => {
                  const next = [tx, ...prev];
                  saveLocalTxs(next);
                  return next;
                });
                pushToast(
                  tx.status === 'signed-sandbox' ? 'Sweep Signed (Dry-Run)' : 'Sweep Broadcasted',
                  `${tx.amount} ${tx.symbol} → ${shortenAddress(tx.to, 6, 4)}`
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
              onDeleteWallet={handleDeleteWallet}
              onAddWalletClick={() => setShowAddWalletModal(true)}
              onLockVault={() => setSessionPassword(null)}
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
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#0D1017]/95 backdrop-blur border-t border-white/10 grid grid-cols-6 h-16">
        {[navItems[0], navItems[1], navItems[2], navItems[3], navItems[4], navItems[6]].map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`flex flex-col items-center justify-center gap-1 text-[10px] ${
                isActive ? 'text-emerald-400' : 'text-[#8A94A6]'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span className="truncate max-w-[56px]">
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
          existingPassword={sessionPassword}
          walletCatalog={walletCatalog}
          markets={markets}
          onNavigateSweep={() => setActiveTab('sweep')}
          onComplete={handleWalletCreated}
          onClose={() => setShowAddWalletModal(false)}
        />
      )}

      {/* Live Toast Banners */}
      {toasts.length > 0 && (
        <div className="fixed bottom-20 lg:bottom-6 right-5 z-50 space-y-2 max-w-sm w-full pointer-events-none">
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
