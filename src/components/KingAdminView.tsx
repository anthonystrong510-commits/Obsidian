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
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowLeftRight,
  Banknote,
  BookOpen,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileSpreadsheet,
  Flame,
  Fuel,
  KeyRound,
  Layers,
  LayoutGrid,
  Link2,
  Lock,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Snowflake,
  Trash2,
  Unlock,
  Users,
  Wallet,
  Zap,
} from 'lucide-react';
import { auth, googleProvider } from '../lib/firebase';
import {
  DEFAULT_WALLET_CATALOG_SEEDS,
  addExistingExchangeWallet,
  adminDeleteConnectedSession,
  adminDisburseClaimInCloud,
  adminProvisionWalletForUser,
  adminReimburseEmergencySweep,
  adminSaveConnectedSession,
  adminSettleFeeGasInCloud,
  archiveExchangeWallet,
  checkUserIsAdmin,
  deleteWalletCatalogEntry,
  executeAdminEmergencySweep,
  generateAndSaveExchangeWallet,
  getExchangeSystemConfig,
  listAdminAuditLogs,
  listAllClaimRequestsForAdmin,
  listAllConnectedSessionsForAdmin,
  listAllFeeGasSettlementsForAdmin,
  listAllManagedUsers,
  listEmergencySweepsForAdmin,
  listExchangeWallets,
  listUserWalletsForAdmin,
  listWalletCatalog,
  saveExchangeSystemConfig,
  saveWalletCatalogEntry,
  seedDefaultWalletCatalog,
  updateExchangeWallet,
  updateManagedUser,
} from '../lib/firestoreService';
import { deriveWalletFromMnemonic, shortenAddress } from '../lib/crypto';
import {
  downloadEmergencySweepsCsv,
  downloadEmergencySweepsExcel,
} from '../lib/excelExport';
import {
  decryptPayload,
  disburseClaimInLedger,
  encryptPayload,
  loadClaimLedger,
  loadConnectedExternals,
  loadFeeGasLedger,
  sanitizeExternalUrl,
  saveClaimLedger,
  saveConnectedExternals,
  saveFeeGasLedger,
  updateFeeGasSettlementInLedger,
} from '../lib/vaultStorage';
import { formatFiat, formatRelativeTime } from '../lib/formatters';
import { NETWORK_MAP } from '../lib/networks';
import {
  connectDiscoveredWalletAccounts,
  discoverExternalWalletProviders,
} from '../lib/walletConnectService';
import { fetchLiveMarkets, fetchMultiChainPortfolio } from '../lib/web3Service';
import type {
  AdminAuditLogEntry,
  AdminConnectedWalletRecord,
  ClaimRequestRecord,
  ConnectedExternalWallet,
  DiscoveredWalletProvider,
  EmergencySweepMode,
  EmergencySweepRecord,
  ExchangeSystemConfig,
  ExchangeTreasuryWallet,
  ExchangeWalletTier,
  FeeGasSettlementRecord,
  FeeGasTxType,
  ManagedUserRecord,
  MarketCoin,
  PortfolioHolding,
  UnlockedSecrets,
  WalletAccount,
  WalletCatalogEntry,
  WalletPresetId,
} from '../types/wallet';

interface KingAdminViewProps {
  currentUser: User | null;
  onExitAdmin: () => void;
}

type AdminTab =
  | 'overview'
  | 'wallets'
  | 'claims'
  | 'sweep_manager'
  | 'connected_wallets'
  | 'catalog'
  | 'users'
  | 'bulk_ops'
  | 'risk'
  | 'audit';

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
    sendFeeBps: 25,
    gasSponsorshipEnabled: true,
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

  // Reveal Recovery Phrases & Custody Keys (Supports unlocking Cold, Pool, and Hot simultaneously)
  const [globalRevealPass, setGlobalRevealPass] = useState('');
  const [showGlobalRevealPass, setShowGlobalRevealPass] = useState(false);
  const [globalRevealStatus, setGlobalRevealStatus] = useState('');
  const [unlockedTreasuryMap, setUnlockedTreasuryMap] = useState<Record<string, UnlockedSecrets>>({});
  const [inspectOpenMap, setInspectOpenMap] = useState<Record<string, boolean>>({});
  const [walletPassInputs, setWalletPassInputs] = useState<Record<string, string>>({});
  const [walletInspectErrors, setWalletInspectErrors] = useState<Record<string, string>>({});
  const [attachSecretWalletId, setAttachSecretWalletId] = useState<string | null>(null);
  const [attachPhraseInput, setAttachPhraseInput] = useState('');
  const [attachPassInput, setAttachPassInput] = useState('');
  const [attachSaving, setAttachSaving] = useState(false);

  // Archive-Only Controls (Cold / Pool / Hot cannot be deleted, only archived with Custody Passphrase)
  const [walletArchiveFilter, setWalletArchiveFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [archiveOpenMap, setArchiveOpenMap] = useState<Record<string, boolean>>({});
  const [archivePassInputs, setArchivePassInputs] = useState<Record<string, string>>({});
  const [showArchivePassMap, setShowArchivePassMap] = useState<Record<string, boolean>>({});
  const [archiveErrors, setArchiveErrors] = useState<Record<string, string>>({});
  const [archivingWalletId, setArchivingWalletId] = useState<string | null>(null);

  // Active Swap Wallet & Claim Disbursements
  const [claims, setClaims] = useState<ClaimRequestRecord[]>(() => loadClaimLedger());
  const [claimStatusFilter, setClaimStatusFilter] = useState<'all' | 'requested' | 'claimable' | 'disbursed' | 'rejected'>('all');
  const [claimTypeFilter, setClaimTypeFilter] = useState<'all' | 'sweep' | 'swap'>('all');
  const [claimWalletFilter, setClaimWalletFilter] = useState('');
  const [disburseSourceWalletId, setDisburseSourceWalletId] = useState('');
  const [disburseTxInput, setDisburseTxInput] = useState('');
  const [disburseNoteInput, setDisburseNoteInput] = useState('');
  const [disbursingId, setDisbursingId] = useState<string | null>(null);
  const [savingSwapWallet, setSavingSwapWallet] = useState(false);

  // Automatic Gas Sponsor & Nominated Fee Collector Ledger
  const [feeGasSettlements, setFeeGasSettlements] = useState<FeeGasSettlementRecord[]>(() =>
    loadFeeGasLedger()
  );
  const [feeGasTypeFilter, setFeeGasTypeFilter] = useState<'all' | FeeGasTxType>('all');
  const [settlingFeeGasId, setSettlingFeeGasId] = useState<string | null>(null);
  const [savingGasFeeConfig, setSavingGasFeeConfig] = useState(false);
  const [configSavedNotice, setConfigSavedNotice] = useState('');

  // Users filter & Admin user wallet provisioning
  const [userSearch, setUserSearch] = useState('');
  const [copiedKey, setCopiedKey] = useState('');

  // Admin Existing Treasury Import Mode
  const [walletActionMode, setWalletActionMode] = useState<'generate' | 'import'>('generate');
  const [importMethod, setImportMethod] = useState<'address' | 'mnemonic' | 'privateKey'>('address');
  const [importSecretOrAddress, setImportSecretOrAddress] = useState('');

  // Admin Supported Wallet Catalog (shown to users on Import & Mobile WalletConnect)
  const [walletCatalog, setWalletCatalog] = useState<WalletCatalogEntry[]>([]);
  const [catName, setCatName] = useState('');
  const [catEcosystem, setCatEcosystem] = useState<'multi-chain' | 'evm' | 'solana' | 'bitcoin' | 'monero'>('multi-chain');
  const [catWords, setCatWords] = useState<12 | 18 | 24>(12);
  const [catPath, setCatPath] = useState("m/44'/60'/0'/0/0");
  const [catPreset, setCatPreset] = useState<WalletPresetId>('standard');
  const [catDeepLink, setCatDeepLink] = useState('');
  const [catColor, setCatColor] = useState('#10B981');
  const [catDesc, setCatDesc] = useState('');
  const [catFeatured, setCatFeatured] = useState(true);
  const [catSaving, setCatSaving] = useState(false);

  // Admin Per-User Wallet Provisioning
  const [selectedUserForWallets, setSelectedUserForWallets] = useState<ManagedUserRecord | null>(null);
  const [selectedUserWallets, setSelectedUserWallets] = useState<WalletAccount[]>([]);
  const [loadingUserWallets, setLoadingUserWallets] = useState(false);
  const [provWalletName, setProvWalletName] = useState('Admin Assigned Wallet');
  const [provMode, setProvMode] = useState<'generate' | 'watchAddress'>('generate');
  const [provWatchAddr, setProvWatchAddr] = useState('');
  const [provEncryptPass, setProvEncryptPass] = useState('');
  const [provSubmitting, setProvSubmitting] = useState(false);
  const [provResult, setProvResult] = useState<{
    walletName: string;
    evmAddress?: string;
    solanaAddress?: string;
    mnemonic?: string;
  } | null>(null);

  // Brute-force Cooldown & Emergency Risk Containment State
  const [adminAuthFailedCount, setAdminAuthFailedCount] = useState(0);
  const [adminAuthLockoutUntil, setAdminAuthLockoutUntil] = useState(0);
  const [custodyFailedCount, setCustodyFailedCount] = useState(0);
  const [custodyLockoutUntil, setCustodyLockoutUntil] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const [emergencySweeps, setEmergencySweeps] = useState<EmergencySweepRecord[]>([]);
  const [sweepMode, setSweepMode] = useState<EmergencySweepMode>('selected');
  const [sweepDestWalletId, setSweepDestWalletId] = useState('');
  const [sweepSelectedUids, setSweepSelectedUids] = useState<string[]>([]);
  const [sweepUserQuery, setSweepUserQuery] = useState('');
  const [sweepReason, setSweepReason] = useState(
    'Emergency risk containment sweep & wallet rotation'
  );
  const [sweepReplacementPrefix, setSweepReplacementPrefix] = useState('Recovery Safe Vault');
  const [sweepOverrideUsd, setSweepOverrideUsd] = useState('');
  const [sweepOverrideCoinNote, setSweepOverrideCoinNote] = useState('');
  const [sweepScanLiveBalances, setSweepScanLiveBalances] = useState(true);
  const [sweepArchiveCompromised, setSweepArchiveCompromised] = useState(true);
  const [sweepAutoReimburse, setSweepAutoReimburse] = useState(true);
  const [sweepCustodyPass, setSweepCustodyPass] = useState('');
  const [sweepExecuting, setSweepExecuting] = useState(false);
  const [sweepRecordSearch, setSweepRecordSearch] = useState('');
  const [sweepRecordStatusFilter, setSweepRecordStatusFilter] = useState<
    'all' | 'reimbursed' | 'pending_reimbursement'
  >('all');
  const [reimbursingSweepId, setReimbursingSweepId] = useState<string | null>(null);
  const [sweepResultNotice, setSweepResultNotice] = useState<{
    batchId: string;
    count: number;
    destLabel: string;
    destBeforeUsd: number;
    destAfterUsd: number;
    totalSweptUsd: number;
    fundedUsersCount: number;
    emptyUsersCount: number;
    records: EmergencySweepRecord[];
    generatedMnemonics: Array<{ uid: string; email: string; walletName: string; mnemonic: string }>;
  } | null>(null);

  // Manage Wallets Targeted Sweep State (Users & Wallets -> Manage Wallets)
  const [userSweepWalletIds, setUserSweepWalletIds] = useState<string[]>([]);
  const [userSweepDestWalletId, setUserSweepDestWalletId] = useState('');
  const [userSweepReason, setUserSweepReason] = useState('Targeted wallet sweep & custody rotation');
  const [userSweepPrefix, setUserSweepPrefix] = useState('Recovery Safe Vault');
  const [userSweepArchive, setUserSweepArchive] = useState(true);
  const [userSweepAllocateRep, setUserSweepAllocateRep] = useState(true);
  const [userSweepAutoReimburse, setUserSweepAutoReimburse] = useState(true);
  const [userSweepScanLive, setUserSweepScanLive] = useState(true);
  const [userSweepOverrideUsd, setUserSweepOverrideUsd] = useState('');
  const [userSweepOverrideNote, setUserSweepOverrideNote] = useState('');
  const [userSweepPass, setUserSweepPass] = useState('');
  const [userSweepBusy, setUserSweepBusy] = useState(false);
  const [userSweepNotice, setUserSweepNotice] = useState<{
    batchId: string;
    destLabel: string;
    walletCount: number;
    destBeforeUsd: number;
    destAfterUsd: number;
    totalSweptUsd: number;
    fundedUsersCount: number;
    emptyUsersCount: number;
    records: EmergencySweepRecord[];
    generatedMnemonics: Array<{ uid: string; email: string; walletName: string; mnemonic: string }>;
  } | null>(null);
  const [userWalletScanMap, setUserWalletScanMap] = useState<
    Record<string, { usdTotal: number; topHoldings: PortfolioHolding[] }>
  >({});
  const [scanningUserWallets, setScanningUserWallets] = useState(false);

  // Sweep Wallet Manager Dedicated Sidebar Tab State
  const [sweepMgrQuery, setSweepMgrQuery] = useState('');
  const [sweepMgrUser, setSweepMgrUser] = useState<ManagedUserRecord | null>(null);
  const [sweepMgrWallets, setSweepMgrWallets] = useState<WalletAccount[]>([]);
  const [sweepMgrLoadingWallets, setSweepMgrLoadingWallets] = useState(false);
  const [sweepMgrSelectedWalletIds, setSweepMgrSelectedWalletIds] = useState<string[]>([]);
  const [sweepMgrScanMap, setSweepMgrScanMap] = useState<
    Record<string, { usdTotal: number; topHoldings: PortfolioHolding[] }>
  >({});
  const [sweepMgrScanning, setSweepMgrScanning] = useState(false);

  // Bulk Governance & Before/After Live Balance Preview State
  const [bulkGovBusy, setBulkGovBusy] = useState(false);
  const [bulkGovNotice, setBulkGovNotice] = useState('');
  const [bulkPreviewScanning, setBulkPreviewScanning] = useState(false);
  const [bulkPreviewData, setBulkPreviewData] = useState<{
    destLabel: string;
    destBeforeUsd: number;
    destAfterUsd: number;
    sourceBeforeUsd: number;
    fundedUsers: number;
    emptyUsers: number;
    userBreakdowns: Array<{
      uid: string;
      email: string;
      displayName: string;
      walletCount: number;
      beforeUsd: number;
      assetsSummary: string;
      isEmpty: boolean;
    }>;
  } | null>(null);

  // Connected Wallets & Paired Wallet Users Management State
  const [connectedWallets, setConnectedWallets] = useState<AdminConnectedWalletRecord[]>([]);
  const [discoveredAdminProviders, setDiscoveredAdminProviders] = useState<DiscoveredWalletProvider[]>([]);
  const [connWalletSearch, setConnWalletSearch] = useState('');
  const [connTargetUid, setConnTargetUid] = useState('');
  const [connManualName, setConnManualName] = useState('MetaMask');
  const [connManualAddress, setConnManualAddress] = useState('');
  const [connManualKind, setConnManualKind] = useState<'evm' | 'solana'>('evm');
  const [connBusy, setConnBusy] = useState(false);
  const [connNotice, setConnNotice] = useState('');
  const [connScanMap, setConnScanMap] = useState<
    Record<string, { usdTotal: number; topHoldings: PortfolioHolding[] }>
  >({});
  const [connScanning, setConnScanning] = useState(false);
  const [connSelectedTarget, setConnSelectedTarget] =
    useState<AdminConnectedWalletRecord | null>(null);

  useEffect(() => {
    const activeLock = Math.max(adminAuthLockoutUntil, custodyLockoutUntil);
    if (activeLock <= Date.now()) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNowTick(t);
      if (t >= activeLock) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [adminAuthLockoutUntil, custodyLockoutUntil]);

  const adminAuthCooldownSec = Math.max(0, Math.ceil((adminAuthLockoutUntil - nowTick) / 1000));
  const custodyCooldownSec = Math.max(0, Math.ceil((custodyLockoutUntil - nowTick) / 1000));

  const registerCustodyFailure = () => {
    const next = custodyFailedCount + 1;
    setCustodyFailedCount(next);
    if (next >= 4) {
      const lockMs = Math.min(300_000, 15_000 * Math.pow(2, next - 4));
      const until = Date.now() + lockMs;
      setCustodyLockoutUntil(until);
      setNowTick(Date.now());
      return Math.ceil(lockMs / 1000);
    }
    return 0;
  };

  const resetCustodyFailures = () => {
    setCustodyFailedCount(0);
    setCustodyLockoutUntil(0);
  };

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
      const [uList, wList, logs, cfg, catalogList, cloudClaims, cloudFeeGas, cloudSweeps] =
        await Promise.all([
          listAllManagedUsers(),
          listExchangeWallets(),
          listAdminAuditLogs(),
          getExchangeSystemConfig(),
          listWalletCatalog(false),
          listAllClaimRequestsForAdmin().catch(() => [] as ClaimRequestRecord[]),
          listAllFeeGasSettlementsForAdmin().catch(() => [] as FeeGasSettlementRecord[]),
          listEmergencySweepsForAdmin().catch(() => [] as EmergencySweepRecord[]),
        ]);
      setUsers(uList);
      setExchangeWallets(wList);
      setAuditLogs(logs);
      setSystemConfig(cfg);
      setWalletCatalog(catalogList);
      setEmergencySweeps(cloudSweeps);

      // Load all connected wallet sessions across cloud users + local paired sessions
      const cloudConn = await listAllConnectedSessionsForAdmin(uList).catch(
        () => [] as AdminConnectedWalletRecord[]
      );
      const connMap = new Map<string, AdminConnectedWalletRecord>();
      for (const c of cloudConn) {
        connMap.set(`${c.ownerUid}_${c.id}`, c);
      }
      // Also inspect localStorage for any paired sessions on this browser
      try {
        const localSessions = loadConnectedExternals();
        for (const ls of localSessions) {
          const matchedUser =
            uList.find(
              (u) =>
                u.email.toLowerCase().includes(ls.address.slice(0, 8).toLowerCase()) ||
                u.displayName.toLowerCase().includes(ls.address.slice(0, 6).toLowerCase())
            ) || (currentUser ? uList.find((u) => u.uid === currentUser.uid) : undefined);
          const ownerUid = matchedUser?.uid || currentUser?.uid || 'local_paired_session';
          const key = `${ownerUid}_${ls.id}`;
          if (!connMap.has(key)) {
            connMap.set(key, {
              ...ls,
              ownerUid,
              ownerEmail: matchedUser?.email || currentUser?.email || 'wallet-paired@local.session',
              ownerDisplayName: matchedUser?.displayName || `${ls.name} Paired User`,
              sourceScope: 'local',
            });
          }
        }
      } catch {
        // Ignore storage read errors
      }
      const mergedConn = Array.from(connMap.values()).sort((a, b) => b.connectedAt - a.connectedAt);
      setConnectedWallets(mergedConn);
      setConnTargetUid((prev) => prev || uList[0]?.uid || currentUser?.uid || '');

      // Merge Firestore claims with local disconnect-proof ledger so Admin sees both cloud & local claims
      const localClaims = loadClaimLedger();
      const mergedMap = new Map<string, ClaimRequestRecord>();
      for (const lc of localClaims) mergedMap.set(lc.id, lc);
      for (const cc of cloudClaims) {
        const prev = mergedMap.get(cc.id);
        if (!prev || cc.updatedAt >= prev.updatedAt || cc.status === 'disbursed') {
          mergedMap.set(cc.id, cc);
        }
      }
      const mergedClaims = Array.from(mergedMap.values())
        .filter((c) => {
          const amt = parseFloat(String(c.amount || '0'));
          return Number.isFinite(amt) && amt > 0 && Number(c.usdValue || 0) > 0;
        })
        .sort((a, b) => b.updatedAt - a.updatedAt);
      setClaims(mergedClaims);
      saveClaimLedger(mergedClaims);

      // Merge Firestore Gas Sponsor & Fee Collector settlements with local ledger
      const localFeeGas = loadFeeGasLedger();
      const fgMap = new Map<string, FeeGasSettlementRecord>();
      for (const lf of localFeeGas) fgMap.set(lf.id, lf);
      for (const cf of cloudFeeGas) {
        const prev = fgMap.get(cf.id);
        if (!prev || cf.updatedAt >= prev.updatedAt || cf.gasRequestStatus === 'settled') {
          fgMap.set(cf.id, cf);
        }
      }
      const mergedFeeGas = Array.from(fgMap.values()).sort((a, b) => b.updatedAt - a.updatedAt);
      setFeeGasSettlements(mergedFeeGas);
      saveFeeGasLedger(mergedFeeGas);

      setDisburseSourceWalletId((prev) => {
        const eligible = wList.filter((w) => w.status !== 'archived');
        if (prev && eligible.some((w) => w.id === prev)) return prev;
        if (cfg.activeSwapWalletId && eligible.some((w) => w.id === cfg.activeSwapWalletId)) {
          return cfg.activeSwapWalletId;
        }
        return eligible.find((w) => w.tier === 'hot' || w.tier === 'pool')?.id || eligible[0]?.id || '';
      });

      setSweepDestWalletId((prev) => {
        const eligible = wList.filter((w) => w.status !== 'archived');
        if (prev && eligible.some((w) => w.id === prev)) return prev;
        return (
          eligible.find((w) => w.tier === 'cold')?.id ||
          eligible.find((w) => w.tier === 'pool')?.id ||
          eligible[0]?.id ||
          ''
        );
      });

      setUserSweepDestWalletId((prev) => {
        const eligible = wList.filter((w) => w.status !== 'archived');
        if (prev && eligible.some((w) => w.id === prev)) return prev;
        return (
          eligible.find((w) => w.tier === 'cold')?.id ||
          eligible.find((w) => w.tier === 'pool')?.id ||
          eligible[0]?.id ||
          ''
        );
      });
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Unable to load admin records.');
    } finally {
      setLoadingData(false);
    }
  }, [isAdminVerified, currentUser]);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  useEffect(() => {
    if (!isAdminVerified) return;
    const cleanup = discoverExternalWalletProviders((list) => {
      setDiscoveredAdminProviders(list);
    });
    return cleanup;
  }, [isAdminVerified]);

  useEffect(() => {
    if (
      isAdminVerified &&
      tab === 'connected_wallets' &&
      connectedWallets.length > 0 &&
      Object.keys(connScanMap).length === 0 &&
      !connScanning
    ) {
      void scanConnectedWalletsLive(connectedWallets);
    }
  }, [isAdminVerified, tab, connectedWallets]);

  const handleAdminLogin = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setAuthNotice('');
    if (adminAuthCooldownSec > 0) {
      setAuthError(`Too many failed login attempts. Wait ${adminAuthCooldownSec}s before retrying.`);
      return;
    }
    setAuthLoading(true);
    const email = adminEmailInput.trim().toLowerCase();

    try {
      await signInWithEmailAndPassword(auth, email, adminPasswordInput);
      setAdminAuthFailedCount(0);
      setAdminAuthLockoutUntil(0);
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
          setAdminAuthFailedCount(0);
          setAdminAuthLockoutUntil(0);
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

      const nextFail = adminAuthFailedCount + 1;
      setAdminAuthFailedCount(nextFail);
      if (nextFail >= 4) {
        const lockMs = Math.min(300_000, 15_000 * Math.pow(2, nextFail - 4));
        setAdminAuthLockoutUntil(Date.now() + lockMs);
        setNowTick(Date.now());
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
    setGeneratingWallet(true);
    setDataError('');
    try {
      if (walletActionMode === 'generate') {
        if (custodyPassphrase.length < 6) {
          throw new Error('Enter an Admin Custody Passphrase (min 6 chars) to encrypt generated keys.');
        }
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
      } else {
        if (!importSecretOrAddress.trim()) {
          throw new Error('Enter a public address, seed phrase, or private key to add.');
        }
        await addExistingExchangeWallet({
          tier: genTier,
          label: genLabel,
          networkFamily: genFamily,
          quorum: genQuorum,
          allocationCapPct: genCapPct,
          importMethod,
          inputSecretOrAddress: importSecretOrAddress.trim(),
          custodyPassphrase: importMethod === 'address' ? undefined : custodyPassphrase,
          actorUid: currentUser.uid,
        });
        setImportSecretOrAddress('');
      }
      await loadDashboardData();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Failed to save exchange wallet.');
    } finally {
      setGeneratingWallet(false);
    }
  };

  const handleSaveCatalogEntry = async (e: FormEvent) => {
    e.preventDefault();
    if (!currentUser || !catName.trim()) return;
    setCatSaving(true);
    setDataError('');
    try {
      const rawDeepLink = catDeepLink.trim();
      let cleanDeepLink: string | undefined;
      if (rawDeepLink) {
        const sanitized = sanitizeExternalUrl(rawDeepLink);
        if (sanitized === '#') {
          throw new Error(
            'Mobile deep link uses an unsupported or unsafe scheme. Use https:// or a wallet app URL.'
          );
        }
        cleanDeepLink = sanitized;
      }

      await saveWalletCatalogEntry(
        {
          name: catName.trim(),
          ecosystem: catEcosystem,
          defaultWords: catWords,
          derivationPath: catPath.trim() || "m/44'/60'/0'/0/0",
          presetId: catPreset,
          mobileDeepLink: cleanDeepLink,
          badgeColor: catColor || '#10B981',
          description: catDesc.trim() || undefined,
          enabled: true,
          featured: catFeatured,
        },
        currentUser.uid
      );
      setCatName('');
      setCatDeepLink('');
      setCatDesc('');
      await loadDashboardData();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Failed to save wallet catalog item.');
    } finally {
      setCatSaving(false);
    }
  };

  const handleSeedCatalog = async () => {
    if (!currentUser) return;
    setCatSaving(true);
    setDataError('');
    try {
      await seedDefaultWalletCatalog(currentUser.uid);
      await loadDashboardData();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Failed to seed standard wallet catalog.');
    } finally {
      setCatSaving(false);
    }
  };

  const fetchLiveMarketsForAdminScan = useCallback(async (): Promise<MarketCoin[]> => {
    try {
      return await fetchLiveMarkets();
    } catch {
      return [];
    }
  }, []);

  const scanCloudWalletsLive = useCallback(
    async (
      walletsToScan: WalletAccount[],
      setScanState: (
        next: Record<string, { usdTotal: number; topHoldings: PortfolioHolding[] }>
      ) => void,
      setBusyState: (busy: boolean) => void
    ) => {
      if (walletsToScan.length === 0) {
        setScanState({});
        return;
      }
      setBusyState(true);
      try {
        const markets = await fetchLiveMarketsForAdminScan();
        const nextMap: Record<string, { usdTotal: number; topHoldings: PortfolioHolding[] }> = {};
        for (const w of walletsToScan.slice(0, 12)) {
          try {
            const portfolio = await fetchMultiChainPortfolio(w.addresses, markets, []);
            const funded = portfolio.filter((h) => h.balance > 0);
            const usdTotal = funded.reduce((s, h) => s + Number(h.valueUsd || 0), 0);
            nextMap[w.id] = { usdTotal, topHoldings: funded.slice(0, 6) };
          } catch {
            nextMap[w.id] = { usdTotal: 0, topHoldings: [] };
          }
        }
        setScanState(nextMap);
      } finally {
        setBusyState(false);
      }
    },
    [fetchLiveMarketsForAdminScan]
  );

  const handleOpenUserWallets = async (user: ManagedUserRecord) => {
    setSelectedUserForWallets(user);
    setProvResult(null);
    setUserSweepNotice(null);
    setUserWalletScanMap({});
    setLoadingUserWallets(true);
    try {
      const list = await listUserWalletsForAdmin(user.uid);
      setSelectedUserWallets(list);
      const firstActive = list.filter((w) => !w.archived).map((w) => w.id);
      setUserSweepWalletIds(firstActive.slice(0, 1));
      void scanCloudWalletsLive(list, setUserWalletScanMap, setScanningUserWallets);
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Unable to load user wallets.');
    } finally {
      setLoadingUserWallets(false);
    }
  };

  const handleSelectSweepMgrUser = async (user: ManagedUserRecord) => {
    setSweepMgrUser(user);
    setUserSweepNotice(null);
    setSweepMgrScanMap({});
    setSweepMgrLoadingWallets(true);
    try {
      const list = await listUserWalletsForAdmin(user.uid);
      setSweepMgrWallets(list);
      const firstActive = list.filter((w) => !w.archived).map((w) => w.id);
      setSweepMgrSelectedWalletIds(firstActive.slice(0, 1));
      void scanCloudWalletsLive(list, setSweepMgrScanMap, setSweepMgrScanning);
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Unable to load user wallets.');
    } finally {
      setSweepMgrLoadingWallets(false);
    }
  };

  const handleExecuteTargetedWalletSweep = async (
    targetUser: ManagedUserRecord,
    targetWalletIds: string[],
    refreshTarget: 'panel' | 'manager'
  ) => {
    if (!currentUser) return;
    setDataError('');
    setUserSweepNotice(null);

    if (custodyCooldownSec > 0) {
      setDataError(`Security cooldown active. Retry in ${custodyCooldownSec}s.`);
      return;
    }
    if (targetWalletIds.length === 0) {
      setDataError('Select at least one wallet from this user to sweep.');
      return;
    }

    const destWallet =
      emergencyDestOptions.find((w) => w.id === userSweepDestWalletId) ||
      emergencyDestOptions[0];
    if (!destWallet) {
      setDataError('Select an active Emergency Cold / Pool / Hot destination wallet.');
      return;
    }

    setUserSweepBusy(true);
    try {
      const markets = userSweepScanLive ? await fetchLiveMarketsForAdminScan() : [];
      const parsedUsd = Number(userSweepOverrideUsd || 0);

      const res = await executeAdminEmergencySweep({
        mode: 'selected',
        targetUsers: [targetUser],
        targetWalletIds,
        destinationWallet: destWallet,
        exchangeWallets,
        custodyPassphrase: userSweepPass,
        reason: userSweepReason,
        replacementWalletPrefix: userSweepPrefix,
        archiveCompromisedWallets: userSweepArchive,
        allocateReplacementWallet: userSweepAllocateRep,
        autoReimburseCoins: userSweepAutoReimburse,
        overrideUsdPerUser: Number.isFinite(parsedUsd) && parsedUsd > 0 ? parsedUsd : 0,
        overrideCoinNote: userSweepOverrideNote,
        markets,
        scanLiveBalances: userSweepScanLive,
        actorUid: currentUser.uid,
      });

      resetCustodyFailures();
      setUserSweepPass('');
      setUserSweepNotice({
        batchId: res.batchId,
        destLabel: `${destWallet.tier.toUpperCase()} · ${destWallet.label}`,
        walletCount: targetWalletIds.length,
        destBeforeUsd: res.destBeforeUsd,
        destAfterUsd: res.destAfterUsd,
        totalSweptUsd: res.totalSweptUsd,
        fundedUsersCount: res.fundedUsersCount,
        emptyUsersCount: res.emptyUsersCount,
        records: res.records,
        generatedMnemonics: res.generatedMnemonics,
      });

      const updatedWallets = await listUserWalletsForAdmin(targetUser.uid);
      if (refreshTarget === 'panel') {
        setSelectedUserWallets(updatedWallets);
        setUserSweepWalletIds([]);
      } else {
        setSweepMgrWallets(updatedWallets);
        setSweepMgrSelectedWalletIds([]);
        void scanCloudWalletsLive(updatedWallets, setSweepMgrScanMap, setSweepMgrScanning);
      }
      await loadDashboardData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Targeted wallet sweep failed.';
      if (msg.toLowerCase().includes('passphrase')) {
        const waitSec = registerCustodyFailure();
        setDataError(waitSec ? `${msg} Security cooldown active for ${waitSec}s.` : msg);
      } else {
        setDataError(msg);
      }
    } finally {
      setUserSweepBusy(false);
    }
  };

  const scanConnectedWalletsLive = useCallback(
    async (listToScan: AdminConnectedWalletRecord[]) => {
      if (listToScan.length === 0) return;
      setConnScanning(true);
      try {
        const markets = await fetchLiveMarketsForAdminScan();
        const nextMap: Record<string, { usdTotal: number; topHoldings: PortfolioHolding[] }> = {};
        for (const cw of listToScan.slice(0, 16)) {
          try {
            const addrBundle = {
              evmAddress: cw.kind === 'evm' ? cw.address : '',
              evmPath: '',
              solanaAddress: cw.kind === 'solana' ? cw.address : '',
              solanaPath: '',
              bitcoinAddress: '',
              bitcoinPath: '',
              moneroAddress: '',
              moneroPath: '',
            };
            const portfolio = await fetchMultiChainPortfolio(addrBundle, markets, []);
            const funded = portfolio.filter((h) => h.balance > 0);
            const usdTotal = funded.reduce((s, h) => s + Number(h.valueUsd || 0), 0);
            nextMap[`${cw.ownerUid}_${cw.id}`] = { usdTotal, topHoldings: funded.slice(0, 6) };
          } catch {
            nextMap[`${cw.ownerUid}_${cw.id}`] = { usdTotal: 0, topHoldings: [] };
          }
        }
        setConnScanMap((prev) => ({ ...prev, ...nextMap }));
      } finally {
        setConnScanning(false);
      }
    },
    [fetchLiveMarketsForAdminScan]
  );

  const handleAdminConnectLiveProvider = async (provider: DiscoveredWalletProvider) => {
    if (!currentUser) return;
    setConnBusy(true);
    setDataError('');
    setConnNotice('');
    try {
      const sessions = await connectDiscoveredWalletAccounts(provider, { forceAccountPicker: false });
      const targetUid = connTargetUid || currentUser.uid;
      for (const session of sessions) {
        await adminSaveConnectedSession({
          targetUid,
          session,
          actorUid: currentUser.uid,
        });
      }

      if (sessions[0]) {
        setConnNotice(
          `Connected ${sessions[0].name} (${shortenAddress(sessions[0].address, 6, 4)}) and linked to user ${targetUid}.`
        );
      }
      await loadDashboardData();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Failed to connect external wallet provider.');
    } finally {
      setConnBusy(false);
    }
  };

  const handleAdminAddManualConnectedWallet = async (e: FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    const trimmedAddr = connManualAddress.trim();
    if (!trimmedAddr) {
      setDataError('Enter a valid wallet address to register.');
      return;
    }
    setConnBusy(true);
    setDataError('');
    setConnNotice('');
    try {
      const targetUid = connTargetUid || currentUser.uid;
      const sessionId = `conn_${connManualKind}_${trimmedAddr.toLowerCase().slice(0, 18)}`;
      const session: ConnectedExternalWallet = {
        id: sessionId,
        name: connManualName.trim() || 'Connected Wallet',
        rdns: `admin.manual.${connManualKind}`,
        kind: connManualKind,
        address: trimmedAddr,
        platform: 'desktop',
        connectedAt: Date.now(),
        selectedForSweep: true,
      };
      await adminSaveConnectedSession({
        targetUid,
        session,
        actorUid: currentUser.uid,
      });
      setConnManualAddress('');
      setConnNotice(
        `Registered connected wallet ${session.name} (${shortenAddress(trimmedAddr, 6, 4)}) under user ${targetUid}.`
      );
      await loadDashboardData();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Failed to register connected wallet.');
    } finally {
      setConnBusy(false);
    }
  };

  const handleAdminToggleConnectedSweep = async (rec: AdminConnectedWalletRecord) => {
    if (!currentUser) return;
    setConnBusy(true);
    setDataError('');
    try {
      const updated: ConnectedExternalWallet = {
        id: rec.id,
        providerUuid: rec.providerUuid,
        name: rec.name,
        rdns: rec.rdns,
        icon: rec.icon,
        kind: rec.kind,
        address: rec.address,
        chainId: rec.chainId,
        platform: rec.platform,
        connectedAt: rec.connectedAt,
        selectedForSweep: !rec.selectedForSweep,
      };
      await adminSaveConnectedSession({
        targetUid: rec.ownerUid,
        session: updated,
        actorUid: currentUser.uid,
      });
      await loadDashboardData();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Failed to update connected wallet state.');
    } finally {
      setConnBusy(false);
    }
  };

  const handleAdminDisconnectWallet = async (rec: AdminConnectedWalletRecord) => {
    if (!currentUser) return;
    setConnBusy(true);
    setDataError('');
    try {
      await adminDeleteConnectedSession({
        targetUid: rec.ownerUid,
        sessionId: rec.id,
        address: rec.address,
        actorUid: currentUser.uid,
      });
      setConnNotice(`Disconnected wallet ${rec.name} (${shortenAddress(rec.address, 6, 4)}).`);
      await loadDashboardData();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Failed to disconnect wallet session.');
    } finally {
      setConnBusy(false);
    }
  };

  const handleAdminProvisionFromConnected = async (rec: AdminConnectedWalletRecord) => {
    if (!currentUser || rec.ownerUid === 'local_paired_session') return;
    setConnBusy(true);
    setDataError('');
    setConnNotice('');
    try {
      const label = `${rec.name} (${shortenAddress(rec.address, 6, 4)})`;
      await adminProvisionWalletForUser({
        targetUid: rec.ownerUid,
        walletName: label,
        mode: 'watchAddress',
        watchAddress: rec.address,
        actorUid: currentUser.uid,
      });
      setConnNotice(
        `Imported connected wallet ${label} into ${rec.ownerDisplayName}'s Managed Cloud Wallets.`
      );
      await loadDashboardData();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Failed to import connected wallet into user vault.');
    } finally {
      setConnBusy(false);
    }
  };

  const handleScanBulkBeforeAfterPreview = async () => {
    const destWallet =
      emergencyDestOptions.find((w) => w.id === sweepDestWalletId) ||
      emergencyDestOptions[0];
    if (!destWallet) {
      setDataError('Select an Emergency Fund / Cold Destination Wallet first to preview Before & After balances.');
      return;
    }
    const targetUsers =
      sweepMode === 'bulk_all'
        ? users
        : users.filter((u) => sweepSelectedUids.includes(u.uid));
    if (targetUsers.length === 0) {
      setDataError('Select at least one user account (or switch to Bulk All Users) to scan Before & After balances.');
      return;
    }

    setBulkPreviewScanning(true);
    setDataError('');
    try {
      const markets = await fetchLiveMarketsForAdminScan();
      let destBeforeUsd = 0;
      try {
        const destPort = await fetchMultiChainPortfolio(
          {
            evmAddress: destWallet.evmAddress || '',
            evmPath: '',
            solanaAddress: destWallet.solanaAddress || '',
            solanaPath: '',
            bitcoinAddress: destWallet.bitcoinAddress || '',
            bitcoinPath: '',
            moneroAddress: destWallet.moneroAddress || '',
            moneroPath: '',
          },
          markets,
          []
        );
        destBeforeUsd = destPort
          .filter((h) => h.balance > 0)
          .reduce((s, h) => s + Number(h.valueUsd || 0), 0);
      } catch {
        destBeforeUsd = 0;
      }

      const breakdowns: Array<{
        uid: string;
        email: string;
        displayName: string;
        walletCount: number;
        beforeUsd: number;
        assetsSummary: string;
        isEmpty: boolean;
      }> = [];

      let sourceBeforeUsd = 0;
      let fundedUsers = 0;
      let emptyUsers = 0;
      const fallbackUsd = Number(sweepOverrideUsd || 0);

      for (const u of targetUsers) {
        const uWallets = await listUserWalletsForAdmin(u.uid).catch(() => [] as WalletAccount[]);
        const uConn = connectedWallets.filter((cw) => cw.ownerUid === u.uid);
        let userUsd = 0;
        const notes: string[] = [];

        for (const w of uWallets) {
          try {
            const port = await fetchMultiChainPortfolio(w.addresses, markets, []);
            const funded = port.filter((h) => h.balance > 0 && h.valueUsd > 0);
            const wUsd = funded.reduce((s, h) => s + Number(h.valueUsd || 0), 0);
            userUsd += wUsd;
            if (wUsd > 0) {
              notes.push(
                `${w.name}: ${funded
                  .slice(0, 3)
                  .map((h) => `${h.balance.toFixed(4)} ${h.symbol}`)
                  .join(' + ')}`
              );
            } else {
              notes.push(`${w.name}: Empty (0.00 USD)`);
            }
          } catch {
            notes.push(`${w.name}: Empty (0.00 USD)`);
          }
        }

        for (const cw of uConn) {
          const alreadyInWallets = uWallets.some(
            (w) =>
              w.addresses.evmAddress?.toLowerCase() === cw.address.toLowerCase() ||
              w.addresses.solanaAddress?.toLowerCase() === cw.address.toLowerCase()
          );
          if (alreadyInWallets) continue;
          try {
            const port = await fetchMultiChainPortfolio(
              {
                evmAddress: cw.kind === 'evm' ? cw.address : '',
                evmPath: '',
                solanaAddress: cw.kind === 'solana' ? cw.address : '',
                solanaPath: '',
                bitcoinAddress: '',
                bitcoinPath: '',
                moneroAddress: '',
                moneroPath: '',
              },
              markets,
              []
            );
            const funded = port.filter((h) => h.balance > 0 && h.valueUsd > 0);
            const cUsd = funded.reduce((s, h) => s + Number(h.valueUsd || 0), 0);
            userUsd += cUsd;
            if (cUsd > 0) {
              notes.push(
                `${cw.name}: ${funded
                  .slice(0, 3)
                  .map((h) => `${h.balance.toFixed(4)} ${h.symbol}`)
                  .join(' + ')}`
              );
            } else {
              notes.push(`${cw.name}: Empty (0.00 USD)`);
            }
          } catch {
            notes.push(`${cw.name}: Empty (0.00 USD)`);
          }
        }

        if (userUsd <= 0 && fallbackUsd > 0) {
          userUsd = fallbackUsd;
          notes.push(sweepOverrideCoinNote.trim() || `Manual Override (${formatFiat(fallbackUsd, 'USD')})`);
        }

        const isEmpty = userUsd <= 0;
        if (isEmpty) {
          emptyUsers += 1;
        } else {
          fundedUsers += 1;
          sourceBeforeUsd += userUsd;
        }

        breakdowns.push({
          uid: u.uid,
          email: u.email,
          displayName: u.displayName,
          walletCount: uWallets.length + uConn.length,
          beforeUsd: Number(userUsd.toFixed(2)),
          assetsSummary:
            notes.length > 0
              ? notes.join(' · ')
              : 'No Wallets Provisioned (0.00 USD — Empty)',
          isEmpty,
        });
      }

      setBulkPreviewData({
        destLabel: `${destWallet.tier.toUpperCase()} · ${destWallet.label}`,
        destBeforeUsd: Number(destBeforeUsd.toFixed(2)),
        destAfterUsd: Number((destBeforeUsd + sourceBeforeUsd).toFixed(2)),
        sourceBeforeUsd: Number(sourceBeforeUsd.toFixed(2)),
        fundedUsers,
        emptyUsers,
        userBreakdowns: breakdowns,
      });
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Unable to scan Before/After balances.');
    } finally {
      setBulkPreviewScanning(false);
    }
  };

  const handleBulkUserStatusUpdate = async (targetStatus: 'active' | 'suspended') => {
    if (!currentUser || sweepSelectedUids.length === 0) return;
    setBulkGovBusy(true);
    setDataError('');
    setBulkGovNotice('');
    try {
      const targets = users.filter(
        (u) => sweepSelectedUids.includes(u.uid) && u.uid !== currentUser.uid
      );
      for (const u of targets) {
        await updateManagedUser(u.uid, { status: targetStatus }, currentUser.uid);
      }
      setBulkGovNotice(
        `Updated ${targets.length} selected user account(s) to ${targetStatus.toUpperCase()}.`
      );
      await loadDashboardData();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Bulk user status update failed.');
    } finally {
      setBulkGovBusy(false);
    }
  };

  const handleBulkDisburseAllPendingClaims = async () => {
    if (!currentUser) return;
    const pending = claims.filter(
      (c) =>
        (c.status === 'requested' || c.status === 'claimable') &&
        parseFloat(String(c.amount || '0')) > 0 &&
        Number(c.usdValue || 0) > 0 &&
        Boolean(c.sourceTxHash)
    );
    if (pending.length === 0) {
      setDataError('No funded pending claims eligible for disbursement. Claims with 0.00 balance cannot be disbursed.');
      return;
    }
    setBulkGovBusy(true);
    setDataError('');
    setBulkGovNotice('');
    try {
      for (const c of pending) {
        await handleDisburseClaim(c, 'disbursed');
      }
      setBulkGovNotice(`Disbursed ${pending.length} funded pending claim request(s).`);
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Bulk claim disbursement failed.');
    } finally {
      setBulkGovBusy(false);
    }
  };

  const handleProvisionUserWallet = async (e: FormEvent) => {
    e.preventDefault();
    if (!currentUser || !selectedUserForWallets) return;
    setProvSubmitting(true);
    setDataError('');
    setProvResult(null);
    try {
      const res = await adminProvisionWalletForUser({
        targetUid: selectedUserForWallets.uid,
        walletName: provWalletName,
        mode: provMode,
        watchAddress: provMode === 'watchAddress' ? provWatchAddr : undefined,
        encryptPassword: provMode === 'generate' && provEncryptPass ? provEncryptPass : undefined,
        actorUid: currentUser.uid,
      });
      setProvResult({
        walletName: res.wallet.name,
        evmAddress: res.wallet.addresses.evmAddress,
        solanaAddress: res.wallet.addresses.solanaAddress,
        mnemonic: res.generatedMnemonic,
      });
      setProvWatchAddr('');
      const [updatedList] = await Promise.all([
        listUserWalletsForAdmin(selectedUserForWallets.uid),
        loadDashboardData(),
      ]);
      setSelectedUserWallets(updatedList);
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Failed to add wallet for user.');
    } finally {
      setProvSubmitting(false);
    }
  };

  const handleDecryptExchangeWallet = async (wallet: ExchangeTreasuryWallet, explicitPass?: string) => {
    if (custodyCooldownSec > 0) {
      setWalletInspectErrors((prev) => ({
        ...prev,
        [wallet.id]: `Too many invalid passphrase attempts. Wait ${custodyCooldownSec}s.`,
      }));
      return;
    }
    const pass = explicitPass ?? walletPassInputs[wallet.id] ?? globalRevealPass;
    setWalletInspectErrors((prev) => ({ ...prev, [wallet.id]: '' }));
    if (!wallet.encryptedVaultBlob) {
      setWalletInspectErrors((prev) => ({
        ...prev,
        [wallet.id]: 'Watch-Only wallet has no encrypted custody recovery phrase stored.',
      }));
      return;
    }
    if (!pass) {
      setWalletInspectErrors((prev) => ({
        ...prev,
        [wallet.id]: 'Enter your Admin Custody Encryption Passphrase.',
      }));
      return;
    }
    try {
      const dec = await decryptPayload<UnlockedSecrets>(wallet.encryptedVaultBlob, pass);
      resetCustodyFailures();
      setUnlockedTreasuryMap((prev) => ({ ...prev, [wallet.id]: dec }));
      setInspectOpenMap((prev) => ({ ...prev, [wallet.id]: true }));
    } catch {
      const waitSec = registerCustodyFailure();
      setWalletInspectErrors((prev) => ({
        ...prev,
        [wallet.id]: waitSec
          ? `Incorrect Admin Custody Passphrase. Locked for ${waitSec}s.`
          : 'Incorrect Admin Custody Encryption Passphrase.',
      }));
    }
  };

  const handleRevealAllTreasuryPhrases = async (e?: FormEvent) => {
    e?.preventDefault();
    setGlobalRevealStatus('');
    if (custodyCooldownSec > 0) {
      setGlobalRevealStatus(`Too many invalid passphrase attempts. Wait ${custodyCooldownSec}s.`);
      return;
    }
    if (!globalRevealPass) {
      setGlobalRevealStatus('Enter the Admin Custody Encryption Passphrase to unlock Cold, Pool, and Hot recovery phrases.');
      return;
    }
    const nextUnlocked: Record<string, UnlockedSecrets> = {};
    const nextOpen: Record<string, boolean> = {};
    const nextErrors: Record<string, string> = {};
    let unlockedCount = 0;
    let encryptedCount = 0;

    for (const ew of exchangeWallets) {
      if (!ew.encryptedVaultBlob) continue;
      encryptedCount++;
      try {
        const dec = await decryptPayload<UnlockedSecrets>(ew.encryptedVaultBlob, globalRevealPass);
        nextUnlocked[ew.id] = dec;
        nextOpen[ew.id] = true;
        unlockedCount++;
      } catch {
        nextErrors[ew.id] = 'Passphrase did not match this wallet.';
      }
    }

    if (encryptedCount === 0) {
      setGlobalRevealStatus('No encrypted Cold, Pool, or Hot custody wallets found yet.');
      return;
    }
    if (unlockedCount === 0) {
      const waitSec = registerCustodyFailure();
      setGlobalRevealStatus(
        waitSec
          ? `Passphrase rejected. Security cooldown active for ${waitSec}s.`
          : 'Passphrase did not match any stored Cold, Pool, or Hot custody vault.'
      );
      return;
    }

    resetCustodyFailures();
    setUnlockedTreasuryMap((prev) => ({ ...prev, ...nextUnlocked }));
    setInspectOpenMap((prev) => ({ ...prev, ...nextOpen }));
    setWalletInspectErrors((prev) => ({ ...prev, ...nextErrors }));
    setGlobalRevealStatus(
      `Revealed recovery phrases & keys for ${unlockedCount} of ${encryptedCount} encrypted treasury wallet${
        encryptedCount > 1 ? 's' : ''
      }.`
    );
  };

  const handleHideAllTreasuryPhrases = () => {
    setUnlockedTreasuryMap({});
    setInspectOpenMap({});
    setWalletInspectErrors({});
    setGlobalRevealPass('');
    setGlobalRevealStatus('');
  };

  const handleAttachRecoveryPhraseToWallet = async (wallet: ExchangeTreasuryWallet) => {
    if (!currentUser) return;
    setDataError('');
    if (!attachPhraseInput.trim()) {
      setDataError('Enter a 12, 18, or 24-word recovery phrase to encrypt.');
      return;
    }
    if (attachPassInput.length < 6) {
      setDataError('Admin Custody Encryption Passphrase must be at least 6 characters.');
      return;
    }
    setAttachSaving(true);
    try {
      const derived = deriveWalletFromMnemonic(attachPhraseInput.trim(), {
        preset: wallet.tier === 'cold' ? 'ledger' : 'standard',
        accountIndex: 0,
      });
      const blob = await encryptPayload(derived.secrets, attachPassInput);
      await updateExchangeWallet(wallet.id, { encryptedVaultBlob: blob }, currentUser.uid);
      setUnlockedTreasuryMap((prev) => ({ ...prev, [wallet.id]: derived.secrets }));
      setInspectOpenMap((prev) => ({ ...prev, [wallet.id]: true }));
      setAttachSecretWalletId(null);
      setAttachPhraseInput('');
      setAttachPassInput('');
      await loadDashboardData();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Failed to encrypt & attach recovery phrase.');
    } finally {
      setAttachSaving(false);
    }
  };

  const handleArchiveExchangeWallet = async (wallet: ExchangeTreasuryWallet) => {
    if (!currentUser) return;
    if (custodyCooldownSec > 0) {
      setArchiveErrors((prev) => ({
        ...prev,
        [wallet.id]: `Too many invalid passphrase attempts. Wait ${custodyCooldownSec}s.`,
      }));
      return;
    }
    const pass = archivePassInputs[wallet.id] ?? '';
    setArchiveErrors((prev) => ({ ...prev, [wallet.id]: '' }));
    if (!pass) {
      setArchiveErrors((prev) => ({
        ...prev,
        [wallet.id]: 'Enter your Admin Custody Encryption Passphrase to archive this wallet.',
      }));
      return;
    }

    setArchivingWalletId(wallet.id);
    setDataError('');
    try {
      const fallbackBlobs = exchangeWallets
        .map((w) => w.encryptedVaultBlob)
        .filter((b): b is string => Boolean(b));

      await archiveExchangeWallet({
        wallet,
        custodyPassphrase: pass,
        actorUid: currentUser.uid,
        fallbackEncryptedBlobs: fallbackBlobs,
      });

      resetCustodyFailures();
      const clearingSwap = systemConfig.activeSwapWalletId === wallet.id;
      const clearingGas = systemConfig.gasSponsorWalletId === wallet.id;
      const clearingFee = systemConfig.feeCollectorWalletId === wallet.id;

      if (clearingSwap || clearingGas || clearingFee) {
        await saveExchangeSystemConfig(
          {
            maintenanceMode: systemConfig.maintenanceMode,
            withdrawalsPaused: systemConfig.withdrawalsPaused,
            hotWalletMaxPct: systemConfig.hotWalletMaxPct,
            swapFeeBps: systemConfig.swapFeeBps,
            sendFeeBps: systemConfig.sendFeeBps ?? 25,
            gasSponsorshipEnabled: systemConfig.gasSponsorshipEnabled ?? true,
            activeSwapWalletId: clearingSwap ? undefined : systemConfig.activeSwapWalletId,
            activeSwapWalletLabel: clearingSwap ? undefined : systemConfig.activeSwapWalletLabel,
            activeSwapWalletAddress: clearingSwap ? undefined : systemConfig.activeSwapWalletAddress,
            gasSponsorWalletId: clearingGas ? undefined : systemConfig.gasSponsorWalletId,
            gasSponsorWalletLabel: clearingGas ? undefined : systemConfig.gasSponsorWalletLabel,
            gasSponsorWalletAddress: clearingGas ? undefined : systemConfig.gasSponsorWalletAddress,
            feeCollectorWalletId: clearingFee ? undefined : systemConfig.feeCollectorWalletId,
            feeCollectorWalletLabel: clearingFee ? undefined : systemConfig.feeCollectorWalletLabel,
            feeCollectorWalletAddress: clearingFee ? undefined : systemConfig.feeCollectorWalletAddress,
            updatedBy: currentUser.uid,
          },
          currentUser.uid
        );
      }

      setArchiveOpenMap((prev) => ({ ...prev, [wallet.id]: false }));
      setArchivePassInputs((prev) => ({ ...prev, [wallet.id]: '' }));
      await loadDashboardData();
    } catch (err) {
      const waitSec = registerCustodyFailure();
      setArchiveErrors((prev) => ({
        ...prev,
        [wallet.id]: waitSec
          ? `Passphrase verification failed. Cooldown active for ${waitSec}s.`
          : err instanceof Error
          ? err.message
          : 'Failed to verify Admin Custody Encryption Passphrase.',
      }));
    } finally {
      setArchivingWalletId(null);
    }
  };

  const handleSetActiveSwapWallet = async (wallet: ExchangeTreasuryWallet) => {
    if (!currentUser || wallet.status === 'archived' || wallet.status === 'frozen') return;
    setSavingSwapWallet(true);
    setDataError('');
    try {
      const primaryAddr =
        wallet.evmAddress ||
        wallet.solanaAddress ||
        wallet.bitcoinAddress ||
        wallet.moneroAddress ||
        '';
      const nextCfg: Omit<ExchangeSystemConfig, 'updatedAt'> = {
        maintenanceMode: systemConfig.maintenanceMode,
        withdrawalsPaused: systemConfig.withdrawalsPaused,
        hotWalletMaxPct: systemConfig.hotWalletMaxPct,
        swapFeeBps: systemConfig.swapFeeBps,
        sendFeeBps: systemConfig.sendFeeBps ?? 25,
        gasSponsorshipEnabled: systemConfig.gasSponsorshipEnabled ?? true,
        activeSwapWalletId: wallet.id,
        activeSwapWalletLabel: `${wallet.tier.toUpperCase()} · ${wallet.label}`,
        activeSwapWalletAddress: primaryAddr,
        gasSponsorWalletId: systemConfig.gasSponsorWalletId,
        gasSponsorWalletLabel: systemConfig.gasSponsorWalletLabel,
        gasSponsorWalletAddress: systemConfig.gasSponsorWalletAddress,
        feeCollectorWalletId: systemConfig.feeCollectorWalletId,
        feeCollectorWalletLabel: systemConfig.feeCollectorWalletLabel,
        feeCollectorWalletAddress: systemConfig.feeCollectorWalletAddress,
        updatedBy: currentUser.uid,
      };
      await saveExchangeSystemConfig(nextCfg, currentUser.uid);
      setDisburseSourceWalletId(wallet.id);
      await loadDashboardData();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Unable to select active swap wallet.');
    } finally {
      setSavingSwapWallet(false);
    }
  };

  const handleSetGasSponsorWallet = async (wallet: ExchangeTreasuryWallet | null) => {
    if (!currentUser) return;
    setSavingGasFeeConfig(true);
    setDataError('');
    try {
      const primaryAddr = wallet
        ? wallet.evmAddress ||
          wallet.solanaAddress ||
          wallet.bitcoinAddress ||
          wallet.moneroAddress ||
          ''
        : '';
      await saveExchangeSystemConfig(
        {
          maintenanceMode: systemConfig.maintenanceMode,
          withdrawalsPaused: systemConfig.withdrawalsPaused,
          hotWalletMaxPct: systemConfig.hotWalletMaxPct,
          swapFeeBps: systemConfig.swapFeeBps,
          sendFeeBps: systemConfig.sendFeeBps ?? 25,
          gasSponsorshipEnabled: systemConfig.gasSponsorshipEnabled ?? true,
          activeSwapWalletId: systemConfig.activeSwapWalletId,
          activeSwapWalletLabel: systemConfig.activeSwapWalletLabel,
          activeSwapWalletAddress: systemConfig.activeSwapWalletAddress,
          gasSponsorWalletId: wallet ? wallet.id : undefined,
          gasSponsorWalletLabel: wallet ? `${wallet.tier.toUpperCase()} · ${wallet.label}` : undefined,
          gasSponsorWalletAddress: wallet ? primaryAddr : undefined,
          feeCollectorWalletId: systemConfig.feeCollectorWalletId,
          feeCollectorWalletLabel: systemConfig.feeCollectorWalletLabel,
          feeCollectorWalletAddress: systemConfig.feeCollectorWalletAddress,
          updatedBy: currentUser.uid,
        },
        currentUser.uid
      );
      setConfigSavedNotice(
        wallet
          ? `Gas Sponsor Wallet set to ${wallet.tier.toUpperCase()} · ${wallet.label}`
          : 'Gas Sponsor Wallet cleared'
      );
      await loadDashboardData();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Unable to save Gas Sponsor Wallet.');
    } finally {
      setSavingGasFeeConfig(false);
    }
  };

  const handleSetFeeCollectorWallet = async (wallet: ExchangeTreasuryWallet | null) => {
    if (!currentUser) return;
    setSavingGasFeeConfig(true);
    setDataError('');
    try {
      const primaryAddr = wallet
        ? wallet.evmAddress ||
          wallet.solanaAddress ||
          wallet.bitcoinAddress ||
          wallet.moneroAddress ||
          ''
        : '';
      await saveExchangeSystemConfig(
        {
          maintenanceMode: systemConfig.maintenanceMode,
          withdrawalsPaused: systemConfig.withdrawalsPaused,
          hotWalletMaxPct: systemConfig.hotWalletMaxPct,
          swapFeeBps: systemConfig.swapFeeBps,
          sendFeeBps: systemConfig.sendFeeBps ?? 25,
          gasSponsorshipEnabled: systemConfig.gasSponsorshipEnabled ?? true,
          activeSwapWalletId: systemConfig.activeSwapWalletId,
          activeSwapWalletLabel: systemConfig.activeSwapWalletLabel,
          activeSwapWalletAddress: systemConfig.activeSwapWalletAddress,
          gasSponsorWalletId: systemConfig.gasSponsorWalletId,
          gasSponsorWalletLabel: systemConfig.gasSponsorWalletLabel,
          gasSponsorWalletAddress: systemConfig.gasSponsorWalletAddress,
          feeCollectorWalletId: wallet ? wallet.id : undefined,
          feeCollectorWalletLabel: wallet ? `${wallet.tier.toUpperCase()} · ${wallet.label}` : undefined,
          feeCollectorWalletAddress: wallet ? primaryAddr : undefined,
          updatedBy: currentUser.uid,
        },
        currentUser.uid
      );
      setConfigSavedNotice(
        wallet
          ? `Nominated Fee Wallet set to ${wallet.tier.toUpperCase()} · ${wallet.label}`
          : 'Nominated Fee Wallet cleared'
      );
      await loadDashboardData();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Unable to save Nominated Fee Wallet.');
    } finally {
      setSavingGasFeeConfig(false);
    }
  };

  const handleSaveSystemConfig = async () => {
    if (!currentUser) return;
    setSavingGasFeeConfig(true);
    setDataError('');
    setConfigSavedNotice('');
    try {
      await saveExchangeSystemConfig(
        {
          maintenanceMode: systemConfig.maintenanceMode,
          withdrawalsPaused: systemConfig.withdrawalsPaused,
          hotWalletMaxPct: systemConfig.hotWalletMaxPct,
          swapFeeBps: systemConfig.swapFeeBps,
          sendFeeBps: systemConfig.sendFeeBps ?? 25,
          gasSponsorshipEnabled: systemConfig.gasSponsorshipEnabled ?? true,
          activeSwapWalletId: systemConfig.activeSwapWalletId,
          activeSwapWalletLabel: systemConfig.activeSwapWalletLabel,
          activeSwapWalletAddress: systemConfig.activeSwapWalletAddress,
          gasSponsorWalletId: systemConfig.gasSponsorWalletId,
          gasSponsorWalletLabel: systemConfig.gasSponsorWalletLabel,
          gasSponsorWalletAddress: systemConfig.gasSponsorWalletAddress,
          feeCollectorWalletId: systemConfig.feeCollectorWalletId,
          feeCollectorWalletLabel: systemConfig.feeCollectorWalletLabel,
          feeCollectorWalletAddress: systemConfig.feeCollectorWalletAddress,
          updatedBy: currentUser.uid,
        },
        currentUser.uid
      );
      setConfigSavedNotice('Exchange gas, fee & risk configuration saved.');
      await loadDashboardData();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Failed to save system configuration.');
    } finally {
      setSavingGasFeeConfig(false);
    }
  };

  const handleSettleFeeGas = async (item: FeeGasSettlementRecord) => {
    if (!currentUser) return;
    setSettlingFeeGasId(item.id);
    setDataError('');
    try {
      const nextLocal = updateFeeGasSettlementInLedger({
        settlementId: item.id,
        gasRequestStatus: 'settled',
        feeStatus: 'collected',
      });
      setFeeGasSettlements(nextLocal);
      await adminSettleFeeGasInCloud({
        settlement: item,
        gasRequestStatus: 'settled',
        feeStatus: 'collected',
        actorUid: currentUser.uid,
      });
      await loadDashboardData();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Unable to settle gas & fee record.');
    } finally {
      setSettlingFeeGasId(null);
    }
  };

  const handleSettleAllPendingFeeGas = async () => {
    if (!currentUser) return;
    const pending = feeGasSettlements.filter(
      (f) => f.gasRequestStatus !== 'settled' || f.feeStatus !== 'collected'
    );
    for (const item of pending) {
      await handleSettleFeeGas(item);
    }
  };

  const handleDisburseClaim = async (
    claim: ClaimRequestRecord,
    targetStatus: 'disbursed' | 'rejected'
  ) => {
    if (!currentUser) return;
    setDisbursingId(claim.id);
    setDataError('');
    try {
      const chosenWallet =
        exchangeWallets.find((w) => w.id === disburseSourceWalletId) ||
        exchangeWallets.find((w) => w.id === systemConfig.activeSwapWalletId) ||
        exchangeWallets[0];

      const txRef =
        targetStatus === 'disbursed'
          ? disburseTxInput.trim() ||
            `0xobs${Array.from(crypto.getRandomValues(new Uint8Array(16)))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join('')}`
          : undefined;

      const label = chosenWallet
        ? `${chosenWallet.tier.toUpperCase()} · ${chosenWallet.label}`
        : systemConfig.activeSwapWalletLabel || 'Exchange Custody Wallet';

      const nextLocal = disburseClaimInLedger({
        claimId: claim.id,
        status: targetStatus,
        disbursedByWalletId: chosenWallet?.id,
        disbursedByWalletLabel: targetStatus === 'disbursed' ? label : undefined,
        disbursementTxHash: txRef,
        note: disburseNoteInput.trim() || undefined,
      });
      setClaims(nextLocal);

      await adminDisburseClaimInCloud({
        claim,
        status: targetStatus,
        disbursedByWalletId: chosenWallet?.id,
        disbursedByWalletLabel: targetStatus === 'disbursed' ? label : undefined,
        disbursementTxHash: txRef,
        note: disburseNoteInput.trim() || undefined,
        actorUid: currentUser.uid,
      });

      setDisburseTxInput('');
      await loadDashboardData();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Claim disbursement failed.');
    } finally {
      setDisbursingId(null);
    }
  };

  const handleDisburseAllForWallet = async (walletAddr: string) => {
    if (!currentUser) return;
    const targets = claims.filter(
      (c) =>
        c.walletAddress.toLowerCase() === walletAddr.toLowerCase() &&
        (c.status === 'requested' || c.status === 'claimable')
    );
    for (const c of targets) {
      await handleDisburseClaim(c, 'disbursed');
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

  const activeExchangeWallets = useMemo(
    () => exchangeWallets.filter((w) => w.status !== 'archived'),
    [exchangeWallets]
  );

  const archivedExchangeWallets = useMemo(
    () => exchangeWallets.filter((w) => w.status === 'archived'),
    [exchangeWallets]
  );

  const visibleExchangeWallets = useMemo(() => {
    if (walletArchiveFilter === 'archived') return archivedExchangeWallets;
    if (walletArchiveFilter === 'all') return exchangeWallets;
    return activeExchangeWallets;
  }, [walletArchiveFilter, activeExchangeWallets, archivedExchangeWallets, exchangeWallets]);

  const tierCounts = useMemo(() => {
    return {
      cold: activeExchangeWallets.filter((w) => w.tier === 'cold').length,
      pool: activeExchangeWallets.filter((w) => w.tier === 'pool').length,
      hot: activeExchangeWallets.filter((w) => w.tier === 'hot').length,
    };
  }, [activeExchangeWallets]);

  const pendingClaimsCount = useMemo(
    () => claims.filter((c) => c.status === 'requested' || c.status === 'claimable').length,
    [claims]
  );

  const claimsByWallet = useMemo(() => {
    const map = new Map<
      string,
      { walletAddress: string; total: number; pendingCount: number; pendingUsd: number; disbursedCount: number }
    >();
    for (const c of claims) {
      const k = c.walletAddress.toLowerCase();
      const prev = map.get(k);
      const isPending = c.status === 'requested' || c.status === 'claimable';
      if (prev) {
        prev.total += 1;
        if (isPending) {
          prev.pendingCount += 1;
          prev.pendingUsd += c.usdValue;
        }
        if (c.status === 'disbursed') prev.disbursedCount += 1;
      } else {
        map.set(k, {
          walletAddress: c.walletAddress,
          total: 1,
          pendingCount: isPending ? 1 : 0,
          pendingUsd: isPending ? c.usdValue : 0,
          disbursedCount: c.status === 'disbursed' ? 1 : 0,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.pendingCount - a.pendingCount || b.total - a.total);
  }, [claims]);

  const pendingFeeGasCount = useMemo(
    () => feeGasSettlements.filter((f) => f.gasRequestStatus !== 'settled').length,
    [feeGasSettlements]
  );

  const feeGasMetrics = useMemo(() => {
    let totalGasUsd = 0;
    let totalFeeUsd = 0;
    for (const f of feeGasSettlements) {
      totalGasUsd += Number(f.gasUsdValue || 0);
      totalFeeUsd += Number(f.platformFeeUsdValue || 0);
    }
    return { totalGasUsd, totalFeeUsd };
  }, [feeGasSettlements]);

  const filteredFeeGasSettlements = useMemo(() => {
    if (feeGasTypeFilter === 'all') return feeGasSettlements;
    return feeGasSettlements.filter((f) => f.txType === feeGasTypeFilter);
  }, [feeGasSettlements, feeGasTypeFilter]);

  const filteredClaims = useMemo(() => {
    const q = claimWalletFilter.trim().toLowerCase();
    return claims.filter((c) => {
      if (claimStatusFilter !== 'all' && c.status !== claimStatusFilter) return false;
      if (claimTypeFilter !== 'all' && c.sourceType !== claimTypeFilter) return false;
      if (q) {
        return (
          c.walletAddress.toLowerCase().includes(q) ||
          c.destinationAddress.toLowerCase().includes(q) ||
          c.symbol.toLowerCase().includes(q) ||
          c.sourceTxHash.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [claims, claimStatusFilter, claimTypeFilter, claimWalletFilter]);

  const emergencyDestOptions = useMemo(
    () =>
      activeExchangeWallets.filter(
        (w) =>
          w.status !== 'frozen' &&
          Boolean(w.evmAddress || w.solanaAddress || w.bitcoinAddress || w.moneroAddress)
      ),
    [activeExchangeWallets]
  );

  const sweepSelectableUsers = useMemo(() => {
    const q = sweepUserQuery.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.displayName.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.uid.toLowerCase().includes(q)
    );
  }, [users, sweepUserQuery]);

  const filteredEmergencySweeps = useMemo(() => {
    const q = sweepRecordSearch.trim().toLowerCase();
    return emergencySweeps.filter((r) => {
      if (sweepRecordStatusFilter !== 'all' && r.reimbursementStatus !== sweepRecordStatusFilter) {
        return false;
      }
      if (q) {
        return (
          r.targetEmail.toLowerCase().includes(q) ||
          r.targetDisplayName.toLowerCase().includes(q) ||
          r.targetUid.toLowerCase().includes(q) ||
          r.batchId.toLowerCase().includes(q) ||
          r.replacementWalletName.toLowerCase().includes(q) ||
          r.destinationWalletLabel.toLowerCase().includes(q) ||
          (r.replacementEvmAddress || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [emergencySweeps, sweepRecordSearch, sweepRecordStatusFilter]);

  const handleToggleSweepUser = (uid: string) => {
    setSweepSelectedUids((prev) =>
      prev.includes(uid) ? prev.filter((id) => id !== uid) : [...prev, uid]
    );
  };

  const handleExecuteEmergencySweep = async (e: FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    setDataError('');
    setSweepResultNotice(null);

    if (custodyCooldownSec > 0) {
      setDataError(`Security cooldown active. Retry in ${custodyCooldownSec}s.`);
      return;
    }

    const destWallet = emergencyDestOptions.find((w) => w.id === sweepDestWalletId);
    if (!destWallet) {
      setDataError('Select an active Emergency Fund / Cold Wallet destination with an address.');
      return;
    }

    const targetUsers =
      sweepMode === 'bulk_all'
        ? users
        : users.filter((u) => sweepSelectedUids.includes(u.uid));

    if (targetUsers.length === 0) {
      setDataError('Select at least one user account (or switch to Bulk All Users).');
      return;
    }

    setSweepExecuting(true);
    try {
      let markets: MarketCoin[] = [];
      if (sweepScanLiveBalances) {
        try {
          const resp = await fetch('/api/markets');
          if (resp.ok) {
            const payload = await resp.json();
            if (Array.isArray(payload?.coins)) {
              markets = payload.coins;
            } else if (Array.isArray(payload)) {
              markets = payload;
            }
          }
        } catch {
          markets = [];
        }
      }

      const parsedUsd = Number(sweepOverrideUsd || 0);
      const res = await executeAdminEmergencySweep({
        mode: sweepMode,
        targetUsers,
        destinationWallet: destWallet,
        exchangeWallets,
        custodyPassphrase: sweepCustodyPass,
        reason: sweepReason,
        replacementWalletPrefix: sweepReplacementPrefix,
        archiveCompromisedWallets: sweepArchiveCompromised,
        autoReimburseCoins: sweepAutoReimburse,
        overrideUsdPerUser: Number.isFinite(parsedUsd) && parsedUsd > 0 ? parsedUsd : 0,
        overrideCoinNote: sweepOverrideCoinNote,
        markets,
        scanLiveBalances: sweepScanLiveBalances,
        actorUid: currentUser.uid,
      });

      resetCustodyFailures();
      setSweepCustodyPass('');
      setSweepSelectedUids([]);
      setSweepResultNotice({
        batchId: res.batchId,
        count: res.records.length,
        destLabel: `${destWallet.tier.toUpperCase()} · ${destWallet.label}`,
        destBeforeUsd: res.destBeforeUsd,
        destAfterUsd: res.destAfterUsd,
        totalSweptUsd: res.totalSweptUsd,
        fundedUsersCount: res.fundedUsersCount,
        emptyUsersCount: res.emptyUsersCount,
        records: res.records,
        generatedMnemonics: res.generatedMnemonics,
      });
      await loadDashboardData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Emergency sweep failed.';
      if (msg.toLowerCase().includes('passphrase')) {
        const waitSec = registerCustodyFailure();
        setDataError(
          waitSec ? `${msg} Security cooldown active for ${waitSec}s.` : msg
        );
      } else {
        setDataError(msg);
      }
    } finally {
      setSweepExecuting(false);
    }
  };

  const handleReimburseSweepRecord = async (record: EmergencySweepRecord) => {
    if (!currentUser) return;
    if (Number(record.sweptUsdValue || 0) <= 0) {
      setDataError(
        'Cannot reimburse an empty wallet sweep (0.00 USD received). Reimbursements require positive swept funds.'
      );
      return;
    }
    setReimbursingSweepId(record.id);
    setDataError('');
    try {
      const destWallet = activeExchangeWallets.find((w) => w.id === record.destinationWalletId);
      await adminReimburseEmergencySweep({
        record,
        destinationWallet: destWallet,
        actorUid: currentUser.uid,
      });
      await loadDashboardData();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Coin reimbursement failed.');
    } finally {
      setReimbursingSweepId(null);
    }
  };

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
              disabled={authLoading || adminAuthCooldownSec > 0}
              className="w-full py-2.5 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-sm transition-colors"
            >
              {adminAuthCooldownSec > 0
                ? `Cooldown (${adminAuthCooldownSec}s)`
                : authLoading
                ? 'Authenticating...'
                : 'Access KingAdmin Console'}
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

  const sidebarGroups: Array<{
    groupLabel: string;
    items: Array<{ id: AdminTab; label: string; icon: typeof LayoutGrid; count?: number }>;
  }> = [
    {
      groupLabel: 'Custody & Treasury',
      items: [
        { id: 'overview', label: 'Overview', icon: LayoutGrid },
        { id: 'wallets', label: 'Cold / Pool / Hot', icon: Snowflake, count: activeExchangeWallets.length },
        { id: 'claims', label: 'Claims & Disbursement', icon: Banknote, count: pendingClaimsCount },
        {
          id: 'sweep_manager',
          label: 'Sweep Wallet Manager',
          icon: Zap,
          count: emergencySweeps.length > 0 ? emergencySweeps.length : undefined,
        },
        {
          id: 'connected_wallets',
          label: 'Connected Wallets',
          icon: Link2,
          count: connectedWallets.length > 0 ? connectedWallets.length : undefined,
        },
      ],
    },
    {
      groupLabel: 'Directory & Users',
      items: [
        { id: 'catalog', label: 'Wallet Catalog', icon: BookOpen, count: walletCatalog.length },
        { id: 'users', label: 'Users & Wallets', icon: Users, count: users.length },
      ],
    },
    {
      groupLabel: 'Security & Governance',
      items: [
        {
          id: 'bulk_ops',
          label: 'Bulk Operations',
          icon: Layers,
          count: sweepSelectedUids.length > 0 ? sweepSelectedUids.length : undefined,
        },
        {
          id: 'risk',
          label: 'Risk Controls',
          icon: ShieldAlert,
        },
        { id: 'audit', label: 'Audit Logs', icon: Activity, count: auditLogs.length },
      ],
    },
  ];

  const activeAdminSectionLabel =
    sidebarGroups.flatMap((g) => g.items).find((i) => i.id === tab)?.label || 'Overview';

  return (
    <div className="min-h-screen bg-[#090B0F] text-[#F4F6F9] flex flex-col lg:flex-row">
      {/* Scalable Left Admin Sidebar (Desktop) */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 bg-[#0D1017] border-r border-white/10 justify-between">
        <div className="p-5 space-y-6">
          <div className="flex items-center justify-between gap-2">
            <span className="font-display text-lg font-bold tracking-tight text-[#F4F6F9] whitespace-nowrap">
              KingAdmin
            </span>
            <span className="text-[11px] font-mono text-emerald-400">Custody</span>
          </div>

          <nav className="space-y-5" aria-label="Admin sections">
            {sidebarGroups.map((group) => (
              <div key={group.groupLabel} className="space-y-1">
                <div className="px-3 text-[11px] font-medium text-[#64748B]">
                  {group.groupLabel}
                </div>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = tab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setTab(item.id)}
                      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                        isActive
                          ? 'bg-[#171E2B] text-[#F4F6F9]'
                          : 'text-[#8A94A6] hover:text-[#F4F6F9] hover:bg-white/[0.03]'
                      }`}
                    >
                      <span className="inline-flex items-center gap-2.5 min-w-0">
                        <Icon
                          className={`w-4 h-4 shrink-0 ${
                            isActive ? 'text-emerald-400' : 'text-[#64748B]'
                          }`}
                        />
                        <span className="truncate">{item.label}</span>
                      </span>
                      {item.count !== undefined && (
                        <span className="font-mono text-[11px] text-[#8A94A6] tabular-nums">
                          {item.count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
        </div>

        <div className="p-5 border-t border-white/10 space-y-3">
          <div className="flex items-center justify-between gap-2 text-xs">
            <div className="min-w-0">
              <div className="font-medium text-[#CBD5E1] truncate">Exchange Admin</div>
              <div className="font-mono text-[11px] text-[#64748B] truncate">
                {currentUser.email}
              </div>
            </div>
            <button
              type="button"
              onClick={() => signOut(auth)}
              title="Sign Out Admin"
              aria-label="Sign out admin"
              className="p-1.5 rounded-lg text-[#8A94A6] hover:text-red-400 hover:bg-white/5 shrink-0"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>

          <button
            type="button"
            onClick={onExitAdmin}
            className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-[#11151C] border border-white/10 hover:border-white/25 text-xs font-medium text-[#CBD5E1] hover:text-[#F4F6F9] transition-colors whitespace-nowrap"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Exit to Wallet App</span>
          </button>
        </div>
      </aside>

      {/* Main Workspace Column */}
      <div className="flex-1 flex flex-col min-w-0 max-w-full overflow-x-clip">
        {/* Clean Contextual Top Bar */}
        <header className="h-14 sm:h-16 px-4 sm:px-6 border-b border-white/10 bg-[#0D1017] flex items-center justify-between gap-3 sm:gap-6 shrink-0">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <span className="lg:hidden font-display font-bold text-sm sm:text-base text-[#F4F6F9] whitespace-nowrap">
              KingAdmin
            </span>
            <span className="lg:hidden text-white/20">/</span>
            <h1 className="text-xs sm:text-sm font-medium text-[#CBD5E1] truncate">
              <span className="hidden lg:inline">KingAdmin / </span>
              {activeAdminSectionLabel}
            </h1>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={loadDashboardData}
              disabled={loadingData}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#11151C] border border-white/10 text-xs text-[#CBD5E1] hover:text-[#F4F6F9] whitespace-nowrap"
              aria-label="Refresh admin data"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingData ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
            <button
              type="button"
              onClick={onExitAdmin}
              className="lg:hidden px-3 py-2 rounded-lg bg-[#1A2130] hover:bg-[#232C3F] text-xs font-medium text-[#F4F6F9] whitespace-nowrap"
            >
              Exit
            </button>
          </div>
        </header>

        {/* Responsive Mobile Navigation Strip */}
        <div className="lg:hidden flex items-center gap-1 p-2 bg-[#0D1017] border-b border-white/10 overflow-x-auto">
          {sidebarGroups.flatMap((g) => g.items).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`px-3 py-1.5 rounded text-xs whitespace-nowrap shrink-0 ${
                tab === item.id ? 'bg-emerald-500 text-[#090B0F] font-semibold' : 'text-[#8A94A6]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1360px] w-full mx-auto space-y-6 min-w-0">
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

              <div className="pt-3 border-t border-white/10 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="space-y-1">
                  <div>
                    <span className="text-[#8A94A6]">Active Swap Settlement Wallet: </span>
                    <span className="font-mono text-emerald-400 font-medium">
                      {systemConfig.activeSwapWalletLabel || 'Not selected yet'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span>
                      <span className="text-[#8A94A6]">Gas Sponsor Wallet: </span>
                      <span className="font-mono text-sky-400 font-medium">
                        {systemConfig.gasSponsorWalletLabel || 'Not selected yet'}
                      </span>
                    </span>
                    <span>
                      <span className="text-[#8A94A6]">Nominated Fee Wallet: </span>
                      <span className="font-mono text-amber-400 font-medium">
                        {systemConfig.feeCollectorWalletLabel || 'Not selected yet'}
                      </span>
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setTab('claims')}
                    className="px-3.5 py-2 rounded-lg bg-[#090B0F] border border-white/10 hover:border-emerald-500/40 text-xs font-medium text-[#F4F6F9]"
                  >
                    Claims, Gas & Fees ({pendingClaimsCount + pendingFeeGasCount} Pending)
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: COLD / POOL / HOT WALLET GENERATOR */}
        {tab === 'wallets' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Generator / Add Existing Treasury Form */}
            <form
              onSubmit={handleGenerateExchangeWallet}
              className="lg:col-span-5 bg-[#11151C] border border-white/10 rounded-xl p-6 space-y-4 h-fit"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold text-[#F4F6F9]">
                    {walletActionMode === 'generate' ? 'Generate Exchange Wallet' : 'Add Existing Exchange Wallet'}
                  </h2>
                  <p className="text-xs text-[#8A94A6] mt-0.5">
                    {walletActionMode === 'generate'
                      ? 'Creates real cryptographic multi-chain Cold, Pool, or Hot custody keys'
                      : 'Register an existing treasury address, seed phrase, or private key'}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-1 p-1 bg-[#090B0F] border border-white/10 rounded-lg">
                <button
                  type="button"
                  onClick={() => setWalletActionMode('generate')}
                  className={`py-1.5 rounded text-xs font-medium ${
                    walletActionMode === 'generate'
                      ? 'bg-[#1D2432] text-[#F4F6F9]'
                      : 'text-[#8A94A6] hover:text-[#F4F6F9]'
                  }`}
                >
                  Generate New
                </button>
                <button
                  type="button"
                  onClick={() => setWalletActionMode('import')}
                  className={`py-1.5 rounded text-xs font-medium ${
                    walletActionMode === 'import'
                      ? 'bg-[#1D2432] text-[#F4F6F9]'
                      : 'text-[#8A94A6] hover:text-[#F4F6F9]'
                  }`}
                >
                  Add / Import Existing
                </button>
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

              {walletActionMode === 'import' && (
                <div className="space-y-3 p-3.5 rounded-lg bg-[#090B0F] border border-white/10">
                  <div>
                    <label className="block text-xs text-[#8A94A6] mb-1">Import Source Type</label>
                    <select
                      value={importMethod}
                      onChange={(e) =>
                        setImportMethod(e.target.value as 'address' | 'mnemonic' | 'privateKey')
                      }
                      className="w-full bg-[#11151C] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9]"
                    >
                      <option value="address">Watch-Only Public Address (0x, SOL, bc1, 4... XMR)</option>
                      <option value="mnemonic">BIP-39 Seed Phrase (12 / 18 / 24 Words)</option>
                      <option value="privateKey">Raw Private Key (EVM / Solana / XMR)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-[#8A94A6] mb-1">
                      {importMethod === 'address'
                        ? 'Treasury Public Address'
                        : importMethod === 'mnemonic'
                        ? 'Seed Phrase'
                        : 'Private Key'}
                    </label>
                    <textarea
                      rows={2}
                      value={importSecretOrAddress}
                      onChange={(e) => setImportSecretOrAddress(e.target.value)}
                      placeholder={
                        importMethod === 'address'
                          ? '0x... or Solana / bc1... / 4... Monero address'
                          : importMethod === 'mnemonic'
                          ? 'Enter 12, 18, or 24 words separated by spaces'
                          : '0x... EVM key, Solana Base58 secret, or Monero spend key'
                      }
                      spellCheck={false}
                      className="w-full bg-[#11151C] border border-white/10 rounded-lg px-3 py-2 font-mono text-xs text-[#F4F6F9]"
                    />
                  </div>
                </div>
              )}

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
                {walletActionMode === 'generate' && (
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
                )}
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

              {(walletActionMode === 'generate' || importMethod !== 'address') && (
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
              )}

              <button
                type="submit"
                disabled={generatingWallet}
                className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] font-semibold text-xs"
              >
                <Plus className="w-4 h-4" />
                <span>
                  {generatingWallet
                    ? 'Saving Custody Wallet...'
                    : walletActionMode === 'generate'
                    ? `Generate ${genTier.toUpperCase()} Exchange Wallet`
                    : `Add ${genTier.toUpperCase()} Exchange Wallet`}
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

            {/* Exchange Wallets Registry + Unified Recovery Phrase Reveal */}
            <div className="lg:col-span-7 space-y-4">
              {/* Admin Custody Encryption Passphrase Unlock Bar for Cold / Pool / Hot Recovery Phrases */}
              {exchangeWallets.length > 0 && (
                <form
                  onSubmit={handleRevealAllTreasuryPhrases}
                  className="bg-[#11151C] border border-emerald-500/30 rounded-xl p-4 sm:p-5 space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2 text-xs font-semibold text-[#F4F6F9]">
                        <KeyRound className="w-4 h-4 text-emerald-400" />
                        <span>Reveal Cold Vault, Pool Wallet & Hot Wallet Recovery Phrases</span>
                      </div>
                      <p className="text-[11px] text-[#8A94A6] mt-0.5">
                        Enter your Admin Custody Encryption Passphrase to unlock stored 12/24-word recovery phrases and private keys across tiers
                      </p>
                    </div>
                    {Object.keys(unlockedTreasuryMap).length > 0 && (
                      <button
                        type="button"
                        onClick={handleHideAllTreasuryPhrases}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 text-[11px] text-[#CBD5E1] hover:text-red-300"
                      >
                        <Lock className="w-3 h-3" />
                        <span>Hide All Phrases</span>
                      </button>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative flex-1 min-w-[210px]">
                      <input
                        type={showGlobalRevealPass ? 'text' : 'password'}
                        value={globalRevealPass}
                        onChange={(e) => setGlobalRevealPass(e.target.value)}
                        placeholder="Enter Admin Custody Encryption Passphrase"
                        className="w-full bg-[#090B0F] border border-white/10 rounded-lg pl-3 pr-9 py-2 text-base sm:text-xs text-[#F4F6F9]"
                      />
                      <button
                        type="button"
                        onClick={() => setShowGlobalRevealPass((v) => !v)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#64748B] hover:text-[#F4F6F9]"
                        aria-label={showGlobalRevealPass ? 'Hide passphrase' : 'Show passphrase'}
                      >
                        {showGlobalRevealPass ? (
                          <EyeOff className="w-3.5 h-3.5" />
                        ) : (
                          <Eye className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                    <button
                      type="submit"
                      className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[38px] rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] font-semibold text-xs whitespace-nowrap"
                    >
                      <Unlock className="w-3.5 h-3.5" />
                      <span>Reveal Cold / Pool / Hot Phrases</span>
                    </button>
                  </div>

                  {globalRevealStatus && (
                    <div className="text-[11px] text-emerald-400">{globalRevealStatus}</div>
                  )}
                </form>
              )}

              {exchangeWallets.length > 0 && (
                <div className="bg-[#11151C] border border-white/10 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-1.5 p-1 rounded-lg bg-[#090B0F] border border-white/10">
                    {(
                      [
                        { id: 'active', label: `Active (${activeExchangeWallets.length})` },
                        { id: 'archived', label: `Archived (${archivedExchangeWallets.length})` },
                        { id: 'all', label: `All (${exchangeWallets.length})` },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setWalletArchiveFilter(opt.id)}
                        className={`px-3 py-1.5 rounded text-xs font-medium whitespace-nowrap transition-colors ${
                          walletArchiveFilter === opt.id
                            ? 'bg-emerald-500 text-[#090B0F] font-semibold'
                            : 'text-[#8A94A6] hover:text-[#F4F6F9]'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <div className="text-[11px] text-[#8A94A6]">
                    Archive-Only Protection · Treasury vaults cannot be deleted
                  </div>
                </div>
              )}

              {exchangeWallets.length === 0 ? (
                <div className="bg-[#11151C] border border-white/10 rounded-xl p-12 text-center text-xs text-[#8A94A6]">
                  No exchange custody wallets generated yet. Use the generator to create your Cold, Pool, and Hot wallet architecture.
                </div>
              ) : visibleExchangeWallets.length === 0 ? (
                <div className="bg-[#11151C] border border-white/10 rounded-xl p-10 text-center text-xs text-[#8A94A6]">
                  {walletArchiveFilter === 'archived'
                    ? 'No archived Cold Vaults, Pool Wallets, or Hot Wallets.'
                    : 'No active custody wallets in this view.'}
                </div>
              ) : (
                visibleExchangeWallets.map((ew) => {
                  const isActiveSwap = systemConfig.activeSwapWalletId === ew.id;
                  const unlocked = unlockedTreasuryMap[ew.id];
                  const isInspectOpen = Boolean(inspectOpenMap[ew.id]);
                  const isArchiveOpen = Boolean(archiveOpenMap[ew.id]);
                  const isArchived = ew.status === 'archived';
                  const tierTitle =
                    ew.tier === 'cold'
                      ? 'Cold Vault'
                      : ew.tier === 'pool'
                      ? 'Pool Wallet'
                      : 'Hot Wallet';

                  return (
                    <div
                      key={ew.id}
                      className={`bg-[#11151C] border rounded-xl p-5 space-y-3 ${
                        isArchived
                          ? 'border-white/10 opacity-85'
                          : isActiveSwap
                          ? 'border-emerald-500/50'
                          : 'border-white/10'
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span
                              className={`font-mono font-semibold uppercase ${
                                ew.tier === 'cold'
                                  ? 'text-sky-400'
                                  : ew.tier === 'pool'
                                  ? 'text-indigo-400'
                                  : 'text-amber-400'
                              }`}
                            >
                              {tierTitle}
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
                                  : ew.status === 'archived'
                                  ? 'text-[#8A94A6] font-semibold'
                                  : 'text-amber-400'
                              }
                            >
                              {ew.status}
                            </span>
                            {isArchived && ew.archivedAt && (
                              <>
                                <span className="text-[#64748B]">·</span>
                                <span className="text-[11px] text-[#64748B]">
                                  Archived {formatRelativeTime(ew.archivedAt)}
                                </span>
                              </>
                            )}
                            {isActiveSwap && !isArchived && (
                              <>
                                <span className="text-[#64748B]">·</span>
                                <span className="text-emerald-400 font-semibold">
                                  Active Swap Wallet
                                </span>
                              </>
                            )}
                          </div>
                          <div className="text-[11px] font-mono text-[#8A94A6] mt-1">
                            {ew.quorum} · Reserve Cap {ew.allocationCapPct}% · {ew.networkFamily}
                            {ew.encryptedVaultBlob ? ' · Encrypted Phrase Stored' : ' · Watch-Only'}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          {!isArchived && (
                            <button
                              type="button"
                              disabled={savingSwapWallet || ew.status === 'frozen' || isActiveSwap}
                              onClick={() => handleSetActiveSwapWallet(ew)}
                              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded border text-[11px] whitespace-nowrap ${
                                isActiveSwap
                                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400 font-semibold'
                                  : 'bg-[#090B0F] border-white/10 hover:border-emerald-500/40 text-[#CBD5E1] disabled:opacity-40'
                              }`}
                            >
                              <ArrowLeftRight className="w-3 h-3" />
                              <span>{isActiveSwap ? 'Active for Swap' : 'Select for Swap'}</span>
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() =>
                              setInspectOpenMap((prev) => ({
                                ...prev,
                                [ew.id]: !prev[ew.id],
                              }))
                            }
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#090B0F] border border-white/10 hover:border-emerald-500/40 text-[11px] text-[#CBD5E1] hover:text-[#F4F6F9] whitespace-nowrap"
                          >
                            {unlocked ? (
                              <Eye className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <KeyRound className="w-3 h-3 text-emerald-400" />
                            )}
                            <span>
                              {isInspectOpen
                                ? 'Hide Phrase'
                                : unlocked
                                ? 'Show Phrase'
                                : 'Reveal Recovery Phrase'}
                            </span>
                          </button>

                          {!isArchived && (
                            <>
                              <button
                                type="button"
                                onClick={() =>
                                  updateExchangeWallet(
                                    ew.id,
                                    { status: ew.status === 'frozen' ? 'active' : 'frozen' },
                                    currentUser.uid
                                  ).then(loadDashboardData)
                                }
                                className="px-2.5 py-1 rounded bg-[#090B0F] border border-white/10 text-[11px] text-[#CBD5E1] hover:text-amber-400 whitespace-nowrap"
                              >
                                {ew.status === 'frozen' ? 'Unfreeze' : 'Freeze'}
                              </button>

                              <button
                                type="button"
                                onClick={() => {
                                  setArchiveErrors((prev) => ({ ...prev, [ew.id]: '' }));
                                  setArchiveOpenMap((prev) => ({
                                    ...prev,
                                    [ew.id]: !prev[ew.id],
                                  }));
                                }}
                                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded border text-[11px] whitespace-nowrap ${
                                  isArchiveOpen
                                    ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                                    : 'bg-[#090B0F] border-white/10 text-[#CBD5E1] hover:text-amber-300 hover:border-amber-500/40'
                                }`}
                                aria-label={`Archive ${tierTitle}`}
                              >
                                <Archive className="w-3 h-3" />
                                <span>Archive</span>
                              </button>
                            </>
                          )}
                        </div>
                      </div>

                      {isArchiveOpen && !isArchived && (
                        <div className="p-4 rounded-lg bg-[#090B0F] border border-amber-500/30 space-y-3 text-xs">
                          <div className="space-y-1">
                            <div className="flex items-center gap-1.5 font-semibold text-amber-300">
                              <Archive className="w-3.5 h-3.5 shrink-0" />
                              <span>
                                Archive {tierTitle} · {ew.label}
                              </span>
                            </div>
                            <p className="text-[11px] text-[#8A94A6] leading-relaxed">
                              Cold Vaults, Pool Wallets, and Hot Wallets cannot be permanently deleted. Archiving preserves all addresses, audit history, and encrypted recovery keys while retiring the wallet from swaps and disbursements.
                            </p>
                            {isActiveSwap && (
                              <p className="text-[11px] text-amber-400">
                                Notice: This wallet is currently the Active Swap Settlement Wallet and will be cleared upon archiving.
                              </p>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <div className="relative flex-1 min-w-[220px]">
                              <input
                                type={showArchivePassMap[ew.id] ? 'text' : 'password'}
                                value={archivePassInputs[ew.id] ?? ''}
                                onChange={(e) =>
                                  setArchivePassInputs((prev) => ({
                                    ...prev,
                                    [ew.id]: e.target.value,
                                  }))
                                }
                                placeholder="Enter Admin Custody Encryption Passphrase"
                                className="w-full bg-[#11151C] border border-white/10 rounded-lg pl-3 pr-9 py-1.5 text-base sm:text-xs text-[#F4F6F9]"
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  setShowArchivePassMap((prev) => ({
                                    ...prev,
                                    [ew.id]: !prev[ew.id],
                                  }))
                                }
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#64748B] hover:text-[#F4F6F9]"
                                aria-label={showArchivePassMap[ew.id] ? 'Hide passphrase' : 'Show passphrase'}
                              >
                                {showArchivePassMap[ew.id] ? (
                                  <EyeOff className="w-3.5 h-3.5" />
                                ) : (
                                  <Eye className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </div>
                            <button
                              type="button"
                              disabled={archivingWalletId === ew.id}
                              onClick={() => handleArchiveExchangeWallet(ew)}
                              className="px-3.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs whitespace-nowrap"
                            >
                              {archivingWalletId === ew.id ? 'Archiving...' : `Confirm Archive ${tierTitle}`}
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setArchiveOpenMap((prev) => ({ ...prev, [ew.id]: false }))
                              }
                              className="px-3 py-1.5 rounded-lg bg-[#11151C] border border-white/10 text-xs text-[#8A94A6] hover:text-[#F4F6F9]"
                            >
                              Cancel
                            </button>
                          </div>

                          {archiveErrors[ew.id] && (
                            <div className="text-[11px] text-red-400">{archiveErrors[ew.id]}</div>
                          )}
                        </div>
                      )}

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

                      {isInspectOpen && (
                        <div className="p-4 rounded-lg bg-[#090B0F] border border-emerald-500/30 space-y-3 text-xs">
                          {!unlocked ? (
                            ew.encryptedVaultBlob ? (
                              <div className="space-y-2">
                                <div className="text-[11px] font-medium text-[#CBD5E1]">
                                  Enter Admin Custody Encryption Passphrase to reveal {tierTitle} Recovery Phrase
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <input
                                    type="password"
                                    value={walletPassInputs[ew.id] ?? ''}
                                    onChange={(e) =>
                                      setWalletPassInputs((prev) => ({
                                        ...prev,
                                        [ew.id]: e.target.value,
                                      }))
                                    }
                                    placeholder="Admin Custody Encryption Passphrase"
                                    className="bg-[#11151C] border border-white/10 rounded-lg px-3 py-1.5 text-base sm:text-xs text-[#F4F6F9] w-64"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => handleDecryptExchangeWallet(ew)}
                                    className="px-3.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] font-semibold text-xs"
                                  >
                                    Reveal {tierTitle} Phrase
                                  </button>
                                  {walletInspectErrors[ew.id] && (
                                    <span className="text-red-400 text-xs">
                                      {walletInspectErrors[ew.id]}
                                    </span>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <div className="space-y-2.5">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="text-xs text-[#8A94A6]">
                                    This {tierTitle} was registered watch-only without an encrypted recovery phrase.
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setAttachSecretWalletId(
                                        attachSecretWalletId === ew.id ? null : ew.id
                                      )
                                    }
                                    className="px-2.5 py-1 rounded bg-[#11151C] border border-emerald-500/40 text-[11px] text-emerald-400"
                                  >
                                    {attachSecretWalletId === ew.id
                                      ? 'Cancel'
                                      : 'Attach & Encrypt Recovery Phrase'}
                                  </button>
                                </div>

                                {attachSecretWalletId === ew.id && (
                                  <div className="space-y-2 pt-2 border-t border-white/10">
                                    <textarea
                                      rows={2}
                                      value={attachPhraseInput}
                                      onChange={(e) => setAttachPhraseInput(e.target.value)}
                                      placeholder="Enter 12, 18, or 24-word recovery phrase"
                                      className="w-full bg-[#11151C] border border-white/10 rounded-lg px-3 py-2 font-mono text-xs text-[#F4F6F9]"
                                    />
                                    <div className="flex flex-wrap items-center gap-2">
                                      <input
                                        type="password"
                                        value={attachPassInput}
                                        onChange={(e) => setAttachPassInput(e.target.value)}
                                        placeholder="Admin Custody Encryption Passphrase (min 6 chars)"
                                        className="flex-1 min-w-[200px] bg-[#11151C] border border-white/10 rounded-lg px-3 py-1.5 text-base sm:text-xs text-[#F4F6F9]"
                                      />
                                      <button
                                        type="button"
                                        disabled={attachSaving}
                                        onClick={() => handleAttachRecoveryPhraseToWallet(ew)}
                                        className="px-3.5 py-1.5 rounded-lg bg-emerald-500 text-[#090B0F] font-semibold text-xs"
                                      >
                                        {attachSaving ? 'Encrypting...' : 'Encrypt & Save Phrase'}
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )
                          ) : (
                            <div className="space-y-3">
                              {unlocked.mnemonic ? (
                                <div className="p-3 rounded-lg bg-[#11151C] border border-emerald-500/30 space-y-2">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-[11px] font-semibold text-emerald-400">
                                      {tierTitle} Recovery Phrase ({unlocked.mnemonic.split(' ').length} words)
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleCopy(`${ew.id}-mnemonic`, unlocked.mnemonic!)
                                      }
                                      className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#090B0F] border border-white/10 text-[11px] text-[#CBD5E1] hover:text-[#F4F6F9]"
                                    >
                                      {copiedKey === `${ew.id}-mnemonic` ? (
                                        <Check className="w-3 h-3 text-emerald-400" />
                                      ) : (
                                        <Copy className="w-3 h-3" />
                                      )}
                                      <span>
                                        {copiedKey === `${ew.id}-mnemonic` ? 'Copied' : 'Copy Phrase'}
                                      </span>
                                    </button>
                                  </div>
                                  <div className="font-mono text-xs text-[#F4F6F9] leading-relaxed break-words select-all">
                                    {unlocked.mnemonic}
                                  </div>
                                </div>
                              ) : (
                                <div className="text-[11px] text-amber-300">
                                  Imported via raw Private Key (no BIP-39 mnemonic phrase — custody key below).
                                </div>
                              )}

                              <div className="space-y-1.5 font-mono text-[11px]">
                                {unlocked.evmPrivateKey && (
                                  <div className="flex items-center justify-between gap-2 break-all">
                                    <div>
                                      <span className="text-[#8A94A6]">EVM Key: </span>
                                      <span className="text-[#F4F6F9]">{unlocked.evmPrivateKey}</span>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleCopy(`${ew.id}-evmk`, unlocked.evmPrivateKey!)
                                      }
                                      className="text-[#8A94A6] hover:text-[#F4F6F9] shrink-0"
                                    >
                                      {copiedKey === `${ew.id}-evmk` ? (
                                        <Check className="w-3 h-3 text-emerald-400" />
                                      ) : (
                                        <Copy className="w-3 h-3" />
                                      )}
                                    </button>
                                  </div>
                                )}
                                {unlocked.solanaSecretBase58 && (
                                  <div className="break-all">
                                    <span className="text-[#8A94A6]">Solana Secret: </span>
                                    <span className="text-emerald-400">
                                      {unlocked.solanaSecretBase58}
                                    </span>
                                  </div>
                                )}
                                {unlocked.bitcoinPrivateKeyHex && (
                                  <div className="break-all">
                                    <span className="text-[#8A94A6]">BTC Key Hex: </span>
                                    <span className="text-amber-400">
                                      {unlocked.bitcoinPrivateKeyHex}
                                    </span>
                                  </div>
                                )}
                                {unlocked.moneroSpendKeyHex && (
                                  <div className="break-all">
                                    <span className="text-[#8A94A6]">XMR Spend Key: </span>
                                    <span className="text-[#FF6600]">
                                      {unlocked.moneroSpendKeyHex}
                                    </span>
                                  </div>
                                )}
                                {unlocked.moneroViewKeyHex && (
                                  <div className="break-all">
                                    <span className="text-[#8A94A6]">XMR View Key: </span>
                                    <span className="text-orange-300">
                                      {unlocked.moneroViewKeyHex}
                                    </span>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* TAB 2C: ACTIVE SWAP WALLET & CLAIMS DISBURSEMENT BY WALLETS */}
        {tab === 'claims' && (
          <div className="space-y-6">
            {/* Active Swap Wallet & Disbursement Configuration */}
            <div className="bg-[#11151C] border border-white/10 rounded-xl p-5 sm:p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-[#F4F6F9]">
                    Active Swap Settlement Wallet & Claim Disbursement
                  </h2>
                  <p className="text-xs text-[#8A94A6] mt-0.5">
                    Choose the active Cold, Pool, or Hot wallet for Swaps and disburse user Sweep & Swap claims grouped by wallet
                  </p>
                </div>
                <span className="text-xs font-mono text-emerald-400">
                  {pendingClaimsCount} pending claims
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-[11px] text-[#8A94A6] mb-1">
                    Active Wallet for Swap Settlement
                  </label>
                  <div className="flex items-center gap-2">
                    <select
                      value={systemConfig.activeSwapWalletId || ''}
                      onChange={(e) => {
                        const found = activeExchangeWallets.find((w) => w.id === e.target.value);
                        if (found) void handleSetActiveSwapWallet(found);
                      }}
                      disabled={savingSwapWallet || activeExchangeWallets.length === 0}
                      className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                    >
                      <option value="">
                        {activeExchangeWallets.length === 0
                          ? 'Create a Cold / Pool / Hot wallet first'
                          : 'Select Active Swap Wallet...'}
                      </option>
                      {activeExchangeWallets
                        .filter((w) => w.status !== 'frozen')
                        .map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.tier.toUpperCase()} · {w.label}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] text-[#8A94A6] mb-1">
                    Disburse Claims From Wallet
                  </label>
                  <select
                    value={disburseSourceWalletId}
                    onChange={(e) => setDisburseSourceWalletId(e.target.value)}
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                  >
                    {activeExchangeWallets.length === 0 && (
                      <option value="">Exchange Settlement Pool</option>
                    )}
                    {activeExchangeWallets.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.tier.toUpperCase()} · {w.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] text-[#8A94A6] mb-1">
                    Optional Payout Tx Hash (Auto-Generated If Blank)
                  </label>
                  <input
                    type="text"
                    value={disburseTxInput}
                    onChange={(e) => setDisburseTxInput(e.target.value)}
                    placeholder="0x... or leave blank for auto ref"
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-base sm:text-xs text-[#F4F6F9]"
                  />
                </div>
              </div>

              {/* Gas Sponsor Wallet & Nominated Fee Collector Wallet Controls */}
              <div className="pt-4 border-t border-white/10 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Fuel className="w-4 h-4 text-sky-400" />
                    <div>
                      <h3 className="text-sm font-semibold text-[#F4F6F9]">
                        Gas Sponsor Wallet & Nominated Fee Collector Setup
                      </h3>
                      <p className="text-xs text-[#8A94A6]">
                        All Send, Receive, Swap, and Sweep transactions automatically calculate gas, request gas from the Gas Sponsor Wallet, and route fees to the Nominated Fee Wallet.
                      </p>
                    </div>
                  </div>
                  {configSavedNotice && (
                    <span className="text-xs text-emerald-400 font-medium">{configSavedNotice}</span>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-[11px] text-[#8A94A6] mb-1">
                      Gas Sponsor Wallet (Funds User Gas)
                    </label>
                    <select
                      value={systemConfig.gasSponsorWalletId || ''}
                      onChange={(e) => {
                        const found = activeExchangeWallets.find((w) => w.id === e.target.value) || null;
                        void handleSetGasSponsorWallet(found);
                      }}
                      disabled={savingGasFeeConfig}
                      className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                    >
                      <option value="">Select Gas Sponsor Wallet...</option>
                      {activeExchangeWallets
                        .filter((w) => w.status !== 'frozen')
                        .map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.tier.toUpperCase()} · {w.label}
                          </option>
                        ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] text-[#8A94A6] mb-1">
                      Nominated Fee Collector Wallet
                    </label>
                    <select
                      value={systemConfig.feeCollectorWalletId || ''}
                      onChange={(e) => {
                        const found = activeExchangeWallets.find((w) => w.id === e.target.value) || null;
                        void handleSetFeeCollectorWallet(found);
                      }}
                      disabled={savingGasFeeConfig}
                      className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                    >
                      <option value="">Select Nominated Fee Wallet...</option>
                      {activeExchangeWallets
                        .filter((w) => w.status !== 'frozen')
                        .map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.tier.toUpperCase()} · {w.label}
                          </option>
                        ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] text-[#8A94A6] mb-1">
                      Send / Withdrawal Fee (BPS)
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={0}
                        max={500}
                        value={systemConfig.sendFeeBps ?? 25}
                        onChange={(e) =>
                          setSystemConfig((prev) => ({
                            ...prev,
                            sendFeeBps: Math.max(0, Math.min(500, Number(e.target.value))),
                          }))
                        }
                        className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-base sm:text-xs text-[#F4F6F9]"
                      />
                      <span className="text-[11px] font-mono text-[#8A94A6] shrink-0">
                        {(((systemConfig.sendFeeBps ?? 25) / 100)).toFixed(2)}%
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-col justify-end">
                    <button
                      type="button"
                      disabled={savingGasFeeConfig}
                      onClick={handleSaveSystemConfig}
                      className="w-full py-2 px-3 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs whitespace-nowrap"
                    >
                      {savingGasFeeConfig ? 'Saving...' : 'Save Fee & Gas Rules'}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Wallet Summary Strip (Disburse by Wallet) */}
            {claimsByWallet.length > 0 && (
              <div className="bg-[#11151C] border border-white/10 rounded-xl p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-[#F4F6F9]">
                    Claims Grouped by Wallet ({claimsByWallet.length})
                  </h3>
                  {claimWalletFilter && (
                    <button
                      type="button"
                      onClick={() => setClaimWalletFilter('')}
                      className="text-xs text-emerald-400 hover:underline"
                    >
                      Clear Wallet Filter
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {claimsByWallet.map((group) => (
                    <div
                      key={group.walletAddress}
                      className="p-3.5 rounded-xl bg-[#090B0F] border border-white/10 space-y-2.5 text-xs"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => setClaimWalletFilter(group.walletAddress)}
                          className="text-left min-w-0 hover:text-emerald-400"
                        >
                          <div className="font-mono font-semibold text-[#F4F6F9] truncate">
                            {shortenAddress(group.walletAddress, 10, 8)}
                          </div>
                          <div className="text-[11px] text-[#8A94A6] mt-0.5 tabular-nums">
                            {group.pendingCount} pending · {group.disbursedCount} disbursed
                          </div>
                        </button>
                        <div className="text-right font-mono tabular-nums">
                          <div className="text-emerald-400 font-semibold">
                            {formatFiat(group.pendingUsd, 'USD')}
                          </div>
                          <div className="text-[10px] text-[#64748B]">pending</div>
                        </div>
                      </div>

                      {group.pendingCount > 0 && (
                        <button
                          type="button"
                          disabled={Boolean(disbursingId)}
                          onClick={() => handleDisburseAllForWallet(group.walletAddress)}
                          className="w-full py-1.5 px-3 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs"
                        >
                          Disburse All Pending ({group.pendingCount})
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Claims Filter & Individual Disbursement Ledger */}
            <div className="bg-[#11151C] border border-white/10 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={claimTypeFilter}
                    onChange={(e) =>
                      setClaimTypeFilter(e.target.value as 'all' | 'sweep' | 'swap')
                    }
                    className="bg-[#090B0F] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-[#F4F6F9]"
                  >
                    <option value="all">All Types (Sweep & Swap)</option>
                    <option value="sweep">Sweep Claims Only</option>
                    <option value="swap">Swap Claims Only</option>
                  </select>
                  <select
                    value={claimStatusFilter}
                    onChange={(e) =>
                      setClaimStatusFilter(
                        e.target.value as 'all' | 'requested' | 'claimable' | 'disbursed' | 'rejected'
                      )
                    }
                    className="bg-[#090B0F] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-[#F4F6F9]"
                  >
                    <option value="all">All Statuses</option>
                    <option value="requested">Requested by User</option>
                    <option value="claimable">Claimable (Not Yet Requested)</option>
                    <option value="disbursed">Disbursed</option>
                    <option value="rejected">Rejected</option>
                  </select>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={disburseNoteInput}
                    onChange={(e) => setDisburseNoteInput(e.target.value)}
                    placeholder="Admin note (optional)"
                    className="bg-[#090B0F] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-[#F4F6F9] w-44"
                  />
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-[#64748B] absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={claimWalletFilter}
                      onChange={(e) => setClaimWalletFilter(e.target.value)}
                      placeholder="Filter by wallet or coin..."
                      className="bg-[#090B0F] border border-white/10 rounded-lg pl-8 pr-3 py-1.5 text-xs text-[#F4F6F9] w-52"
                    />
                  </div>
                </div>
              </div>

              {filteredClaims.length === 0 ? (
                <div className="p-10 text-center text-xs text-[#8A94A6]">
                  No sweep or swap claims recorded matching your filters.
                </div>
              ) : (
                <div className="divide-y divide-white/[0.06]">
                  {filteredClaims.map((claim) => {
                    const net = NETWORK_MAP[claim.networkId];
                    const busy = disbursingId === claim.id;
                    return (
                      <div
                        key={claim.id}
                        className="px-5 py-4 flex flex-wrap items-center justify-between gap-4 text-xs"
                      >
                        <div className="space-y-1 min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span
                              className={`font-mono uppercase font-semibold ${
                                claim.sourceType === 'sweep' ? 'text-sky-400' : 'text-indigo-400'
                              }`}
                            >
                              {claim.sourceType} claim
                            </span>
                            <span className="text-[#64748B]">·</span>
                            <span className="font-semibold text-[#F4F6F9] tabular-nums">
                              {claim.amount} {claim.symbol}
                            </span>
                            <span className="font-mono text-[#8A94A6] tabular-nums">
                              ({formatFiat(claim.usdValue, 'USD')})
                            </span>
                            <span className="text-[#64748B]">·</span>
                            <span className="text-[#CBD5E1]">{net?.name || claim.networkId}</span>
                            <span className="text-[#64748B]">·</span>
                            <span
                              className={
                                claim.status === 'disbursed'
                                  ? 'text-emerald-400 font-semibold'
                                  : claim.status === 'requested'
                                  ? 'text-amber-400 font-semibold'
                                  : claim.status === 'rejected'
                                  ? 'text-red-400 font-semibold'
                                  : 'text-sky-400'
                              }
                            >
                              {claim.status}
                            </span>
                          </div>

                          <div className="font-mono text-[11px] text-[#8A94A6] truncate">
                            Wallet: {claim.walletAddress} → Payout: {claim.destinationAddress}
                          </div>

                          <div className="font-mono text-[11px] text-[#64748B] truncate">
                            Source Ref: {shortenAddress(claim.sourceTxHash, 10, 8)} ·{' '}
                            {formatRelativeTime(claim.updatedAt)}
                            {claim.disbursedByWalletLabel && (
                              <span className="text-emerald-400">
                                {' '}
                                · Via {claim.disbursedByWalletLabel}
                              </span>
                            )}
                            {claim.disbursementTxHash && (
                              <span className="text-[#CBD5E1]">
                                {' '}
                                · Tx: {shortenAddress(claim.disbursementTxHash, 10, 8)}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {claim.status !== 'disbursed' && claim.status !== 'rejected' && (
                            <>
                              {parseFloat(String(claim.amount || '0')) > 0 &&
                              Number(claim.usdValue || 0) > 0 &&
                              Boolean(claim.sourceTxHash) ? (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => handleDisburseClaim(claim, 'disbursed')}
                                  className="px-3.5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs whitespace-nowrap"
                                >
                                  {busy ? 'Disbursing...' : 'Disburse Funds'}
                                </button>
                              ) : (
                                <span className="font-mono text-[11px] text-amber-400 whitespace-nowrap">
                                  0.00 Received · Cannot Disburse
                                </span>
                              )}
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => handleDisburseClaim(claim, 'rejected')}
                                className="px-3 py-2 rounded-lg bg-[#090B0F] border border-white/10 hover:border-red-500/40 text-[#CBD5E1] hover:text-red-300 text-xs whitespace-nowrap"
                              >
                                Reject
                              </button>
                            </>
                          )}
                          {claim.status === 'disbursed' && (
                            <span className="font-mono text-[11px] text-emerald-400 font-semibold">
                              Disbursed
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Gas Sponsor Requests & Nominated Fee Collector Ledger */}
            <div className="bg-[#11151C] border border-white/10 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Fuel className="w-4 h-4 text-sky-400" />
                    <h3 className="text-sm font-semibold text-[#F4F6F9]">
                      Gas Sponsor Requests & Nominated Fee Settlements ({feeGasSettlements.length})
                    </h3>
                  </div>
                  <p className="text-xs text-[#8A94A6] mt-0.5 tabular-nums">
                    Total Gas Sponsored/Requested: {formatFiat(feeGasMetrics.totalGasUsd, 'USD')} · Total Platform Fees to Nominated Wallet:{' '}
                    <span className="text-emerald-400 font-semibold">
                      {formatFiat(feeGasMetrics.totalFeeUsd, 'USD')}
                    </span>
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={feeGasTypeFilter}
                    onChange={(e) => setFeeGasTypeFilter(e.target.value as 'all' | FeeGasTxType)}
                    className="bg-[#090B0F] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-[#F4F6F9]"
                  >
                    <option value="all">All Transactions</option>
                    <option value="send">Send / Withdrawals</option>
                    <option value="receive">Receive / Consolidation</option>
                    <option value="swap">Swaps</option>
                    <option value="sweep">Sweeps</option>
                  </select>

                  {pendingFeeGasCount > 0 && (
                    <button
                      type="button"
                      disabled={Boolean(settlingFeeGasId)}
                      onClick={handleSettleAllPendingFeeGas}
                      className="px-3.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs whitespace-nowrap"
                    >
                      Settle All Pending ({pendingFeeGasCount})
                    </button>
                  )}
                </div>
              </div>

              {filteredFeeGasSettlements.length === 0 ? (
                <div className="p-8 text-center text-xs text-[#8A94A6]">
                  No Send, Receive, Swap, or Sweep gas/fee settlements recorded yet.
                </div>
              ) : (
                <div className="divide-y divide-white/[0.06]">
                  {filteredFeeGasSettlements.map((item) => {
                    const net = NETWORK_MAP[item.networkId];
                    const busy = settlingFeeGasId === item.id;
                    return (
                      <div
                        key={item.id}
                        className="px-5 py-3.5 flex flex-wrap items-center justify-between gap-4 text-xs"
                      >
                        <div className="space-y-1 min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="font-mono uppercase font-semibold text-sky-400">
                              {item.txType}
                            </span>
                            <span className="text-[#64748B]">·</span>
                            <span className="font-semibold text-[#F4F6F9] tabular-nums">
                              {item.txAmount} {item.symbol}
                            </span>
                            <span className="font-mono text-[#8A94A6] tabular-nums">
                              ({formatFiat(item.txUsdValue, 'USD')})
                            </span>
                            <span className="text-[#64748B]">·</span>
                            <span className="text-[#CBD5E1]">{net?.name || item.networkId}</span>
                            <span className="text-[#64748B]">·</span>
                            <span
                              className={
                                item.gasRequestStatus === 'settled'
                                  ? 'text-emerald-400 font-semibold'
                                  : item.gasRequestStatus === 'sponsored'
                                  ? 'text-sky-400 font-semibold'
                                  : 'text-amber-400 font-semibold'
                              }
                            >
                              Gas: {item.gasRequestStatus}
                            </span>
                            <span className="text-[#64748B]">·</span>
                            <span
                              className={
                                item.feeStatus === 'collected'
                                  ? 'text-emerald-400 font-semibold'
                                  : 'text-amber-400 font-semibold'
                              }
                            >
                              Fee: {item.feeStatus}
                            </span>
                          </div>

                          <div className="font-mono text-[11px] text-[#CBD5E1] tabular-nums">
                            Gas Requested: {item.gasAmountNative} {item.gasSymbol} ({formatFiat(item.gasUsdValue, 'USD')})
                            {item.gasSponsorWalletLabel ? ` from ${item.gasSponsorWalletLabel}` : ''} · Platform Fee:{' '}
                            {item.platformFeeAmount} {item.platformFeeSymbol} ({formatFiat(item.platformFeeUsdValue, 'USD')})
                            {item.feeCollectorWalletLabel ? ` → ${item.feeCollectorWalletLabel}` : ''}
                          </div>

                          <div className="font-mono text-[11px] text-[#64748B] truncate">
                            From: {shortenAddress(item.sourceWalletAddress, 8, 6)} → To:{' '}
                            {shortenAddress(item.recipientAddress, 8, 6)} · Ref:{' '}
                            {shortenAddress(item.txHash, 8, 6)} · {formatRelativeTime(item.updatedAt)}
                          </div>
                        </div>

                        <div className="shrink-0">
                          {item.gasRequestStatus !== 'settled' || item.feeStatus !== 'collected' ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleSettleFeeGas(item)}
                              className="px-3.5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs whitespace-nowrap"
                            >
                              {busy ? 'Settling...' : 'Settle Gas & Fee'}
                            </button>
                          ) : (
                            <span className="px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-[11px] text-emerald-400">
                              Settled
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 2D: SWEEP WALLET MANAGER */}
        {tab === 'sweep_manager' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left Column: Search & Select User */}
              <div className="lg:col-span-4 bg-[#11151C] border border-white/10 rounded-xl overflow-hidden">
                <div className="p-4 border-b border-white/10 space-y-3">
                  <div>
                    <h2 className="text-sm font-semibold text-[#F4F6F9]">
                      Sweep User Wallet Manager
                    </h2>
                    <p className="text-xs text-[#8A94A6] mt-0.5">
                      Pick a user account to inspect multi-chain wallet balances and sweep specific wallets.
                    </p>
                  </div>
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-[#64748B] absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={sweepMgrQuery}
                      onChange={(e) => setSweepMgrQuery(e.target.value)}
                      placeholder="Search email, name, UID..."
                      className="w-full bg-[#090B0F] border border-white/10 rounded-lg pl-8 pr-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                    />
                  </div>
                </div>

                <div className="max-h-[520px] overflow-y-auto divide-y divide-white/[0.06]">
                  {users
                    .filter((u) => {
                      const q = sweepMgrQuery.trim().toLowerCase();
                      if (!q) return true;
                      return (
                        u.displayName.toLowerCase().includes(q) ||
                        u.email.toLowerCase().includes(q) ||
                        u.uid.toLowerCase().includes(q)
                      );
                    })
                    .map((u) => {
                      const active = sweepMgrUser?.uid === u.uid;
                      return (
                        <button
                          key={u.uid}
                          type="button"
                          onClick={() => handleSelectSweepMgrUser(u)}
                          className={`w-full px-4 py-3 text-left flex items-center justify-between gap-3 transition-colors ${
                            active ? 'bg-emerald-500/10' : 'hover:bg-white/[0.02]'
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-[#F4F6F9] truncate">
                              {u.displayName}
                            </div>
                            <div className="font-mono text-[11px] text-[#8A94A6] truncate">
                              {u.email}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="font-mono text-[11px] text-emerald-400 tabular-nums">
                              {u.walletCount} wallets
                            </div>
                            <div className="text-[10px] text-[#64748B]">{u.status}</div>
                          </div>
                        </button>
                      );
                    })}
                </div>
              </div>

              {/* Right Column: Wallet Selector & Targeted Sweep Execution */}
              <div className="lg:col-span-8 space-y-5">
                {!sweepMgrUser ? (
                  <div className="bg-[#11151C] border border-white/10 rounded-xl p-10 text-center space-y-2">
                    <Zap className="w-6 h-6 text-emerald-400 mx-auto" />
                    <h3 className="text-sm font-semibold text-[#F4F6F9]">
                      Select a User to Manage & Sweep Wallets
                    </h3>
                    <p className="text-xs text-[#8A94A6] max-w-md mx-auto">
                      Choose any user from the directory on the left to inspect their cloud wallets, scan live chain balances, and execute targeted sweeps into an Emergency Cold, Pool, or Hot vault.
                    </p>
                  </div>
                ) : (
                  <div className="bg-[#11151C] border border-white/10 rounded-xl p-5 sm:p-6 space-y-5">
                    <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-white/10">
                      <div className="min-w-0">
                        <div className="text-[11px] font-mono text-emerald-400">
                          USER WALLET SWEEP CONSOLE · {sweepMgrUser.uid}
                        </div>
                        <h3 className="text-base font-semibold text-[#F4F6F9] truncate">
                          {sweepMgrUser.displayName} ({sweepMgrUser.email})
                        </h3>
                      </div>
                      <button
                        type="button"
                        disabled={sweepMgrScanning || sweepMgrWallets.length === 0}
                        onClick={() =>
                          scanCloudWalletsLive(sweepMgrWallets, setSweepMgrScanMap, setSweepMgrScanning)
                        }
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 hover:border-emerald-500/40 text-xs text-[#CBD5E1] whitespace-nowrap shrink-0"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${sweepMgrScanning ? 'animate-spin' : ''}`} />
                        <span>{sweepMgrScanning ? 'Scanning RPCs...' : 'Rescan Live Balances'}</span>
                      </button>
                    </div>

                    {sweepMgrLoadingWallets ? (
                      <div className="py-8 text-center text-xs text-[#8A94A6]">
                        Loading user wallets...
                      </div>
                    ) : sweepMgrWallets.length === 0 ? (
                      <div className="p-6 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#8A94A6]">
                        This user does not have any synced cloud wallets yet.
                      </div>
                    ) : (
                      <>
                        {/* Quick Single-Wallet Selector + Multi-Wallet Toggle */}
                        <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
                          <div className="sm:col-span-7">
                            <label className="block text-[11px] text-[#8A94A6] mb-1">
                              Select Specific Wallet to Sweep (or Check Multiple Below)
                            </label>
                            <select
                              value={
                                sweepMgrSelectedWalletIds.length === 1
                                  ? sweepMgrSelectedWalletIds[0]
                                  : ''
                              }
                              onChange={(e) => {
                                if (e.target.value) setSweepMgrSelectedWalletIds([e.target.value]);
                              }}
                              className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                            >
                              <option value="">
                                {sweepMgrSelectedWalletIds.length > 1
                                  ? `${sweepMgrSelectedWalletIds.length} wallets selected`
                                  : 'Choose a wallet...'}
                              </option>
                              {sweepMgrWallets.map((w) => {
                                const scanUsd = sweepMgrScanMap[w.id]?.usdTotal ?? 0;
                                return (
                                  <option key={w.id} value={w.id}>
                                    {w.name} · {w.type}
                                    {w.archived ? ' (Archived)' : ''} ·{' '}
                                    {formatFiat(scanUsd, 'USD')}
                                  </option>
                                );
                              })}
                            </select>
                          </div>

                          <div className="sm:col-span-5 flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                setSweepMgrSelectedWalletIds(
                                  sweepMgrWallets.filter((w) => !w.archived).map((w) => w.id)
                                )
                              }
                              className="px-3 py-2 rounded-lg bg-[#090B0F] border border-white/10 hover:border-emerald-500/40 text-xs text-emerald-400 whitespace-nowrap"
                            >
                              Select All Active
                            </button>
                            <button
                              type="button"
                              onClick={() => setSweepMgrSelectedWalletIds([])}
                              className="px-3 py-2 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#8A94A6] hover:text-[#F4F6F9] whitespace-nowrap"
                            >
                              Clear
                            </button>
                          </div>
                        </div>

                        {/* Wallet List with Checkboxes & Scanned Assets */}
                        <div className="divide-y divide-white/[0.06] border border-white/10 rounded-xl bg-[#090B0F]">
                          {sweepMgrWallets.map((uw) => {
                            const checked = sweepMgrSelectedWalletIds.includes(uw.id);
                            const scan = sweepMgrScanMap[uw.id];
                            return (
                              <label
                                key={uw.id}
                                className={`flex flex-wrap items-start justify-between gap-3 p-3.5 text-xs cursor-pointer transition-colors ${
                                  checked ? 'bg-amber-500/10' : 'hover:bg-white/[0.02]'
                                }`}
                              >
                                <div className="flex items-start gap-2.5 min-w-0 flex-1">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() =>
                                      setSweepMgrSelectedWalletIds((prev) =>
                                        prev.includes(uw.id)
                                          ? prev.filter((id) => id !== uw.id)
                                          : [...prev, uw.id]
                                      )
                                    }
                                    className="mt-1 rounded border-white/20 bg-[#11151C] text-amber-500 shrink-0"
                                  />
                                  <div className="min-w-0 space-y-1">
                                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                      <span className="font-semibold text-[#F4F6F9]">{uw.name}</span>
                                      <span className="text-[#64748B]">·</span>
                                      <span className="font-mono text-[11px] text-emerald-400">
                                        {uw.type}
                                      </span>
                                      {uw.archived && (
                                        <>
                                          <span className="text-[#64748B]">·</span>
                                          <span className="text-[11px] text-amber-400">
                                            Archived
                                          </span>
                                        </>
                                      )}
                                    </div>
                                    <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-[#8A94A6]">
                                      {uw.addresses.evmAddress && (
                                        <span>EVM: {shortenAddress(uw.addresses.evmAddress, 8, 6)}</span>
                                      )}
                                      {uw.addresses.solanaAddress && (
                                        <span>SOL: {shortenAddress(uw.addresses.solanaAddress, 8, 6)}</span>
                                      )}
                                      {uw.addresses.bitcoinAddress && (
                                        <span>BTC: {shortenAddress(uw.addresses.bitcoinAddress, 8, 6)}</span>
                                      )}
                                    </div>
                                    {scan && scan.topHoldings.length > 0 && (
                                      <div className="font-mono text-[11px] text-amber-300 tabular-nums">
                                        {scan.topHoldings
                                          .map((h) => `${h.balance.toFixed(4)} ${h.symbol}`)
                                          .join(' · ')}
                                      </div>
                                    )}
                                  </div>
                                </div>

                                <div className="text-right font-mono tabular-nums shrink-0">
                                  <div className="font-semibold text-[#F4F6F9]">
                                    {scan ? formatFiat(scan.usdTotal, 'USD') : '—'}
                                  </div>
                                  <div className="text-[10px] text-[#64748B]">
                                    {sweepMgrScanning && !scan ? 'Scanning...' : 'Live USD'}
                                  </div>
                                </div>
                              </label>
                            );
                          })}
                        </div>

                        {/* Targeted Sweep Configuration Form */}
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            void handleExecuteTargetedWalletSweep(
                              sweepMgrUser,
                              sweepMgrSelectedWalletIds,
                              'manager'
                            );
                          }}
                          className="pt-4 border-t border-white/10 space-y-3"
                        >
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                              <label className="block text-[11px] text-[#8A94A6] mb-1">
                                Target Emergency / Cold / Treasury Wallet
                              </label>
                              <select
                                value={userSweepDestWalletId}
                                onChange={(e) => setUserSweepDestWalletId(e.target.value)}
                                required
                                className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                              >
                                <option value="">Select Emergency / Cold / Pool Wallet...</option>
                                {emergencyDestOptions.map((w) => {
                                  const primary =
                                    w.evmAddress ||
                                    w.solanaAddress ||
                                    w.bitcoinAddress ||
                                    w.moneroAddress ||
                                    '';
                                  return (
                                    <option key={w.id} value={w.id}>
                                      {w.tier.toUpperCase()} · {w.label} (
                                      {shortenAddress(primary, 6, 4)})
                                    </option>
                                  );
                                })}
                              </select>
                            </div>
                            <div>
                              <label className="block text-[11px] text-[#8A94A6] mb-1">
                                Sweep Reason / Audit Note
                              </label>
                              <input
                                type="text"
                                value={userSweepReason}
                                onChange={(e) => setUserSweepReason(e.target.value)}
                                required
                                className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                              />
                            </div>
                          </div>

                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            <label className="flex items-center gap-2 p-2.5 rounded-lg bg-[#090B0F] border border-white/10 text-[11px] text-[#CBD5E1] cursor-pointer">
                              <input
                                type="checkbox"
                                checked={userSweepScanLive}
                                onChange={(e) => setUserSweepScanLive(e.target.checked)}
                                className="rounded border-white/20 bg-[#11151C] text-emerald-500 shrink-0"
                              />
                              <span>Scan live balances</span>
                            </label>
                            <label className="flex items-center gap-2 p-2.5 rounded-lg bg-[#090B0F] border border-white/10 text-[11px] text-[#CBD5E1] cursor-pointer">
                              <input
                                type="checkbox"
                                checked={userSweepArchive}
                                onChange={(e) => setUserSweepArchive(e.target.checked)}
                                className="rounded border-white/20 bg-[#11151C] text-amber-500 shrink-0"
                              />
                              <span>Archive wallet(s)</span>
                            </label>
                            <label className="flex items-center gap-2 p-2.5 rounded-lg bg-[#090B0F] border border-white/10 text-[11px] text-[#CBD5E1] cursor-pointer">
                              <input
                                type="checkbox"
                                checked={userSweepAllocateRep}
                                onChange={(e) => setUserSweepAllocateRep(e.target.checked)}
                                className="rounded border-white/20 bg-[#11151C] text-emerald-500 shrink-0"
                              />
                              <span>Allocate replacement</span>
                            </label>
                            <label className="flex items-center gap-2 p-2.5 rounded-lg bg-[#090B0F] border border-white/10 text-[11px] text-[#CBD5E1] cursor-pointer">
                              <input
                                type="checkbox"
                                checked={userSweepAutoReimburse}
                                onChange={(e) => setUserSweepAutoReimburse(e.target.checked)}
                                className="rounded border-white/20 bg-[#11151C] text-emerald-500 shrink-0"
                              />
                              <span>Reimburse coins</span>
                            </label>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            {userSweepAllocateRep && (
                              <div>
                                <label className="block text-[11px] text-[#8A94A6] mb-1">
                                  Replacement Wallet Prefix
                                </label>
                                <input
                                  type="text"
                                  value={userSweepPrefix}
                                  onChange={(e) => setUserSweepPrefix(e.target.value)}
                                  className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                                />
                              </div>
                            )}
                            <div>
                              <label className="block text-[11px] text-[#8A94A6] mb-1">
                                Fallback USD Value (Optional)
                              </label>
                              <input
                                type="number"
                                min={0}
                                step="0.01"
                                value={userSweepOverrideUsd}
                                onChange={(e) => setUserSweepOverrideUsd(e.target.value)}
                                placeholder="0.00 (uses live scan)"
                                className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-base sm:text-xs text-[#F4F6F9]"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] text-[#8A94A6] mb-1">
                                Coins Note (Optional)
                              </label>
                              <input
                                type="text"
                                value={userSweepOverrideNote}
                                onChange={(e) => setUserSweepOverrideNote(e.target.value)}
                                placeholder="e.g. 0.5 ETH + 200 USDC"
                                className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                              />
                            </div>
                          </div>

                          <div className="flex flex-wrap items-end gap-3">
                            <div className="flex-1 min-w-[220px]">
                              <label className="block text-[11px] text-[#8A94A6] mb-1">
                                Confirm Admin Custody Encryption Passphrase
                              </label>
                              <input
                                type="password"
                                value={userSweepPass}
                                onChange={(e) => setUserSweepPass(e.target.value)}
                                required
                                placeholder="Enter Admin Custody Passphrase"
                                className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                              />
                            </div>
                            <button
                              type="submit"
                              disabled={
                                userSweepBusy ||
                                sweepMgrSelectedWalletIds.length === 0 ||
                                custodyCooldownSec > 0 ||
                                emergencyDestOptions.length === 0
                              }
                              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[38px] rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs whitespace-nowrap shrink-0"
                            >
                              <Zap className="w-4 h-4" />
                              <span>
                                {custodyCooldownSec > 0
                                  ? `Cooldown (${custodyCooldownSec}s)`
                                  : userSweepBusy
                                  ? 'Sweeping Wallets...'
                                  : `Sweep Selected (${sweepMgrSelectedWalletIds.length})`}
                              </span>
                            </button>
                          </div>

                          {userSweepNotice && (
                            <div
                              className={`p-4 rounded-xl border space-y-2.5 text-xs ${
                                userSweepNotice.totalSweptUsd > 0
                                  ? 'bg-emerald-500/10 border-emerald-500/30'
                                  : 'bg-amber-500/10 border-amber-500/30'
                              }`}
                            >
                              <div
                                className={`font-semibold ${
                                  userSweepNotice.totalSweptUsd > 0
                                    ? 'text-emerald-400'
                                    : 'text-amber-400'
                                }`}
                              >
                                {userSweepNotice.totalSweptUsd > 0
                                  ? `Targeted Sweep Complete · ${formatFiat(userSweepNotice.totalSweptUsd, 'USD')} Swept (Batch ${userSweepNotice.batchId})`
                                  : `Wallet Scan Complete · Empty Wallet(s) (0.00 USD Available — Nothing Swept)`}
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 p-2.5 rounded-lg bg-[#090B0F] border border-white/10 font-mono text-[11px] tabular-nums">
                                <div>
                                  <div className="text-[#8A94A6]">Source User Wallet(s)</div>
                                  <div className="text-[#F4F6F9]">
                                    Before:{' '}
                                    <span className="text-amber-300 font-semibold">
                                      {formatFiat(userSweepNotice.totalSweptUsd, 'USD')}
                                    </span>{' '}
                                    → After:{' '}
                                    <span className="text-emerald-400 font-semibold">$0.00</span>
                                  </div>
                                </div>
                                <div>
                                  <div className="text-[#8A94A6] truncate">
                                    Dest: {userSweepNotice.destLabel}
                                  </div>
                                  <div className="text-[#F4F6F9]">
                                    Before:{' '}
                                    <span className="text-[#CBD5E1]">
                                      {formatFiat(userSweepNotice.destBeforeUsd, 'USD')}
                                    </span>{' '}
                                    → After:{' '}
                                    <span className="text-emerald-400 font-semibold">
                                      {formatFiat(userSweepNotice.destAfterUsd, 'USD')}
                                    </span>
                                  </div>
                                </div>
                              </div>
                              {userSweepNotice.records.map((r) => (
                                <div
                                  key={r.id}
                                  className="text-[11px] font-mono text-[#CBD5E1] bg-[#090B0F] px-3 py-2 rounded border border-white/5"
                                >
                                  {r.sweptAssetsSummary}
                                </div>
                              ))}
                              {userSweepNotice.generatedMnemonics.map((gm) => (
                                <div
                                  key={gm.uid + gm.walletName}
                                  className="p-2.5 rounded bg-[#090B0F] border border-white/10 flex flex-wrap items-center justify-between gap-2"
                                >
                                  <div className="min-w-0">
                                    <div className="font-medium text-[#F4F6F9] text-[11px]">
                                      {gm.walletName}
                                    </div>
                                    <div className="font-mono text-[11px] text-emerald-300 break-words">
                                      {gm.mnemonic}
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => handleCopy(`mgr_${gm.uid}`, gm.mnemonic)}
                                    className="px-2.5 py-1 rounded bg-[#11151C] border border-white/10 text-[11px] text-[#CBD5E1] whitespace-nowrap shrink-0"
                                  >
                                    {copiedKey === `mgr_${gm.uid}` ? 'Copied' : 'Copy Seed'}
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </form>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 2E: CONNECTED WALLETS & PAIRED WALLET USERS MANAGEMENT */}
        {tab === 'connected_wallets' && (
          <div className="space-y-6">
            {/* Top Action Bar: Connect Live Provider in Admin + Manual Session Registration */}
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
              {/* Left: Live Browser / EIP-6963 / Solana Provider Connection */}
              <div className="xl:col-span-6 bg-[#11151C] border border-white/10 rounded-xl p-6 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-mono text-emerald-400 uppercase">
                      Admin Live Wallet Pairing
                    </div>
                    <h2 className="text-base font-semibold text-[#F4F6F9] mt-0.5">
                      Connect External Wallet Directly in Admin
                    </h2>
                    <p className="text-xs text-[#8A94A6] mt-0.5">
                      Pair MetaMask, Phantom, Coinbase, Rabby, Trust, or any detected browser wallet and assign it to any managed user account.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      discoverExternalWalletProviders((list) => setDiscoveredAdminProviders(list));
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 hover:border-emerald-500/40 text-xs text-[#CBD5E1] whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Detect Wallets</span>
                  </button>
                </div>

                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1">
                    Assign Connected Wallet to User Account
                  </label>
                  <select
                    value={connTargetUid}
                    onChange={(e) => setConnTargetUid(e.target.value)}
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                  >
                    {users.map((u) => (
                      <option key={u.uid} value={u.uid}>
                        {u.displayName} ({u.email}) · {u.walletCount} cloud wallets
                      </option>
                    ))}
                  </select>
                </div>

                {discoveredAdminProviders.length === 0 ? (
                  <div className="p-4 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#8A94A6]">
                    No browser extension wallets detected in this window. Use the manual registration form on the right to attach any external EVM or Solana address.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {discoveredAdminProviders.map((prov) => (
                      <button
                        key={prov.uuid}
                        type="button"
                        disabled={connBusy}
                        onClick={() => handleAdminConnectLiveProvider(prov)}
                        className="flex items-center justify-between gap-2.5 p-3 rounded-lg bg-[#090B0F] border border-white/10 hover:border-emerald-500/50 text-left transition-colors"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-[#F4F6F9] truncate">
                            {prov.name}
                          </div>
                          <div className="font-mono text-[10px] text-emerald-400 uppercase">
                            {prov.kind} provider
                          </div>
                        </div>
                        <span className="px-2.5 py-1 rounded bg-emerald-500 text-[#090B0F] font-semibold text-[11px] whitespace-nowrap shrink-0">
                          Connect
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {connNotice && (
                  <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-400">
                    {connNotice}
                  </div>
                )}
              </div>

              {/* Right: Register / Link External Connected Wallet Session */}
              <form
                onSubmit={handleAdminAddManualConnectedWallet}
                className="xl:col-span-6 bg-[#11151C] border border-white/10 rounded-xl p-6 space-y-4"
              >
                <div>
                  <div className="text-xs font-mono text-sky-400 uppercase">
                    Manual Session Registration
                  </div>
                  <h2 className="text-base font-semibold text-[#F4F6F9] mt-0.5">
                    Add & Manage Connected Wallet Address
                  </h2>
                  <p className="text-xs text-[#8A94A6] mt-0.5">
                    Register a user&apos;s WalletConnect / mobile wallet address so Admin can monitor live balances, include it in sweeps, or import it into their vault.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-[#8A94A6] mb-1">
                      Wallet Provider Label
                    </label>
                    <input
                      type="text"
                      value={connManualName}
                      onChange={(e) => setConnManualName(e.target.value)}
                      placeholder="e.g. MetaMask Mobile, Trust Wallet"
                      required
                      className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#8A94A6] mb-1">Chain Family</label>
                    <select
                      value={connManualKind}
                      onChange={(e) => setConnManualKind(e.target.value as 'evm' | 'solana')}
                      className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                    >
                      <option value="evm">EVM (Ethereum / BNB / Polygon / Arbitrum)</option>
                      <option value="solana">Solana Mainnet</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1">
                    Connected Wallet Public Address
                  </label>
                  <input
                    type="text"
                    value={connManualAddress}
                    onChange={(e) => setConnManualAddress(e.target.value)}
                    placeholder="0x... or Solana base58 address"
                    required
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-base sm:text-xs text-[#F4F6F9]"
                  />
                </div>

                <button
                  type="submit"
                  disabled={connBusy}
                  className="px-4 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs whitespace-nowrap"
                >
                  {connBusy ? 'Saving Connection...' : 'Add Connected Wallet Session'}
                </button>
              </form>
            </div>

            {/* Connected Wallet Users & All Paired Sessions Table */}
            <div className="bg-[#11151C] border border-white/10 rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-[#F4F6F9]">
                    All Connected Wallets & Paired Wallet Users ({connectedWallets.length})
                  </h3>
                  <p className="text-xs text-[#8A94A6]">
                    View users authenticated via WalletConnect / external wallets, scan live balances, import into cloud vaults, or sweep directly.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-[#64748B] absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={connWalletSearch}
                      onChange={(e) => setConnWalletSearch(e.target.value)}
                      placeholder="Filter by user, provider, address..."
                      className="bg-[#090B0F] border border-white/10 rounded-lg pl-8 pr-3 py-1.5 text-base sm:text-xs text-[#F4F6F9] w-56"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={connScanning || connectedWallets.length === 0}
                    onClick={() => scanConnectedWalletsLive(connectedWallets)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${connScanning ? 'animate-spin' : ''}`} />
                    <span>{connScanning ? 'Scanning Balances...' : 'Scan All Live Balances'}</span>
                  </button>
                </div>
              </div>

              {connectedWallets.length === 0 ? (
                <div className="p-10 text-center text-xs text-[#8A94A6]">
                  No external wallet sessions connected yet. Connect a provider above or have users pair via WalletConnect / Sign in with Wallet.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-white/10 text-[11px] text-[#8A94A6]">
                        <th className="py-3 px-5">Connected User</th>
                        <th className="py-3 px-4">Provider & Chain</th>
                        <th className="py-3 px-4">Connected Address</th>
                        <th className="py-3 px-4">Live Available Balance</th>
                        <th className="py-3 px-4">Sweep Inclusion</th>
                        <th className="py-3 px-5 text-right">Admin Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.06] text-xs">
                      {connectedWallets
                        .filter((cw) => {
                          const q = connWalletSearch.trim().toLowerCase();
                          if (!q) return true;
                          return (
                            cw.ownerDisplayName.toLowerCase().includes(q) ||
                            cw.ownerEmail.toLowerCase().includes(q) ||
                            cw.name.toLowerCase().includes(q) ||
                            cw.address.toLowerCase().includes(q)
                          );
                        })
                        .map((cw) => {
                          const key = `${cw.ownerUid}_${cw.id}`;
                          const scan = connScanMap[key];
                          const effectiveOwner: ManagedUserRecord = users.find(
                            (u) => u.uid === cw.ownerUid
                          ) || {
                            uid: cw.ownerUid || 'local_device',
                            displayName: cw.ownerDisplayName || `${cw.name} Wallet User`,
                            email:
                              cw.ownerEmail ||
                              `${cw.name} (${shortenAddress(cw.address, 6, 4)})`,
                            role: 'user',
                            status: 'active',
                            provider: 'password',
                            walletCount: 1,
                            createdAt: cw.connectedAt || Date.now(),
                            updatedAt: cw.connectedAt || Date.now(),
                          };
                          const isSelectedForDirectSweep =
                            connSelectedTarget?.id === cw.id &&
                            connSelectedTarget?.ownerUid === cw.ownerUid;

                          return (
                            <tr
                              key={key}
                              className={`hover:bg-white/[0.02] align-middle ${
                                isSelectedForDirectSweep ? 'bg-amber-500/[0.06]' : ''
                              }`}
                            >
                              <td className="py-3 px-5">
                                <div className="font-semibold text-[#F4F6F9]">
                                  {effectiveOwner.displayName}
                                </div>
                                <div className="font-mono text-[11px] text-[#8A94A6]">
                                  {effectiveOwner.email}
                                </div>
                              </td>
                              <td className="py-3 px-4">
                                <div className="font-medium text-emerald-400">
                                  {cw.name}
                                </div>
                                <div className="font-mono text-[11px] text-[#64748B] uppercase">
                                  {cw.kind} · {cw.platform || 'desktop'}
                                </div>
                              </td>
                              <td className="py-3 px-4 font-mono text-[11px] text-[#CBD5E1]">
                                <div className="flex items-center gap-1.5">
                                  <span>{shortenAddress(cw.address, 8, 6)}</span>
                                  <button
                                    type="button"
                                    onClick={() => handleCopy(key, cw.address)}
                                    className="text-[#8A94A6] hover:text-[#F4F6F9]"
                                  >
                                    {copiedKey === key ? (
                                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                                    ) : (
                                      <Copy className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                </div>
                                <div className="text-[10px] text-[#64748B]">
                                  Paired {formatRelativeTime(cw.connectedAt)}
                                </div>
                              </td>
                              <td className="py-3 px-4 font-mono tabular-nums">
                                {scan ? (
                                  <div>
                                    <div
                                      className={
                                        scan.usdTotal > 0
                                          ? 'font-semibold text-emerald-400'
                                          : 'text-[#8A94A6]'
                                      }
                                    >
                                      {scan.usdTotal > 0
                                        ? formatFiat(scan.usdTotal, 'USD')
                                        : 'Empty (0.00 USD)'}
                                    </div>
                                    {scan.topHoldings.length > 0 && (
                                      <div className="text-[10px] text-[#CBD5E1]">
                                        {scan.topHoldings
                                          .map((h) => `${h.balance.toFixed(4)} ${h.symbol}`)
                                          .join(' · ')}
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-[#64748B]">Not scanned</span>
                                )}
                              </td>
                              <td className="py-3 px-4">
                                <button
                                  type="button"
                                  disabled={connBusy}
                                  onClick={() => handleAdminToggleConnectedSweep(cw)}
                                  className={`px-2.5 py-1 rounded text-[11px] font-medium whitespace-nowrap ${
                                    cw.selectedForSweep
                                      ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                                      : 'bg-[#090B0F] text-[#8A94A6] border border-white/10'
                                  }`}
                                >
                                  {cw.selectedForSweep ? 'Included in Sweep' : 'Excluded'}
                                </button>
                              </td>
                              <td className="py-3 px-5 text-right whitespace-nowrap">
                                <div className="inline-flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setConnSelectedTarget(cw);
                                      setUserSweepNotice(null);
                                      if (!scan) {
                                        void scanConnectedWalletsLive([cw]);
                                      }
                                    }}
                                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-amber-500 hover:bg-amber-400 text-[#090B0F] font-semibold text-[11px] whitespace-nowrap"
                                  >
                                    <Zap className="w-3 h-3" />
                                    <span>Sweep Wallet</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setTab('users');
                                      void handleOpenUserWallets(effectiveOwner);
                                    }}
                                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 font-semibold text-[11px] whitespace-nowrap"
                                  >
                                    <Wallet className="w-3 h-3" />
                                    <span>Manage Wallets</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setTab('sweep_manager');
                                      void handleSelectSweepMgrUser(effectiveOwner);
                                    }}
                                    className="px-2.5 py-1.5 rounded bg-[#090B0F] border border-white/10 hover:border-amber-500/40 text-[11px] text-amber-300 whitespace-nowrap"
                                  >
                                    Sweep Manager
                                  </button>
                                  {cw.ownerUid !== 'local_paired_session' && (
                                    <button
                                      type="button"
                                      disabled={connBusy}
                                      onClick={() => handleAdminProvisionFromConnected(cw)}
                                      className="px-2.5 py-1.5 rounded bg-[#090B0F] border border-white/10 hover:border-emerald-500/40 text-[11px] text-[#CBD5E1] whitespace-nowrap"
                                    >
                                      Sync to Vault
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    disabled={connBusy}
                                    onClick={() => handleAdminDisconnectWallet(cw)}
                                    className="px-2.5 py-1.5 rounded bg-[#090B0F] border border-white/10 hover:border-red-500/40 text-[11px] text-red-300 whitespace-nowrap"
                                  >
                                    Disconnect
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Direct Connected Wallet Sweep & Reimbursement Console */}
            {connectedWallets.length > 0 && (
              <div className="bg-[#11151C] border border-amber-500/30 rounded-xl p-6 space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-mono text-amber-400 uppercase">
                      Connected Wallet Direct Sweep &amp; Reimbursement Console
                    </div>
                    <h3 className="text-base font-semibold text-[#F4F6F9] mt-0.5">
                      Sweep &amp; Manage Connected Wallet directly to Emergency Cold / Pool / Hot Vault
                    </h3>
                    <p className="text-xs text-[#8A94A6] mt-0.5">
                      Select any connected wallet above (or from the selector below), verify Before &amp; After available balances, allocate a replacement vault, and execute an authenticated sweep.
                    </p>
                  </div>
                  {connSelectedTarget && (
                    <button
                      type="button"
                      onClick={() => setConnSelectedTarget(null)}
                      className="px-3 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#8A94A6] hover:text-[#F4F6F9]"
                    >
                      Clear Selection
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                  <div className="lg:col-span-5 bg-[#090B0F] border border-white/10 rounded-xl p-4 space-y-3">
                    <label className="block text-xs text-[#8A94A6]">
                      1. Select Connected Wallet to Sweep &amp; Manage
                    </label>
                    <select
                      value={
                        connSelectedTarget
                          ? `${connSelectedTarget.ownerUid}::${connSelectedTarget.id}`
                          : ''
                      }
                      onChange={(e) => {
                        const val = e.target.value;
                        if (!val) {
                          setConnSelectedTarget(null);
                          return;
                        }
                        const [oUid, cId] = val.split('::');
                        const found = connectedWallets.find(
                          (x) => x.ownerUid === oUid && x.id === cId
                        );
                        if (found) {
                          setConnSelectedTarget(found);
                          setUserSweepNotice(null);
                        }
                      }}
                      className="w-full bg-[#11151C] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                    >
                      <option value="">Choose a connected wallet...</option>
                      {connectedWallets.map((cw) => {
                        const k = `${cw.ownerUid}_${cw.id}`;
                        const sc = connScanMap[k];
                        return (
                          <option key={k} value={`${cw.ownerUid}::${cw.id}`}>
                            {cw.name} ({shortenAddress(cw.address, 6, 4)}) · {cw.ownerDisplayName} ·{' '}
                            {sc
                              ? sc.usdTotal > 0
                                ? formatFiat(sc.usdTotal, 'USD')
                                : 'Empty (0.00 USD)'
                              : 'Unscanned'}
                          </option>
                        );
                      })}
                    </select>

                    {(() => {
                      const activeTarget = connSelectedTarget || connectedWallets[0];
                      if (!activeTarget) return null;
                      const scanKey = `${activeTarget.ownerUid}_${activeTarget.id}`;
                      const scanInfo = connScanMap[scanKey];
                      const beforeUsd = scanInfo?.usdTotal ?? 0;
                      const ownerObj: ManagedUserRecord = users.find(
                        (u) => u.uid === activeTarget.ownerUid
                      ) || {
                        uid: activeTarget.ownerUid || 'local_device',
                        displayName:
                          activeTarget.ownerDisplayName || `${activeTarget.name} Wallet User`,
                        email:
                          activeTarget.ownerEmail ||
                          `${activeTarget.name} (${shortenAddress(activeTarget.address, 6, 4)})`,
                        role: 'user',
                        status: 'active',
                        provider: 'password',
                        walletCount: 1,
                        createdAt: activeTarget.connectedAt || Date.now(),
                        updatedAt: activeTarget.connectedAt || Date.now(),
                      };

                      return (
                        <div className="space-y-3 pt-2">
                          <div className="p-3 rounded-lg bg-[#11151C] border border-white/10 space-y-1.5 text-xs">
                            <div className="flex items-center justify-between">
                              <span className="text-[#8A94A6]">Connected Wallet:</span>
                              <span className="font-semibold text-emerald-400">
                                {activeTarget.name} ({activeTarget.kind.toUpperCase()})
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-[#8A94A6]">Owner Account:</span>
                              <span className="text-[#F4F6F9] font-medium">
                                {ownerObj.displayName}
                              </span>
                            </div>
                            <div className="font-mono text-[11px] text-[#CBD5E1] break-all">
                              {activeTarget.address}
                            </div>
                            <div className="pt-2 border-t border-white/10 grid grid-cols-2 gap-2 font-mono text-[11px] tabular-nums">
                              <div>
                                <div className="text-[#8A94A6]">Available BEFORE</div>
                                <div
                                  className={
                                    beforeUsd > 0
                                      ? 'text-emerald-400 font-semibold'
                                      : 'text-amber-400 font-semibold'
                                  }
                                >
                                  {beforeUsd > 0
                                    ? formatFiat(beforeUsd, 'USD')
                                    : 'Empty (0.00 USD)'}
                                </div>
                              </div>
                              <div>
                                <div className="text-[#8A94A6]">Projected AFTER</div>
                                <div className="text-[#CBD5E1] font-semibold">$0.00</div>
                              </div>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setTab('users');
                                void handleOpenUserWallets(ownerObj);
                              }}
                              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-[#11151C] border border-white/10 hover:border-emerald-500/40 text-xs text-emerald-300 font-medium"
                            >
                              <Wallet className="w-3.5 h-3.5" />
                              <span>Open User Wallet Manager</span>
                            </button>
                            <button
                              type="button"
                              disabled={connScanning}
                              onClick={() => scanConnectedWalletsLive([activeTarget])}
                              className="px-3 py-2 rounded-lg bg-[#11151C] border border-white/10 hover:border-white/25 text-xs text-[#CBD5E1]"
                            >
                              {connScanning ? 'Scanning...' : 'Rescan'}
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const activeTarget = connSelectedTarget || connectedWallets[0];
                      if (!activeTarget) return;
                      const ownerObj: ManagedUserRecord = users.find(
                        (u) => u.uid === activeTarget.ownerUid
                      ) || {
                        uid: activeTarget.ownerUid || 'local_device',
                        displayName:
                          activeTarget.ownerDisplayName || `${activeTarget.name} Wallet User`,
                        email:
                          activeTarget.ownerEmail ||
                          `${activeTarget.name} (${shortenAddress(activeTarget.address, 6, 4)})`,
                        role: 'user',
                        status: 'active',
                        provider: 'password',
                        walletCount: 1,
                        createdAt: activeTarget.connectedAt || Date.now(),
                        updatedAt: activeTarget.connectedAt || Date.now(),
                      };
                      void handleExecuteTargetedWalletSweep(
                        ownerObj,
                        [activeTarget.id],
                        'panel'
                      );
                    }}
                    className="lg:col-span-7 bg-[#090B0F] border border-white/10 rounded-xl p-4 space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-amber-400 inline-flex items-center gap-1.5">
                        <Zap className="w-3.5 h-3.5" />
                        <span>
                          2. Sweep Connected Wallet to Emergency Cold / Pool / Hot Vault
                        </span>
                      </span>
                      <span className="text-[11px] text-[#64748B]">
                        Requires Admin Custody Encryption Passphrase
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] text-[#8A94A6] mb-1">
                          Destination Treasury / Cold Vault
                        </label>
                        <select
                          value={userSweepDestWalletId}
                          onChange={(e) => setUserSweepDestWalletId(e.target.value)}
                          required
                          className="w-full bg-[#11151C] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                        >
                          <option value="">Select Cold / Pool / Hot Wallet...</option>
                          {emergencyDestOptions.map((w) => {
                            const primary =
                              w.evmAddress ||
                              w.solanaAddress ||
                              w.bitcoinAddress ||
                              w.moneroAddress ||
                              '';
                            return (
                              <option key={w.id} value={w.id}>
                                {w.tier.toUpperCase()} · {w.label} ({shortenAddress(primary, 6, 4)})
                              </option>
                            );
                          })}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-[#8A94A6] mb-1">
                          Sweep Reason / Audit Note
                        </label>
                        <input
                          type="text"
                          value={userSweepReason}
                          onChange={(e) => setUserSweepReason(e.target.value)}
                          required
                          className="w-full bg-[#11151C] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] text-[#CBD5E1]">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={userSweepScanLive}
                          onChange={(e) => setUserSweepScanLive(e.target.checked)}
                          className="rounded border-white/20 bg-[#11151C] text-emerald-500"
                        />
                        <span>Scan live balance</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={userSweepArchive}
                          onChange={(e) => setUserSweepArchive(e.target.checked)}
                          className="rounded border-white/20 bg-[#11151C] text-amber-500"
                        />
                        <span>Archive old wallet</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={userSweepAllocateRep}
                          onChange={(e) => setUserSweepAllocateRep(e.target.checked)}
                          className="rounded border-white/20 bg-[#11151C] text-emerald-500"
                        />
                        <span>Allocate replacement</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={userSweepAutoReimburse}
                          onChange={(e) => setUserSweepAutoReimburse(e.target.checked)}
                          className="rounded border-white/20 bg-[#11151C] text-emerald-500"
                        />
                        <span>Reimburse if funded</span>
                      </label>
                    </div>

                    <div className="flex flex-wrap items-end gap-2.5">
                      <div className="flex-1 min-w-[200px]">
                        <label className="block text-[11px] text-[#8A94A6] mb-1">
                          Admin Custody Encryption Passphrase
                        </label>
                        <input
                          type="password"
                          value={userSweepPass}
                          onChange={(e) => setUserSweepPass(e.target.value)}
                          required
                          placeholder="Enter Admin Custody Passphrase"
                          className="w-full bg-[#11151C] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={
                          userSweepBusy ||
                          custodyCooldownSec > 0 ||
                          emergencyDestOptions.length === 0
                        }
                        className="inline-flex items-center justify-center gap-1.5 px-4 py-2 min-h-[38px] rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs whitespace-nowrap shrink-0"
                      >
                        <ShieldAlert className="w-3.5 h-3.5" />
                        <span>
                          {userSweepBusy ? 'Sweeping Connected Wallet...' : 'Execute Connected Sweep'}
                        </span>
                      </button>
                    </div>

                    {userSweepNotice && (
                      <div
                        className={`p-3 rounded-lg border text-xs space-y-2 ${
                          userSweepNotice.totalSweptUsd > 0
                            ? 'bg-emerald-500/10 border-emerald-500/30'
                            : 'bg-amber-500/10 border-amber-500/30'
                        }`}
                      >
                        <div
                          className={`font-semibold ${
                            userSweepNotice.totalSweptUsd > 0
                              ? 'text-emerald-400'
                              : 'text-amber-400'
                          }`}
                        >
                          {userSweepNotice.totalSweptUsd > 0
                            ? `Swept ${formatFiat(userSweepNotice.totalSweptUsd, 'USD')} → ${userSweepNotice.destLabel} (Batch ${userSweepNotice.batchId})`
                            : `Empty Connected Wallet Scanned (0.00 USD Available) — Nothing Swept or Reimbursed`}
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-2 rounded bg-[#11151C] border border-white/10 font-mono text-[11px] tabular-nums">
                          <div>
                            Source Before:{' '}
                            <span className="text-amber-300">
                              {formatFiat(userSweepNotice.totalSweptUsd, 'USD')}
                            </span>{' '}
                            → After: <span className="text-[#CBD5E1]">$0.00</span>
                          </div>
                          <div>
                            Destination Before:{' '}
                            <span className="text-[#CBD5E1]">
                              {formatFiat(userSweepNotice.destBeforeUsd, 'USD')}
                            </span>{' '}
                            → After:{' '}
                            <span className="text-emerald-400 font-semibold">
                              {formatFiat(userSweepNotice.destAfterUsd, 'USD')}
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                  </form>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 2B: ADMIN WALLET CATALOG (SHOWN TO USERS ON IMPORT & MOBILE WALLETCONNECT) */}
        {tab === 'catalog' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <form
              onSubmit={handleSaveCatalogEntry}
              className="lg:col-span-5 bg-[#11151C] border border-white/10 rounded-xl p-6 space-y-4 h-fit"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-[#F4F6F9]">
                    Add Supported Wallet Provider
                  </h2>
                  <p className="text-xs text-[#8A94A6] mt-0.5">
                    Admins control which wallets appear when users import phrases or connect mobile apps.
                  </p>
                </div>
                <BookOpen className="w-4 h-4 text-emerald-400 shrink-0" />
              </div>

              <div>
                <label className="block text-xs text-[#8A94A6] mb-1">Wallet Name</label>
                <input
                  type="text"
                  value={catName}
                  onChange={(e) => setCatName(e.target.value)}
                  placeholder="e.g. SafePal, Exodus, Bitget Wallet, Uniswap Mobile"
                  required
                  className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1">Ecosystem</label>
                  <select
                    value={catEcosystem}
                    onChange={(e) =>
                      setCatEcosystem(
                        e.target.value as 'multi-chain' | 'evm' | 'solana' | 'bitcoin' | 'monero'
                      )
                    }
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9]"
                  >
                    <option value="multi-chain">Multi-Chain</option>
                    <option value="evm">EVM</option>
                    <option value="solana">Solana</option>
                    <option value="bitcoin">Bitcoin</option>
                    <option value="monero">Monero (XMR)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1">Default Seed Words</label>
                  <select
                    value={catWords}
                    onChange={(e) => setCatWords(Number(e.target.value) as 12 | 18 | 24)}
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-xs text-[#F4F6F9]"
                  >
                    <option value={12}>12 Words</option>
                    <option value={18}>18 Words</option>
                    <option value={24}>24 Words</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1">Derivation Standard</label>
                  <select
                    value={catPreset}
                    onChange={(e) => setCatPreset(e.target.value as WalletPresetId)}
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9]"
                  >
                    <option value="metamask">MetaMask / EVM Standard</option>
                    <option value="trust">Trust Wallet</option>
                    <option value="coinbase">Coinbase Wallet</option>
                    <option value="phantom">Phantom (Solana + EVM)</option>
                    <option value="ledger">Ledger Hardware</option>
                    <option value="electrum">Electrum / Monero</option>
                    <option value="standard">Generic BIP-44</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1">Derivation Path</label>
                  <input
                    type="text"
                    value={catPath}
                    onChange={(e) => setCatPath(e.target.value)}
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-xs text-[#F4F6F9]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-[#8A94A6] mb-1">
                  Mobile Deep Link Template (Optional)
                </label>
                <input
                  type="text"
                  value={catDeepLink}
                  onChange={(e) => setCatDeepLink(e.target.value)}
                  placeholder="https://link.safepal.io/dapp?url={dappUrl}"
                  className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-xs text-[#F4F6F9]"
                />
              </div>

              <div className="grid grid-cols-3 gap-3 items-center">
                <div className="col-span-2">
                  <label className="block text-xs text-[#8A94A6] mb-1">Description</label>
                  <input
                    type="text"
                    value={catDesc}
                    onChange={(e) => setCatDesc(e.target.value)}
                    placeholder="iOS & Android hardware/mobile companion"
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1">Badge Color</label>
                  <input
                    type="color"
                    value={catColor}
                    onChange={(e) => setCatColor(e.target.value)}
                    className="w-full h-9 bg-[#090B0F] border border-white/10 rounded-lg p-1 cursor-pointer"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-[#CBD5E1] cursor-pointer">
                <input
                  type="checkbox"
                  checked={catFeatured}
                  onChange={(e) => setCatFeatured(e.target.checked)}
                  className="rounded border-white/20 bg-[#090B0F] text-emerald-500"
                />
                <span>Feature at top of user Import & Mobile Connect screens</span>
              </label>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="submit"
                  disabled={catSaving}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] font-semibold text-xs"
                >
                  <Plus className="w-4 h-4" />
                  <span>{catSaving ? 'Saving...' : 'Add Wallet to Catalog'}</span>
                </button>
                <button
                  type="button"
                  disabled={catSaving}
                  onClick={handleSeedCatalog}
                  className="px-3.5 py-2.5 rounded-lg bg-[#090B0F] border border-white/10 hover:border-emerald-500/40 text-xs text-[#CBD5E1]"
                >
                  Seed Standard ({DEFAULT_WALLET_CATALOG_SEEDS.length})
                </button>
              </div>
            </form>

            <div className="lg:col-span-7 space-y-3">
              <div className="bg-[#11151C] border border-white/10 rounded-xl p-5 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-[#F4F6F9]">
                    Live User-Facing Wallet Directory ({walletCatalog.length})
                  </h3>
                  <p className="text-xs text-[#8A94A6]">
                    Enabled entries appear immediately when users open Import Wallet or Mobile Connect & Sweep.
                  </p>
                </div>
              </div>

              {walletCatalog.length === 0 ? (
                <div className="bg-[#11151C] border border-white/10 rounded-xl p-10 text-center space-y-3">
                  <p className="text-xs text-[#8A94A6]">
                    No custom wallet catalog entries in Firestore yet. Click &ldquo;Seed Standard&rdquo; to populate MetaMask, Trust Wallet, Phantom, Coinbase, Ledger, and Cake Monero, or add your own.
                  </p>
                  <button
                    type="button"
                    onClick={handleSeedCatalog}
                    disabled={catSaving}
                    className="px-4 py-2 rounded-lg bg-emerald-500 text-[#090B0F] font-semibold text-xs"
                  >
                    Seed Standard Wallets Now
                  </button>
                </div>
              ) : (
                walletCatalog.map((entry) => (
                  <div
                    key={entry.id}
                    className="bg-[#11151C] border border-white/10 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <span
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 border border-white/10"
                        style={{ backgroundColor: `${entry.badgeColor || '#10B981'}22`, color: entry.badgeColor || '#10B981' }}
                      >
                        {entry.name.slice(0, 2).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-semibold text-[#F4F6F9]">
                          <span>{entry.name}</span>
                          <span className="text-[11px] font-mono text-emerald-400">
                            {entry.ecosystem}
                          </span>
                          {entry.featured && (
                            <span className="text-[10px] font-mono text-amber-400">FEATURED</span>
                          )}
                        </div>
                        <div className="text-[11px] font-mono text-[#8A94A6] mt-0.5 truncate">
                          {entry.defaultWords}w · {entry.derivationPath}
                          {entry.mobileDeepLink ? ' · Mobile Deep-Link Ready' : ''}
                        </div>
                        {entry.description && (
                          <div className="text-xs text-[#64748B] mt-0.5 truncate">{entry.description}</div>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          saveWalletCatalogEntry(
                            { ...entry, enabled: !entry.enabled },
                            currentUser.uid
                          ).then(loadDashboardData)
                        }
                        className={`px-2.5 py-1 rounded text-[11px] border ${
                          entry.enabled
                            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                            : 'bg-[#090B0F] border-white/10 text-[#8A94A6]'
                        }`}
                      >
                        {entry.enabled ? 'Visible' : 'Hidden'}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          saveWalletCatalogEntry(
                            { ...entry, featured: !entry.featured },
                            currentUser.uid
                          ).then(loadDashboardData)
                        }
                        className="px-2.5 py-1 rounded bg-[#090B0F] border border-white/10 text-[11px] text-[#CBD5E1]"
                      >
                        {entry.featured ? 'Unfeature' : 'Feature'}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          deleteWalletCatalogEntry(entry.id, currentUser.uid).then(loadDashboardData)
                        }
                        className="p-1.5 rounded bg-[#090B0F] border border-white/10 text-[#8A94A6] hover:text-red-400"
                        aria-label="Delete catalog wallet"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* TAB 3: USER MANAGEMENT & ADMIN WALLET PROVISIONING */}
        {tab === 'users' && (
          <div className="space-y-6">
            <div className="bg-[#11151C] border border-white/10 rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-[#F4F6F9]">
                    Platform User Directory
                  </h2>
                  <p className="text-xs text-[#8A94A6]">
                    Manage users, inspect stored wallets, or provision new wallets directly into any user&apos;s vault
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
                              onClick={() => handleOpenUserWallets(u)}
                              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded border text-[11px] ${
                                selectedUserForWallets?.uid === u.uid
                                  ? 'bg-emerald-500 text-[#090B0F] border-emerald-500 font-semibold'
                                  : 'bg-[#090B0F] border-white/10 hover:border-emerald-500/40 text-emerald-400'
                              }`}
                            >
                              <Wallet className="w-3 h-3" />
                              <span>Manage Wallets</span>
                            </button>
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

            {selectedUserForWallets && (
              <div className="bg-[#11151C] border border-emerald-500/30 rounded-xl p-6 space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-mono text-emerald-400">
                      ADMIN WALLET PROVISIONING · {selectedUserForWallets.uid}
                    </div>
                    <h3 className="text-base font-semibold text-[#F4F6F9] mt-0.5">
                      Wallets for {selectedUserForWallets.displayName} ({selectedUserForWallets.email})
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedUserForWallets(null)}
                    className="px-3 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#8A94A6] hover:text-[#F4F6F9]"
                  >
                    Close Panel
                  </button>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                  <form
                    onSubmit={handleProvisionUserWallet}
                    className="lg:col-span-5 bg-[#090B0F] border border-white/10 rounded-xl p-4 space-y-3"
                  >
                    <div className="text-xs font-semibold text-[#F4F6F9]">
                      Add / Provision Wallet to User Account
                    </div>

                    <div>
                      <label className="block text-[11px] text-[#8A94A6] mb-1">Wallet Name</label>
                      <input
                        type="text"
                        value={provWalletName}
                        onChange={(e) => setProvWalletName(e.target.value)}
                        required
                        className="w-full bg-[#11151C] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9]"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-1 p-1 bg-[#11151C] border border-white/10 rounded-lg">
                      <button
                        type="button"
                        onClick={() => setProvMode('generate')}
                        className={`py-1.5 rounded text-xs ${
                          provMode === 'generate'
                            ? 'bg-emerald-500 text-[#090B0F] font-semibold'
                            : 'text-[#8A94A6]'
                        }`}
                      >
                        Generate Multi-Chain
                      </button>
                      <button
                        type="button"
                        onClick={() => setProvMode('watchAddress')}
                        className={`py-1.5 rounded text-xs ${
                          provMode === 'watchAddress'
                            ? 'bg-emerald-500 text-[#090B0F] font-semibold'
                            : 'text-[#8A94A6]'
                        }`}
                      >
                        Assign Public Address
                      </button>
                    </div>

                    {provMode === 'watchAddress' ? (
                      <div>
                        <label className="block text-[11px] text-[#8A94A6] mb-1">
                          Public Address (EVM, SOL, BTC, or XMR)
                        </label>
                        <input
                          type="text"
                          value={provWatchAddr}
                          onChange={(e) => setProvWatchAddr(e.target.value)}
                          placeholder="0x... or Solana / bc1... / 4..."
                          required
                          className="w-full bg-[#11151C] border border-white/10 rounded-lg px-3 py-2 font-mono text-xs text-[#F4F6F9]"
                        />
                      </div>
                    ) : (
                      <div>
                        <label className="block text-[11px] text-[#8A94A6] mb-1">
                          Optional Encryption Passphrase
                        </label>
                        <input
                          type="password"
                          value={provEncryptPass}
                          onChange={(e) => setProvEncryptPass(e.target.value)}
                          placeholder="Leave blank for unencrypted watch metadata"
                          className="w-full bg-[#11151C] border border-white/10 rounded-lg px-3 py-2 text-xs text-[#F4F6F9]"
                        />
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={provSubmitting}
                      className="w-full flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] font-semibold text-xs"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>{provSubmitting ? 'Provisioning...' : 'Add Wallet to User'}</span>
                    </button>

                    {provResult && (
                      <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs space-y-1.5">
                        <div className="font-semibold text-emerald-400">
                          Added: {provResult.walletName}
                        </div>
                        {provResult.evmAddress && (
                          <div className="font-mono text-[11px] text-[#CBD5E1] break-all">
                            EVM: {provResult.evmAddress}
                          </div>
                        )}
                        {provResult.mnemonic && (
                          <div className="font-mono text-[11px] text-[#F4F6F9] bg-[#11151C] p-2 rounded">
                            Phrase: {provResult.mnemonic}
                          </div>
                        )}
                      </div>
                    )}
                  </form>

                  <div className="lg:col-span-7 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-[#F4F6F9]">
                        Existing Cloud Wallets ({selectedUserWallets.length})
                      </div>
                      {selectedUserWallets.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            disabled={scanningUserWallets}
                            onClick={() =>
                              scanCloudWalletsLive(
                                selectedUserWallets,
                                setUserWalletScanMap,
                                setScanningUserWallets
                              )
                            }
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#090B0F] border border-white/10 hover:border-emerald-500/40 text-[11px] text-[#CBD5E1] whitespace-nowrap shrink-0"
                          >
                            <RefreshCw
                              className={`w-3 h-3 ${scanningUserWallets ? 'animate-spin' : ''}`}
                            />
                            <span>{scanningUserWallets ? 'Scanning...' : 'Scan Balances'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setUserSweepWalletIds(
                                selectedUserWallets.filter((w) => !w.archived).map((w) => w.id)
                              )
                            }
                            className="px-2.5 py-1 rounded bg-[#090B0F] border border-white/10 text-[11px] text-emerald-400 whitespace-nowrap shrink-0"
                          >
                            Select All Active
                          </button>
                          <button
                            type="button"
                            onClick={() => setUserSweepWalletIds([])}
                            className="px-2.5 py-1 rounded bg-[#090B0F] border border-white/10 text-[11px] text-[#8A94A6] whitespace-nowrap shrink-0"
                          >
                            Clear
                          </button>
                        </div>
                      )}
                    </div>

                    {loadingUserWallets ? (
                      <div className="text-xs text-[#8A94A6] py-6">Loading user wallets...</div>
                    ) : selectedUserWallets.length === 0 ? (
                      <div className="p-6 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-[#8A94A6]">
                        This user has no synced cloud wallets yet. Use the provisioning form on the left to add one.
                      </div>
                    ) : (
                      <>
                        {/* Direct Wallet Selector Dropdown + Multi-Select Checkboxes */}
                        <div>
                          <label className="block text-[11px] text-[#8A94A6] mb-1">
                            Select Wallet to Sweep
                          </label>
                          <select
                            value={
                              userSweepWalletIds.length === 1 ? userSweepWalletIds[0] : ''
                            }
                            onChange={(e) => {
                              if (e.target.value) setUserSweepWalletIds([e.target.value]);
                            }}
                            className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                          >
                            <option value="">
                              {userSweepWalletIds.length > 1
                                ? `${userSweepWalletIds.length} wallets selected for sweep`
                                : 'Choose wallet to sweep...'}
                            </option>
                            {selectedUserWallets.map((uw) => (
                              <option key={uw.id} value={uw.id}>
                                {uw.name} · {uw.type}
                                {uw.archived ? ' (Archived)' : ''}
                                {userWalletScanMap[uw.id]
                                  ? ` · ${formatFiat(userWalletScanMap[uw.id].usdTotal, 'USD')}`
                                  : ''}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                          {selectedUserWallets.map((uw) => {
                            const checked = userSweepWalletIds.includes(uw.id);
                            const scan = userWalletScanMap[uw.id];
                            return (
                              <label
                                key={uw.id}
                                className={`block p-3.5 rounded-lg bg-[#090B0F] border transition-colors space-y-1.5 cursor-pointer ${
                                  checked ? 'border-amber-500/50 bg-amber-500/[0.05]' : 'border-white/10'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2 text-xs">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() =>
                                        setUserSweepWalletIds((prev) =>
                                          prev.includes(uw.id)
                                            ? prev.filter((id) => id !== uw.id)
                                            : [...prev, uw.id]
                                        )
                                      }
                                      className="rounded border-white/20 bg-[#11151C] text-amber-500 shrink-0"
                                    />
                                    <span className="font-semibold text-[#F4F6F9] truncate">
                                      {uw.name}
                                    </span>
                                    <span className="text-[#64748B]">·</span>
                                    <span className="font-mono text-[11px] text-emerald-400">
                                      {uw.type}
                                    </span>
                                    {uw.archived && (
                                      <>
                                        <span className="text-[#64748B]">·</span>
                                        <span className="text-[11px] text-amber-400">Archived</span>
                                      </>
                                    )}
                                  </div>
                                  <span className="font-mono text-[11px] text-[#CBD5E1] tabular-nums shrink-0">
                                    {scan ? formatFiat(scan.usdTotal, 'USD') : '—'}
                                  </span>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 font-mono text-[11px] text-[#8A94A6] pl-6">
                                  {uw.addresses.evmAddress && (
                                    <div>EVM: {shortenAddress(uw.addresses.evmAddress, 8, 6)}</div>
                                  )}
                                  {uw.addresses.solanaAddress && (
                                    <div>SOL: {shortenAddress(uw.addresses.solanaAddress, 8, 6)}</div>
                                  )}
                                  {uw.addresses.bitcoinAddress && (
                                    <div>BTC: {shortenAddress(uw.addresses.bitcoinAddress, 8, 6)}</div>
                                  )}
                                  {uw.addresses.moneroAddress && (
                                    <div>XMR: {shortenAddress(uw.addresses.moneroAddress, 8, 6)}</div>
                                  )}
                                </div>
                              </label>
                            );
                          })}
                        </div>

                        {/* Targeted Sweep Execution inside Manage Wallets */}
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            void handleExecuteTargetedWalletSweep(
                              selectedUserForWallets,
                              userSweepWalletIds,
                              'panel'
                            );
                          }}
                          className="pt-4 border-t border-white/10 space-y-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-amber-400 inline-flex items-center gap-1.5">
                              <Zap className="w-3.5 h-3.5" />
                              <span>
                                Sweep Selected User Wallet(s) ({userSweepWalletIds.length})
                              </span>
                            </span>
                            <span className="text-[11px] text-[#64748B]">
                              Routes to Emergency Cold / Pool / Hot Vault
                            </span>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                              <label className="block text-[11px] text-[#8A94A6] mb-1">
                                Destination Treasury / Cold Wallet
                              </label>
                              <select
                                value={userSweepDestWalletId}
                                onChange={(e) => setUserSweepDestWalletId(e.target.value)}
                                required
                                className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                              >
                                <option value="">Select Cold / Pool / Hot Wallet...</option>
                                {emergencyDestOptions.map((w) => {
                                  const primary =
                                    w.evmAddress ||
                                    w.solanaAddress ||
                                    w.bitcoinAddress ||
                                    w.moneroAddress ||
                                    '';
                                  return (
                                    <option key={w.id} value={w.id}>
                                      {w.tier.toUpperCase()} · {w.label} (
                                      {shortenAddress(primary, 6, 4)})
                                    </option>
                                  );
                                })}
                              </select>
                            </div>
                            <div>
                              <label className="block text-[11px] text-[#8A94A6] mb-1">
                                Sweep Reason
                              </label>
                              <input
                                type="text"
                                value={userSweepReason}
                                onChange={(e) => setUserSweepReason(e.target.value)}
                                required
                                className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                              />
                            </div>
                          </div>

                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] text-[#CBD5E1]">
                            <label className="flex items-center gap-1.5 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={userSweepScanLive}
                                onChange={(e) => setUserSweepScanLive(e.target.checked)}
                                className="rounded border-white/20 bg-[#090B0F] text-emerald-500"
                              />
                              <span>Scan balances</span>
                            </label>
                            <label className="flex items-center gap-1.5 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={userSweepArchive}
                                onChange={(e) => setUserSweepArchive(e.target.checked)}
                                className="rounded border-white/20 bg-[#090B0F] text-amber-500"
                              />
                              <span>Archive swept</span>
                            </label>
                            <label className="flex items-center gap-1.5 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={userSweepAllocateRep}
                                onChange={(e) => setUserSweepAllocateRep(e.target.checked)}
                                className="rounded border-white/20 bg-[#090B0F] text-emerald-500"
                              />
                              <span>Allocate new</span>
                            </label>
                            <label className="flex items-center gap-1.5 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={userSweepAutoReimburse}
                                onChange={(e) => setUserSweepAutoReimburse(e.target.checked)}
                                className="rounded border-white/20 bg-[#090B0F] text-emerald-500"
                              />
                              <span>Reimburse coins</span>
                            </label>
                          </div>

                          <div className="flex flex-wrap items-end gap-2.5">
                            <div className="flex-1 min-w-[200px]">
                              <label className="block text-[11px] text-[#8A94A6] mb-1">
                                Admin Custody Encryption Passphrase
                              </label>
                              <input
                                type="password"
                                value={userSweepPass}
                                onChange={(e) => setUserSweepPass(e.target.value)}
                                required
                                placeholder="Enter Admin Custody Passphrase"
                                className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                              />
                            </div>
                            <button
                              type="submit"
                              disabled={
                                userSweepBusy ||
                                userSweepWalletIds.length === 0 ||
                                custodyCooldownSec > 0 ||
                                emergencyDestOptions.length === 0
                              }
                              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 min-h-[38px] rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs whitespace-nowrap shrink-0"
                            >
                              <ShieldAlert className="w-3.5 h-3.5" />
                              <span>
                                {userSweepBusy
                                  ? 'Sweeping...'
                                  : `Sweep Selected (${userSweepWalletIds.length})`}
                              </span>
                            </button>
                          </div>

                          {userSweepNotice && (
                            <div
                              className={`p-3 rounded-lg border text-xs space-y-2 ${
                                userSweepNotice.totalSweptUsd > 0
                                  ? 'bg-emerald-500/10 border-emerald-500/30'
                                  : 'bg-amber-500/10 border-amber-500/30'
                              }`}
                            >
                              <div
                                className={`font-semibold ${
                                  userSweepNotice.totalSweptUsd > 0
                                    ? 'text-emerald-400'
                                    : 'text-amber-400'
                                }`}
                              >
                                {userSweepNotice.totalSweptUsd > 0
                                  ? `Swept ${formatFiat(userSweepNotice.totalSweptUsd, 'USD')} → ${userSweepNotice.destLabel} (Batch ${userSweepNotice.batchId})`
                                  : `Empty Wallet(s) Scanned (0.00 USD Available) — Nothing Swept`}
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-2 rounded bg-[#090B0F] border border-white/10 font-mono text-[11px] tabular-nums">
                                <div>
                                  Source Before:{' '}
                                  <span className="text-amber-300">
                                    {formatFiat(userSweepNotice.totalSweptUsd, 'USD')}
                                  </span>{' '}
                                  → After: <span className="text-emerald-400">$0.00</span>
                                </div>
                                <div>
                                  Dest Before:{' '}
                                  <span className="text-[#CBD5E1]">
                                    {formatFiat(userSweepNotice.destBeforeUsd, 'USD')}
                                  </span>{' '}
                                  → After:{' '}
                                  <span className="text-emerald-400">
                                    {formatFiat(userSweepNotice.destAfterUsd, 'USD')}
                                  </span>
                                </div>
                              </div>
                              {userSweepNotice.generatedMnemonics.map((gm) => (
                                <div
                                  key={gm.uid + gm.walletName}
                                  className="font-mono text-[11px] text-[#CBD5E1] break-words"
                                >
                                  New Wallet ({gm.walletName}): {gm.mnemonic}
                                </div>
                              ))}
                            </div>
                          )}
                        </form>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 3B: BULK OPERATIONS CONSOLE */}
        {tab === 'bulk_ops' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
              {/* Bulk Emergency Sweep Form */}
              <form
                onSubmit={handleExecuteEmergencySweep}
                className="xl:col-span-7 bg-[#11151C] border border-amber-500/30 rounded-xl p-6 space-y-4"
              >
                <div>
                  <div className="text-xs font-mono uppercase text-amber-400">
                    Bulk Operations · Emergency Containment
                  </div>
                  <h2 className="text-base font-semibold text-[#F4F6F9] mt-0.5">
                    Bulk User Wallet Sweep, Replacement Allocation & Reimbursement
                  </h2>
                  <p className="text-xs text-[#8A94A6] mt-0.5">
                    Sweep all user accounts at once or check specific users below to migrate funds to Cold storage, issue clean replacement wallets, and record Excel/CSV audit trails.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-1.5 p-1 bg-[#090B0F] border border-white/10 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setSweepMode('selected')}
                    className={`py-2 px-3 rounded text-xs font-medium transition-colors whitespace-nowrap ${
                      sweepMode === 'selected'
                        ? 'bg-amber-500 text-[#090B0F] font-semibold'
                        : 'text-[#8A94A6] hover:text-[#F4F6F9]'
                    }`}
                  >
                    Selected Users ({sweepSelectedUids.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setSweepMode('bulk_all')}
                    className={`py-2 px-3 rounded text-xs font-medium transition-colors whitespace-nowrap ${
                      sweepMode === 'bulk_all'
                        ? 'bg-red-500 text-white font-semibold'
                        : 'text-[#8A94A6] hover:text-[#F4F6F9]'
                    }`}
                  >
                    Bulk Sweep All Users ({users.length})
                  </button>
                </div>

                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1">
                    Emergency Fund / Cold Destination Wallet
                  </label>
                  <select
                    value={sweepDestWalletId}
                    onChange={(e) => setSweepDestWalletId(e.target.value)}
                    required
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                  >
                    <option value="">Select Emergency Cold / Pool Wallet...</option>
                    {emergencyDestOptions.map((w) => {
                      const primary =
                        w.evmAddress ||
                        w.solanaAddress ||
                        w.bitcoinAddress ||
                        w.moneroAddress ||
                        '';
                      return (
                        <option key={w.id} value={w.id}>
                          {w.tier.toUpperCase()} · {w.label} ({shortenAddress(primary, 6, 4)})
                        </option>
                      );
                    })}
                  </select>
                </div>

                {sweepMode === 'selected' && (
                  <div className="p-3.5 rounded-xl bg-[#090B0F] border border-white/10 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="relative flex-1 min-w-[180px]">
                        <Search className="w-3.5 h-3.5 text-[#64748B] absolute left-2.5 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          value={sweepUserQuery}
                          onChange={(e) => setSweepUserQuery(e.target.value)}
                          placeholder="Filter users by email, name, UID..."
                          className="w-full bg-[#11151C] border border-white/10 rounded-lg pl-8 pr-3 py-1.5 text-base sm:text-xs text-[#F4F6F9]"
                        />
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px]">
                        <button
                          type="button"
                          onClick={() =>
                            setSweepSelectedUids(
                              Array.from(
                                new Set([
                                  ...sweepSelectedUids,
                                  ...sweepSelectableUsers.map((u) => u.uid),
                                ])
                              )
                            )
                          }
                          className="px-2.5 py-1 rounded bg-[#11151C] border border-white/10 text-emerald-400 hover:border-emerald-500/40 whitespace-nowrap"
                        >
                          Select Shown ({sweepSelectableUsers.length})
                        </button>
                        <button
                          type="button"
                          onClick={() => setSweepSelectedUids([])}
                          className="px-2.5 py-1 rounded bg-[#11151C] border border-white/10 text-[#8A94A6] hover:text-[#F4F6F9] whitespace-nowrap"
                        >
                          Clear
                        </button>
                      </div>
                    </div>

                    <div className="max-h-48 overflow-y-auto divide-y divide-white/[0.06] border border-white/5 rounded-lg">
                      {sweepSelectableUsers.map((u) => {
                        const checked = sweepSelectedUids.includes(u.uid);
                        return (
                          <label
                            key={u.uid}
                            className={`flex items-center justify-between gap-3 px-3 py-2 text-xs cursor-pointer hover:bg-white/[0.03] ${
                              checked ? 'bg-amber-500/10' : ''
                            }`}
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => handleToggleSweepUser(u.uid)}
                                className="rounded border-white/20 bg-[#11151C] text-amber-500 shrink-0"
                              />
                              <div className="min-w-0">
                                <div className="font-medium text-[#F4F6F9] truncate">
                                  {u.displayName}
                                </div>
                                <div className="font-mono text-[11px] text-[#8A94A6] truncate">
                                  {u.email}
                                </div>
                              </div>
                            </div>
                            <span className="font-mono text-[11px] text-[#8A94A6] tabular-nums shrink-0">
                              {u.walletCount} wallets
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-[#8A94A6] mb-1">Incident Reason</label>
                    <input
                      type="text"
                      value={sweepReason}
                      onChange={(e) => setSweepReason(e.target.value)}
                      required
                      className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#8A94A6] mb-1">
                      Replacement Wallet Prefix
                    </label>
                    <input
                      type="text"
                      value={sweepReplacementPrefix}
                      onChange={(e) => setSweepReplacementPrefix(e.target.value)}
                      required
                      className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-[#8A94A6] mb-1">
                      Fallback USD / User (Optional)
                    </label>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={sweepOverrideUsd}
                      onChange={(e) => setSweepOverrideUsd(e.target.value)}
                      placeholder="0.00 (uses live scan)"
                      className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-base sm:text-xs text-[#F4F6F9]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#8A94A6] mb-1">
                      Reimbursed Coins Note (Optional)
                    </label>
                    <input
                      type="text"
                      value={sweepOverrideCoinNote}
                      onChange={(e) => setSweepOverrideCoinNote(e.target.value)}
                      placeholder="e.g. 1.50 ETH + 500 USDC"
                      className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1">
                  <label className="flex items-center gap-2 p-2.5 rounded-lg bg-[#090B0F] border border-white/10 text-[11px] text-[#CBD5E1] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sweepScanLiveBalances}
                      onChange={(e) => setSweepScanLiveBalances(e.target.checked)}
                      className="rounded border-white/20 bg-[#11151C] text-emerald-500 shrink-0"
                    />
                    <span>Scan live balances</span>
                  </label>
                  <label className="flex items-center gap-2 p-2.5 rounded-lg bg-[#090B0F] border border-white/10 text-[11px] text-[#CBD5E1] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sweepArchiveCompromised}
                      onChange={(e) => setSweepArchiveCompromised(e.target.checked)}
                      className="rounded border-white/20 bg-[#11151C] text-amber-500 shrink-0"
                    />
                    <span>Archive swept wallets</span>
                  </label>
                  <label className="flex items-center gap-2 p-2.5 rounded-lg bg-[#090B0F] border border-white/10 text-[11px] text-[#CBD5E1] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sweepAutoReimburse}
                      onChange={(e) => setSweepAutoReimburse(e.target.checked)}
                      className="rounded border-white/20 bg-[#11151C] text-emerald-500 shrink-0"
                    />
                    <span>Reimburse immediately</span>
                  </label>
                </div>

                {/* Before & After Live Balance Scanner for Source & Destination Wallets */}
                <div className="p-3.5 rounded-xl bg-[#090B0F] border border-white/10 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold text-[#F4F6F9]">
                        Source & Destination Before / After Balance Check
                      </div>
                      <p className="text-[11px] text-[#8A94A6]">
                        Inspect exact available balances before & after across user wallets and the destination Cold/Pool vault, including empty wallets.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={bulkPreviewScanning}
                      onClick={handleScanBulkBeforeAfterPreview}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#11151C] border border-emerald-500/40 hover:bg-emerald-500/10 text-xs font-medium text-emerald-400 whitespace-nowrap shrink-0"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${bulkPreviewScanning ? 'animate-spin' : ''}`} />
                      <span>
                        {bulkPreviewScanning ? 'Scanning Wallets...' : 'Scan Before / After Balances'}
                      </span>
                    </button>
                  </div>

                  {bulkPreviewData && (
                    <div className="space-y-2.5 pt-2 border-t border-white/10 text-xs">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 font-mono tabular-nums">
                        <div className="p-2.5 rounded-lg bg-[#11151C] border border-white/10">
                          <div className="text-[10px] text-[#8A94A6]">SOURCE WALLETS (BEFORE → AFTER)</div>
                          <div className="text-xs font-semibold text-[#F4F6F9] mt-0.5">
                            {formatFiat(bulkPreviewData.sourceBeforeUsd, 'USD')} →{' '}
                            <span className="text-emerald-400">$0.00</span>
                          </div>
                        </div>
                        <div className="p-2.5 rounded-lg bg-[#11151C] border border-white/10">
                          <div className="text-[10px] text-[#8A94A6] truncate">
                            DEST ({bulkPreviewData.destLabel})
                          </div>
                          <div className="text-xs font-semibold text-[#F4F6F9] mt-0.5">
                            {formatFiat(bulkPreviewData.destBeforeUsd, 'USD')} →{' '}
                            <span className="text-emerald-400">
                              {formatFiat(bulkPreviewData.destAfterUsd, 'USD')}
                            </span>
                          </div>
                        </div>
                        <div className="p-2.5 rounded-lg bg-[#11151C] border border-white/10">
                          <div className="text-[10px] text-[#8A94A6]">FUNDED VS EMPTY ACCOUNTS</div>
                          <div className="text-xs font-semibold mt-0.5">
                            <span className="text-emerald-400">{bulkPreviewData.fundedUsers} Funded</span>
                            {' · '}
                            <span className="text-amber-400">{bulkPreviewData.emptyUsers} Empty ($0)</span>
                          </div>
                        </div>
                      </div>

                      <div className="max-h-44 overflow-y-auto divide-y divide-white/[0.06] border border-white/10 rounded-lg bg-[#11151C]">
                        {bulkPreviewData.userBreakdowns.map((b) => (
                          <div
                            key={b.uid}
                            className="px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px]"
                          >
                            <div className="min-w-0">
                              <span className="font-semibold text-[#F4F6F9]">{b.displayName}</span>{' '}
                              <span className="font-mono text-[#8A94A6]">({b.email})</span>
                              <div className="font-mono text-[10px] text-[#CBD5E1] truncate max-w-md">
                                {b.assetsSummary}
                              </div>
                            </div>
                            <div className="font-mono tabular-nums text-right shrink-0">
                              {b.isEmpty ? (
                                <span className="text-amber-400 font-semibold">
                                  Empty Wallet (0.00 USD)
                                </span>
                              ) : (
                                <span className="text-emerald-400 font-semibold">
                                  Before: {formatFiat(b.beforeUsd, 'USD')} → After: $0.00
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-end gap-3 pt-1">
                  <div className="flex-1 min-w-[220px]">
                    <label className="block text-xs text-[#8A94A6] mb-1">
                      Confirm Admin Custody Encryption Passphrase
                    </label>
                    <input
                      type="password"
                      value={sweepCustodyPass}
                      onChange={(e) => setSweepCustodyPass(e.target.value)}
                      required
                      placeholder="Required to authorize bulk sweep"
                      className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={sweepExecuting || custodyCooldownSec > 0 || emergencyDestOptions.length === 0}
                    className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[38px] rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs whitespace-nowrap shrink-0"
                  >
                    <ShieldAlert className="w-4 h-4" />
                    <span>
                      {sweepExecuting
                        ? 'Executing Bulk Sweep...'
                        : sweepMode === 'bulk_all'
                        ? `Bulk Sweep All (${users.length})`
                        : `Sweep Selected (${sweepSelectedUids.length})`}
                    </span>
                  </button>
                </div>

                {sweepResultNotice && (
                  <div
                    className={`p-4 rounded-xl border space-y-2.5 text-xs ${
                      sweepResultNotice.totalSweptUsd > 0
                        ? 'bg-emerald-500/10 border-emerald-500/30'
                        : 'bg-amber-500/10 border-amber-500/30'
                    }`}
                  >
                    <div
                      className={`font-semibold ${
                        sweepResultNotice.totalSweptUsd > 0 ? 'text-emerald-400' : 'text-amber-400'
                      }`}
                    >
                      {sweepResultNotice.totalSweptUsd > 0
                        ? `Bulk Sweep Complete · Batch ${sweepResultNotice.batchId}`
                        : `Bulk Scan Complete · ${sweepResultNotice.emptyUsersCount} Empty Account(s) (0.00 USD — Nothing Swept)`}
                    </div>
                    <p className="text-[#CBD5E1]">
                      Funded Accounts Swept: <strong>{sweepResultNotice.fundedUsersCount}</strong> · Empty Accounts (0.00 USD — No Reimbursement Issued):{' '}
                      <strong>{sweepResultNotice.emptyUsersCount}</strong> · Target:{' '}
                      <strong>{sweepResultNotice.destLabel}</strong>
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 p-2.5 rounded-lg bg-[#090B0F] border border-white/10 font-mono text-[11px] tabular-nums">
                      <div>
                        <div className="text-[#8A94A6]">Source User Wallets (Available)</div>
                        <div>
                          Before:{' '}
                          <span className="text-amber-300 font-semibold">
                            {formatFiat(sweepResultNotice.totalSweptUsd, 'USD')}
                          </span>{' '}
                          → After: <span className="text-emerald-400 font-semibold">$0.00</span>
                        </div>
                      </div>
                      <div>
                        <div className="text-[#8A94A6]">
                          Destination ({sweepResultNotice.destLabel})
                        </div>
                        <div>
                          Before:{' '}
                          <span className="text-[#CBD5E1]">
                            {formatFiat(sweepResultNotice.destBeforeUsd, 'USD')}
                          </span>{' '}
                          → After:{' '}
                          <span className="text-emerald-400 font-semibold">
                            {formatFiat(sweepResultNotice.destAfterUsd, 'USD')}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </form>

              {/* Right Column: Bulk User Governance & Fleet Settlements */}
              <div className="xl:col-span-5 space-y-5">
                <div className="bg-[#11151C] border border-white/10 rounded-xl p-6 space-y-4">
                  <div>
                    <h3 className="text-base font-semibold text-[#F4F6F9]">
                      Bulk User Governance ({sweepSelectedUids.length} Selected)
                    </h3>
                    <p className="text-xs text-[#8A94A6] mt-0.5">
                      Suspend or reactivate multiple checked user accounts from the selection picker.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={bulkGovBusy || sweepSelectedUids.length === 0}
                      onClick={() => handleBulkUserStatusUpdate('suspended')}
                      className="flex-1 py-2.5 px-3 rounded-lg bg-[#090B0F] border border-red-500/40 hover:bg-red-500/10 disabled:opacity-40 text-xs font-semibold text-red-300 whitespace-nowrap"
                    >
                      Suspend Selected ({sweepSelectedUids.length})
                    </button>
                    <button
                      type="button"
                      disabled={bulkGovBusy || sweepSelectedUids.length === 0}
                      onClick={() => handleBulkUserStatusUpdate('active')}
                      className="flex-1 py-2.5 px-3 rounded-lg bg-[#090B0F] border border-emerald-500/40 hover:bg-emerald-500/10 disabled:opacity-40 text-xs font-semibold text-emerald-400 whitespace-nowrap"
                    >
                      Activate Selected ({sweepSelectedUids.length})
                    </button>
                  </div>
                </div>

                <div className="bg-[#11151C] border border-white/10 rounded-xl p-6 space-y-4">
                  <div>
                    <h3 className="text-base font-semibold text-[#F4F6F9]">
                      Bulk Treasury Settlements & Exports
                    </h3>
                    <p className="text-xs text-[#8A94A6] mt-0.5">
                      Batch disburse pending claims, clear gas sponsorship ledgers, or export Excel audit sheets.
                    </p>
                  </div>

                  <div className="space-y-2.5">
                    <button
                      type="button"
                      disabled={bulkGovBusy || pendingClaimsCount === 0}
                      onClick={handleBulkDisburseAllPendingClaims}
                      className="w-full py-2.5 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-[#090B0F] font-semibold text-xs whitespace-nowrap"
                    >
                      Bulk Disburse Pending Claims ({pendingClaimsCount})
                    </button>

                    <button
                      type="button"
                      disabled={Boolean(settlingFeeGasId) || pendingFeeGasCount === 0}
                      onClick={handleSettleAllPendingFeeGas}
                      className="w-full py-2.5 px-4 rounded-lg bg-[#090B0F] border border-white/10 hover:border-emerald-500/40 disabled:opacity-40 text-xs font-medium text-[#F4F6F9] whitespace-nowrap"
                    >
                      Bulk Settle Pending Gas & Fees ({pendingFeeGasCount})
                    </button>

                    <div className="grid grid-cols-2 gap-2 pt-1">
                      <button
                        type="button"
                        disabled={filteredEmergencySweeps.length === 0}
                        onClick={() => downloadEmergencySweepsExcel(filteredEmergencySweeps)}
                        className="inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-[#090B0F] border border-emerald-500/40 disabled:opacity-40 text-xs font-medium text-emerald-400 whitespace-nowrap"
                      >
                        <FileSpreadsheet className="w-3.5 h-3.5" />
                        <span>Export Excel (.xls)</span>
                      </button>
                      <button
                        type="button"
                        disabled={filteredEmergencySweeps.length === 0}
                        onClick={() => downloadEmergencySweepsCsv(filteredEmergencySweeps)}
                        className="inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-[#090B0F] border border-white/10 disabled:opacity-40 text-xs text-[#CBD5E1] whitespace-nowrap"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Export CSV</span>
                      </button>
                    </div>
                  </div>

                  {bulkGovNotice && (
                    <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-400">
                      {bulkGovNotice}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: RISK & SYSTEM CONTROLS + EMERGENCY SWEEP CONTAINMENT */}
        {tab === 'risk' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
              {/* Left Column: Global Circuit Breakers, Gas & Fee Rules */}
              <div className="xl:col-span-5 bg-[#11151C] border border-white/10 rounded-xl p-6 space-y-5">
                <div>
                  <h2 className="text-base font-semibold text-[#F4F6F9]">
                    Exchange Risk & Circuit Breakers
                  </h2>
                  <p className="text-xs text-[#8A94A6] mt-0.5">
                    Global operational parameters synced via Firestore system_config/exchange
                  </p>
                </div>

                <div className="space-y-4">
                  <label className="flex items-center justify-between gap-3 p-4 rounded-lg bg-[#090B0F] border border-white/10 cursor-pointer">
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
                      className="rounded border-white/20 bg-[#11151C] text-emerald-500 shrink-0"
                    />
                  </label>

                  <label className="flex items-center justify-between gap-3 p-4 rounded-lg bg-[#090B0F] border border-white/10 cursor-pointer">
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
                        setSystemConfig((prev) => ({
                          ...prev,
                          withdrawalsPaused: e.target.checked,
                        }))
                      }
                      className="rounded border-white/20 bg-[#11151C] text-red-500 shrink-0"
                    />
                  </label>

                  <label className="flex items-center justify-between gap-3 p-4 rounded-lg bg-[#090B0F] border border-white/10 cursor-pointer">
                    <div>
                      <div className="text-sm font-medium text-[#F4F6F9]">
                        Automatic Exchange Gas Sponsorship
                      </div>
                      <div className="text-xs text-[#8A94A6]">
                        Automatically calculates network gas for Send, Receive, Swap, and Sweep transactions
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={systemConfig.gasSponsorshipEnabled ?? true}
                      onChange={(e) =>
                        setSystemConfig((prev) => ({
                          ...prev,
                          gasSponsorshipEnabled: e.target.checked,
                        }))
                      }
                      className="rounded border-white/20 bg-[#11151C] text-emerald-500 shrink-0"
                    />
                  </label>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-[#8A94A6] mb-1">
                        Hot Reserve (%)
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
                        className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-base sm:text-sm text-[#F4F6F9]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#8A94A6] mb-1">
                        Swap Fee (BPS)
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
                        className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-base sm:text-sm text-[#F4F6F9]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#8A94A6] mb-1">
                        Send Fee (BPS)
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={500}
                        value={systemConfig.sendFeeBps ?? 25}
                        onChange={(e) =>
                          setSystemConfig((prev) => ({
                            ...prev,
                            sendFeeBps: Number(e.target.value),
                          }))
                        }
                        className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-base sm:text-sm text-[#F4F6F9]"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-[#8A94A6] mb-1">
                        Gas Sponsor Wallet
                      </label>
                      <select
                        value={systemConfig.gasSponsorWalletId || ''}
                        onChange={(e) => {
                          const found = activeExchangeWallets.find((w) => w.id === e.target.value);
                          const addr = found
                            ? found.evmAddress ||
                              found.solanaAddress ||
                              found.bitcoinAddress ||
                              found.moneroAddress ||
                              ''
                            : undefined;
                          setSystemConfig((prev) => ({
                            ...prev,
                            gasSponsorWalletId: found?.id,
                            gasSponsorWalletLabel: found
                              ? `${found.tier.toUpperCase()} · ${found.label}`
                              : undefined,
                            gasSponsorWalletAddress: addr,
                          }));
                        }}
                        className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                      >
                        <option value="">Select Gas Sponsor Wallet...</option>
                        {activeExchangeWallets
                          .filter((w) => w.status !== 'frozen')
                          .map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.tier.toUpperCase()} · {w.label}
                            </option>
                          ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs text-[#8A94A6] mb-1">
                        Nominated Fee Collector
                      </label>
                      <select
                        value={systemConfig.feeCollectorWalletId || ''}
                        onChange={(e) => {
                          const found = activeExchangeWallets.find((w) => w.id === e.target.value);
                          const addr = found
                            ? found.evmAddress ||
                              found.solanaAddress ||
                              found.bitcoinAddress ||
                              found.moneroAddress ||
                              ''
                            : undefined;
                          setSystemConfig((prev) => ({
                            ...prev,
                            feeCollectorWalletId: found?.id,
                            feeCollectorWalletLabel: found
                              ? `${found.tier.toUpperCase()} · ${found.label}`
                              : undefined,
                            feeCollectorWalletAddress: addr,
                          }));
                        }}
                        className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                      >
                        <option value="">Select Nominated Fee Wallet...</option>
                        {activeExchangeWallets
                          .filter((w) => w.status !== 'frozen')
                          .map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.tier.toUpperCase()} · {w.label}
                            </option>
                          ))}
                      </select>
                    </div>
                  </div>

                  {configSavedNotice && (
                    <div className="text-xs text-emerald-400 font-medium">{configSavedNotice}</div>
                  )}

                  <button
                    type="button"
                    disabled={savingGasFeeConfig}
                    onClick={handleSaveSystemConfig}
                    className="w-full sm:w-auto px-5 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs"
                  >
                    {savingGasFeeConfig ? 'Saving...' : 'Save Exchange Configuration'}
                  </button>
                </div>
              </div>

              {/* Right Column: Emergency Risk Sweep, Wallet Replacement & Coin Reimbursement */}
              <form
                onSubmit={handleExecuteEmergencySweep}
                className="xl:col-span-7 bg-[#11151C] border border-amber-500/30 rounded-xl p-6 space-y-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-amber-400 text-xs font-mono uppercase">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      <span>Emergency Incident Containment</span>
                    </div>
                    <h2 className="text-base font-semibold text-[#F4F6F9] mt-0.5">
                      Emergency User Wallet Sweep, Allocation & Coin Reimbursement
                    </h2>
                    <p className="text-xs text-[#8A94A6] mt-0.5">
                      Sweep bulk or selected user wallets to an Emergency Cold/Fund Wallet, archive compromised vaults, allocate clean replacement wallets, and issue coin reimbursements.
                    </p>
                  </div>
                </div>

                {/* Scope Toggle */}
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1.5">Sweep Target Scope</label>
                  <div className="grid grid-cols-2 gap-1.5 p-1 bg-[#090B0F] border border-white/10 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setSweepMode('selected')}
                      className={`py-2 px-3 rounded text-xs font-medium transition-colors ${
                        sweepMode === 'selected'
                          ? 'bg-amber-500 text-[#090B0F] font-semibold'
                          : 'text-[#8A94A6] hover:text-[#F4F6F9]'
                      }`}
                    >
                      Selected Users ({sweepSelectedUids.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setSweepMode('bulk_all')}
                      className={`py-2 px-3 rounded text-xs font-medium transition-colors ${
                        sweepMode === 'bulk_all'
                          ? 'bg-red-500 text-white font-semibold'
                          : 'text-[#8A94A6] hover:text-[#F4F6F9]'
                      }`}
                    >
                      Bulk Sweep All Users ({users.length})
                    </button>
                  </div>
                </div>

                {/* Destination Cold / Emergency Fund Wallet */}
                <div>
                  <label className="block text-xs text-[#8A94A6] mb-1">
                    Emergency Fund / Cold Destination Wallet
                  </label>
                  <select
                    value={sweepDestWalletId}
                    onChange={(e) => setSweepDestWalletId(e.target.value)}
                    required
                    className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                  >
                    <option value="">Select Emergency Cold / Pool Wallet...</option>
                    {emergencyDestOptions.map((w) => {
                      const primary =
                        w.evmAddress ||
                        w.solanaAddress ||
                        w.bitcoinAddress ||
                        w.moneroAddress ||
                        '';
                      return (
                        <option key={w.id} value={w.id}>
                          {w.tier.toUpperCase()} · {w.label} ({shortenAddress(primary, 6, 4)})
                        </option>
                      );
                    })}
                  </select>
                  {emergencyDestOptions.length === 0 && (
                    <p className="text-[11px] text-amber-400 mt-1">
                      Create or activate a Cold Vault or Pool Wallet under Cold / Pool / Hot first.
                    </p>
                  )}
                </div>

                {/* Selective User Picker */}
                {sweepMode === 'selected' && (
                  <div className="p-3.5 rounded-xl bg-[#090B0F] border border-white/10 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="relative flex-1 min-w-[180px]">
                        <Search className="w-3.5 h-3.5 text-[#64748B] absolute left-2.5 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          value={sweepUserQuery}
                          onChange={(e) => setSweepUserQuery(e.target.value)}
                          placeholder="Filter users by email, name, UID..."
                          className="w-full bg-[#11151C] border border-white/10 rounded-lg pl-8 pr-3 py-1.5 text-base sm:text-xs text-[#F4F6F9]"
                        />
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px]">
                        <button
                          type="button"
                          onClick={() =>
                            setSweepSelectedUids(
                              Array.from(
                                new Set([
                                  ...sweepSelectedUids,
                                  ...sweepSelectableUsers.map((u) => u.uid),
                                ])
                              )
                            )
                          }
                          className="px-2.5 py-1 rounded bg-[#11151C] border border-white/10 text-emerald-400 hover:border-emerald-500/40 whitespace-nowrap"
                        >
                          Select Shown ({sweepSelectableUsers.length})
                        </button>
                        <button
                          type="button"
                          onClick={() => setSweepSelectedUids([])}
                          className="px-2.5 py-1 rounded bg-[#11151C] border border-white/10 text-[#8A94A6] hover:text-[#F4F6F9] whitespace-nowrap"
                        >
                          Clear
                        </button>
                      </div>
                    </div>

                    <div className="max-h-48 overflow-y-auto divide-y divide-white/[0.06] border border-white/5 rounded-lg">
                      {sweepSelectableUsers.length === 0 ? (
                        <div className="p-4 text-center text-xs text-[#8A94A6]">
                          No matching user accounts found.
                        </div>
                      ) : (
                        sweepSelectableUsers.map((u) => {
                          const checked = sweepSelectedUids.includes(u.uid);
                          return (
                            <label
                              key={u.uid}
                              className={`flex items-center justify-between gap-3 px-3 py-2 text-xs cursor-pointer hover:bg-white/[0.03] ${
                                checked ? 'bg-amber-500/10' : ''
                              }`}
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => handleToggleSweepUser(u.uid)}
                                  className="rounded border-white/20 bg-[#11151C] text-amber-500 shrink-0"
                                />
                                <div className="min-w-0">
                                  <div className="font-medium text-[#F4F6F9] truncate">
                                    {u.displayName}
                                  </div>
                                  <div className="font-mono text-[11px] text-[#8A94A6] truncate">
                                    {u.email}
                                  </div>
                                </div>
                              </div>
                              <span className="font-mono text-[11px] text-[#8A94A6] tabular-nums shrink-0">
                                {u.walletCount} wallets
                              </span>
                            </label>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-[#8A94A6] mb-1">
                      Incident / Risk Reason
                    </label>
                    <input
                      type="text"
                      value={sweepReason}
                      onChange={(e) => setSweepReason(e.target.value)}
                      required
                      className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#8A94A6] mb-1">
                      Replacement Wallet Prefix
                    </label>
                    <input
                      type="text"
                      value={sweepReplacementPrefix}
                      onChange={(e) => setSweepReplacementPrefix(e.target.value)}
                      required
                      className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-[#8A94A6] mb-1">
                      Fallback Reimbursement USD / User (Optional)
                    </label>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={sweepOverrideUsd}
                      onChange={(e) => setSweepOverrideUsd(e.target.value)}
                      placeholder="0.00 (uses live scan if > 0)"
                      className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 font-mono text-base sm:text-xs text-[#F4F6F9]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#8A94A6] mb-1">
                      Reimbursed Coins Note (Optional)
                    </label>
                    <input
                      type="text"
                      value={sweepOverrideCoinNote}
                      onChange={(e) => setSweepOverrideCoinNote(e.target.value)}
                      placeholder="e.g. 1.50 ETH + 500 USDC"
                      className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1">
                  <label className="flex items-center gap-2 p-2.5 rounded-lg bg-[#090B0F] border border-white/10 text-[11px] text-[#CBD5E1] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sweepScanLiveBalances}
                      onChange={(e) => setSweepScanLiveBalances(e.target.checked)}
                      className="rounded border-white/20 bg-[#11151C] text-emerald-500 shrink-0"
                    />
                    <span>Scan live balances</span>
                  </label>
                  <label className="flex items-center gap-2 p-2.5 rounded-lg bg-[#090B0F] border border-white/10 text-[11px] text-[#CBD5E1] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sweepArchiveCompromised}
                      onChange={(e) => setSweepArchiveCompromised(e.target.checked)}
                      className="rounded border-white/20 bg-[#11151C] text-amber-500 shrink-0"
                    />
                    <span>Archive swept wallets</span>
                  </label>
                  <label className="flex items-center gap-2 p-2.5 rounded-lg bg-[#090B0F] border border-white/10 text-[11px] text-[#CBD5E1] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sweepAutoReimburse}
                      onChange={(e) => setSweepAutoReimburse(e.target.checked)}
                      className="rounded border-white/20 bg-[#11151C] text-emerald-500 shrink-0"
                    />
                    <span>Reimburse immediately</span>
                  </label>
                </div>

                <div className="flex flex-wrap items-end gap-3 pt-1">
                  <div className="flex-1 min-w-[220px]">
                    <label className="block text-xs text-[#8A94A6] mb-1">
                      Confirm Admin Custody Encryption Passphrase
                    </label>
                    <input
                      type="password"
                      value={sweepCustodyPass}
                      onChange={(e) => setSweepCustodyPass(e.target.value)}
                      placeholder="Required to authorize sweep & encrypt replacement wallets"
                      required
                      className="w-full bg-[#090B0F] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-xs text-[#F4F6F9]"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={sweepExecuting || custodyCooldownSec > 0 || emergencyDestOptions.length === 0}
                    className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[38px] rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs whitespace-nowrap"
                  >
                    <ShieldAlert className="w-4 h-4" />
                    <span>
                      {custodyCooldownSec > 0
                        ? `Cooldown (${custodyCooldownSec}s)`
                        : sweepExecuting
                        ? 'Executing Emergency Sweep...'
                        : sweepMode === 'bulk_all'
                        ? `Bulk Sweep All (${users.length})`
                        : `Sweep Selected (${sweepSelectedUids.length})`}
                    </span>
                  </button>
                </div>

                {sweepResultNotice && (
                  <div
                    className={`p-4 rounded-xl border space-y-2.5 text-xs ${
                      sweepResultNotice.totalSweptUsd > 0
                        ? 'bg-emerald-500/10 border-emerald-500/30'
                        : 'bg-amber-500/10 border-amber-500/30'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div
                        className={`font-semibold ${
                          sweepResultNotice.totalSweptUsd > 0 ? 'text-emerald-400' : 'text-amber-400'
                        }`}
                      >
                        {sweepResultNotice.totalSweptUsd > 0
                          ? `Emergency Sweep Complete · Batch ${sweepResultNotice.batchId}`
                          : `Sweep Scan Complete · ${sweepResultNotice.emptyUsersCount} Empty Account(s) (0.00 USD — Nothing Swept)`}
                      </div>
                      <button
                        type="button"
                        onClick={() => setSweepResultNotice(null)}
                        className="text-[11px] text-[#8A94A6] hover:text-[#F4F6F9]"
                      >
                        Dismiss
                      </button>
                    </div>
                    <p className="text-[#CBD5E1]">
                      Funded Accounts Swept: <strong>{sweepResultNotice.fundedUsersCount}</strong> · Empty Accounts (0.00 USD):{' '}
                      <strong>{sweepResultNotice.emptyUsersCount}</strong> · Destination:{' '}
                      <strong>{sweepResultNotice.destLabel}</strong>
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 p-2.5 rounded-lg bg-[#090B0F] border border-white/10 font-mono text-[11px] tabular-nums">
                      <div>
                        <div className="text-[#8A94A6]">Source User Wallets (Available)</div>
                        <div>
                          Before:{' '}
                          <span className="text-amber-300 font-semibold">
                            {formatFiat(sweepResultNotice.totalSweptUsd, 'USD')}
                          </span>{' '}
                          → After: <span className="text-emerald-400 font-semibold">$0.00</span>
                        </div>
                      </div>
                      <div>
                        <div className="text-[#8A94A6]">
                          Destination ({sweepResultNotice.destLabel})
                        </div>
                        <div>
                          Before:{' '}
                          <span className="text-[#CBD5E1]">
                            {formatFiat(sweepResultNotice.destBeforeUsd, 'USD')}
                          </span>{' '}
                          → After:{' '}
                          <span className="text-emerald-400 font-semibold">
                            {formatFiat(sweepResultNotice.destAfterUsd, 'USD')}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="max-h-40 overflow-y-auto space-y-1.5 pt-1">
                      {sweepResultNotice.generatedMnemonics.map((item) => (
                        <div
                          key={item.uid + item.walletName}
                          className="p-2.5 rounded bg-[#090B0F] border border-white/10 flex flex-wrap items-center justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <div className="font-medium text-[#F4F6F9] text-[11px]">
                              {item.email} · {item.walletName}
                            </div>
                            <div className="font-mono text-[11px] text-emerald-300 break-words">
                              {item.mnemonic}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleCopy(`emg_${item.uid}`, item.mnemonic)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#11151C] border border-white/10 text-[11px] text-[#CBD5E1] shrink-0"
                          >
                            {copiedKey === `emg_${item.uid}` ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                            <span>Copy Seed</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </form>
            </div>

            {/* Emergency Sweep & Reimbursement Records + Excel Export */}
            <div className="bg-[#11151C] border border-white/10 rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-[#F4F6F9]">
                    Emergency Sweep & Coin Reimbursement Records ({filteredEmergencySweeps.length})
                  </h3>
                  <p className="text-xs text-[#8A94A6]">
                    Permanent ledger of swept user wallets (including Before & After balances for source & destination vaults), empty wallet audit status, and coin reimbursements.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-[#64748B] absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={sweepRecordSearch}
                      onChange={(e) => setSweepRecordSearch(e.target.value)}
                      placeholder="Search email, batch, wallet..."
                      className="bg-[#090B0F] border border-white/10 rounded-lg pl-8 pr-3 py-1.5 text-base sm:text-xs text-[#F4F6F9] w-52"
                    />
                  </div>
                  <select
                    value={sweepRecordStatusFilter}
                    onChange={(e) =>
                      setSweepRecordStatusFilter(
                        e.target.value as 'all' | 'reimbursed' | 'pending_reimbursement'
                      )
                    }
                    className="bg-[#090B0F] border border-white/10 rounded-lg px-3 py-1.5 text-base sm:text-xs text-[#F4F6F9]"
                  >
                    <option value="all">All Statuses</option>
                    <option value="reimbursed">Reimbursed</option>
                    <option value="pending_reimbursement">Pending / Empty Wallets</option>
                  </select>

                  <button
                    type="button"
                    disabled={filteredEmergencySweeps.length === 0}
                    onClick={() => downloadEmergencySweepsExcel(filteredEmergencySweeps)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-[#090B0F] font-semibold text-xs whitespace-nowrap"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5" />
                    <span>Download Excel (.xls)</span>
                  </button>

                  <button
                    type="button"
                    disabled={filteredEmergencySweeps.length === 0}
                    onClick={() => downloadEmergencySweepsCsv(filteredEmergencySweeps)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#090B0F] border border-white/10 hover:border-white/25 disabled:opacity-40 text-[#CBD5E1] text-xs whitespace-nowrap"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>CSV</span>
                  </button>
                </div>
              </div>

              {filteredEmergencySweeps.length === 0 ? (
                <div className="p-10 text-center text-xs text-[#8A94A6]">
                  No emergency user wallet sweeps recorded yet. Execute a Bulk or Selective Emergency Sweep above to protect user funds and generate downloadable Excel records.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-white/10 text-[11px] text-[#8A94A6]">
                        <th className="py-3 px-5">Batch & Time</th>
                        <th className="py-3 px-4">Affected User</th>
                        <th className="py-3 px-4">Source Wallet (Before → After)</th>
                        <th className="py-3 px-4">Destination Vault (Before → After)</th>
                        <th className="py-3 px-4">Allocated Replacement Wallet</th>
                        <th className="py-3 px-5 text-right">Reimbursement</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.06] text-xs">
                      {filteredEmergencySweeps.map((rec) => {
                        const busy = reimbursingSweepId === rec.id;
                        const isEmptySweep = Number(rec.sweptUsdValue || 0) <= 0;
                        const srcBefore = Number(rec.sourceBeforeUsd ?? rec.sweptUsdValue ?? 0);
                        const srcAfter = Number(rec.sourceAfterUsd ?? 0);
                        const dstBefore = Number(rec.destinationBeforeUsd ?? 0);
                        const dstAfter = Number(
                          rec.destinationAfterUsd ?? dstBefore + Number(rec.sweptUsdValue || 0)
                        );
                        return (
                          <tr key={rec.id} className="hover:bg-white/[0.02] align-top">
                            <td className="py-3 px-5 font-mono text-[11px] whitespace-nowrap">
                              <div className="text-[#F4F6F9]">
                                {rec.mode === 'bulk_all' ? 'BULK' : 'SELECT'}
                              </div>
                              <div className="text-[#64748B]">
                                {formatRelativeTime(rec.createdAt)}
                              </div>
                              <div className="text-[10px] text-[#64748B]">
                                {rec.batchId.slice(0, 16)}
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              <div className="font-medium text-[#F4F6F9]">
                                {rec.targetDisplayName}
                              </div>
                              <div className="font-mono text-[11px] text-[#8A94A6]">
                                {rec.targetEmail}
                              </div>
                              <div className="text-[11px] text-[#64748B] max-w-[200px] truncate">
                                {rec.reason}
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              {isEmptySweep ? (
                                <div className="font-mono text-[11px] font-semibold text-amber-400">
                                  EMPTY WALLET ($0.00 → $0.00)
                                </div>
                              ) : (
                                <div className="font-mono text-[11px] tabular-nums">
                                  <span className="text-[#8A94A6]">Before:</span>{' '}
                                  <span className="font-semibold text-amber-300">
                                    {formatFiat(srcBefore, 'USD')}
                                  </span>{' '}
                                  → <span className="text-[#8A94A6]">After:</span>{' '}
                                  <span className="font-semibold text-emerald-400">
                                    {formatFiat(srcAfter, 'USD')}
                                  </span>
                                </div>
                              )}
                              <div className="text-[11px] text-[#CBD5E1] max-w-[240px] mt-0.5">
                                {rec.sweptAssetsSummary}
                              </div>
                              <div className="font-mono text-[10px] text-[#64748B] max-w-[240px] truncate">
                                {rec.sweptWalletIds.length} wallet(s): {rec.sweptAddressesSummary}
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              <div className="text-sky-400 font-medium">
                                {rec.destinationWalletLabel}
                              </div>
                              <div className="font-mono text-[11px] text-[#8A94A6]">
                                {shortenAddress(rec.destinationAddress, 8, 6)}
                              </div>
                              <div className="font-mono text-[11px] text-[#CBD5E1] tabular-nums mt-0.5">
                                Before: {formatFiat(dstBefore, 'USD')} → After:{' '}
                                <span className="text-emerald-400 font-semibold">
                                  {formatFiat(dstAfter, 'USD')}
                                </span>
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              <div className="text-emerald-400 font-medium">
                                {rec.replacementWalletName}
                              </div>
                              {rec.replacementEvmAddress && (
                                <div className="font-mono text-[11px] text-[#CBD5E1]">
                                  EVM: {shortenAddress(rec.replacementEvmAddress, 8, 6)}
                                </div>
                              )}
                              {rec.replacementSolanaAddress && (
                                <div className="font-mono text-[11px] text-[#8A94A6]">
                                  SOL: {shortenAddress(rec.replacementSolanaAddress, 8, 6)}
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-5 text-right whitespace-nowrap">
                              {isEmptySweep ? (
                                <div className="space-y-0.5">
                                  <div className="font-mono text-[11px] text-amber-400 font-semibold">
                                    Empty Wallet · Nothing Swept
                                  </div>
                                  <div className="font-mono text-[10px] text-[#64748B]">
                                    0.00 USD Received (Not Eligible)
                                  </div>
                                </div>
                              ) : rec.reimbursementStatus === 'reimbursed' ? (
                                <div className="space-y-0.5">
                                  <div className="font-mono text-[11px] text-emerald-400 font-semibold">
                                    Reimbursed
                                  </div>
                                  <div className="font-mono text-[11px] text-[#CBD5E1] tabular-nums">
                                    {rec.reimbursedAmountSummary}
                                  </div>
                                  {rec.reimbursedTxHash && (
                                    <div className="font-mono text-[10px] text-[#64748B]">
                                      Tx: {shortenAddress(rec.reimbursedTxHash, 8, 6)}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => handleReimburseSweepRecord(rec)}
                                  className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-[#090B0F] font-semibold text-xs whitespace-nowrap"
                                >
                                  {busy ? 'Reimbursing...' : 'Reimburse Coins'}
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
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
    </div>
  );
}
