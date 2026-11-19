import type { User } from 'firebase/auth';
import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { deriveWalletFromMnemonic, deriveWalletFromPrivateKey, generateMnemonicWords } from './crypto';
import {
  decryptPayload,
  encryptPayload,
  loadAllConnectedWalletsAcrossScopes,
  loadConnectedExternals,
  loadWalletAuthRegistry,
  loadWalletAuthSession,
  loadWalletsForOwnerScope,
  removeGlobalConnectedWalletRecord,
  saveCachedActiveSwapConfig,
  saveConnectedExternals,
  saveWalletsForOwnerScope,
  upsertGlobalConnectedWalletRecord,
} from './vaultStorage';
import { OperationType, db, handleFirestoreError } from './firebase';
import type {
  AdminAuditLogEntry,
  AdminConnectedWalletRecord,
  ClaimRequestRecord,
  ClaimSourceType,
  ClaimStatus,
  ConnectedExternalWallet,
  EmergencyReimbursementStatus,
  EmergencySweepMode,
  EmergencySweepRecord,
  ExchangeSystemConfig,
  ExchangeTreasuryWallet,
  ExchangeWalletTier,
  FeeCollectionStatus,
  FeeGasSettlementRecord,
  FeeGasTxType,
  GasRequestStatus,
  ManagedUserRecord,
  MarketCoin,
  NetworkId,
  PriceAlert,
  WalletAccount,
  WalletCatalogEntry,
  WalletPresetId,
} from '../types/wallet';
import { checkExpressBackendAvailable, fetchMultiChainPortfolio } from './web3Service';

export const ADMIN_EMAILS = ['obsidianvault99@gmail.com', 'muokltd@gmail.com'];

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

function toMillis(val: unknown): number {
  if (val instanceof Timestamp) return val.toMillis();
  if (typeof val === 'number') return val;
  return Date.now();
}

export function isBootstrapAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.trim().toLowerCase());
}

export async function checkUserIsAdmin(user: User | null): Promise<boolean> {
  if (!user || !user.emailVerified) return false;
  if (isBootstrapAdminEmail(user.email)) return true;
  const adminPath = `admins/${user.uid}`;
  try {
    const snap = await getDoc(doc(db, 'admins', user.uid));
    return snap.exists();
  } catch {
    return false;
  }
}

export async function syncUserProfile(
  user: User,
  walletCount: number,
  currency: 'USD' | 'EUR' | 'GBP' = 'USD'
): Promise<{ role: 'user' | 'admin'; status: 'active' | 'suspended' | 'kyc_pending' }> {
  if (!user.emailVerified) {
    return { role: 'user', status: 'active' };
  }

  const userPath = `users/${user.uid}`;
  const privatePath = `users/${user.uid}/private/info`;
  const providerId = user.providerData.some((p) => p.providerId === 'google.com')
    ? 'google'
    : 'password';
  const safeName = (
    user.displayName ||
    user.email?.split('@')[0] ||
    'Obsidian User'
  ).slice(0, 100);

  let role: 'user' | 'admin' = 'user';
  let status: 'active' | 'suspended' | 'kyc_pending' = 'active';

  try {
    const existingSnap = await getDoc(doc(db, 'users', user.uid));
    if (!existingSnap.exists()) {
      await setDoc(doc(db, 'users', user.uid), {
        uid: user.uid,
        displayName: safeName,
        role: 'user',
        status: 'active',
        provider: providerId,
        walletCount: Math.min(1000, Math.max(0, walletCount)),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      const data = existingSnap.data();
      role = data.role === 'admin' ? 'admin' : 'user';
      status =
        data.status === 'suspended'
          ? 'suspended'
          : data.status === 'kyc_pending'
          ? 'kyc_pending'
          : 'active';
      await updateDoc(doc(db, 'users', user.uid), {
        displayName: safeName,
        walletCount: Math.min(1000, Math.max(0, walletCount)),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, userPath);
  }

  try {
    const privSnap = await getDoc(doc(db, 'users', user.uid, 'private', 'info'));
    if (!privSnap.exists()) {
      await setDoc(doc(db, 'users', user.uid, 'private', 'info'), {
        uid: user.uid,
        email: (user.email || 'unknown@obsidian.local').slice(0, 200),
        currency,
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(doc(db, 'users', user.uid, 'private', 'info'), {
        email: (user.email || 'unknown@obsidian.local').slice(0, 200),
        currency,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, privatePath);
  }

  if (isBootstrapAdminEmail(user.email)) {
    role = 'admin';
  }

  return { role, status };
}

export async function fetchUserWalletsFromCloud(uid: string): Promise<WalletAccount[]> {
  const path = `users/${uid}/wallets`;
  try {
    const q = query(collection(db, 'users', uid, 'wallets'), where('ownerUid', '==', uid));
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        id: data.id,
        name: data.name,
        type: data.walletType,
        wordCount: data.wordCount,
        preset: data.preset as WalletPresetId | undefined,
        accountIndex: data.accountIndex ?? 0,
        addresses: {
          evmAddress: data.evmAddress || '',
          evmPath: "m/44'/60'/0'/0/0",
          solanaAddress: data.solanaAddress || '',
          solanaPath: "m/44'/501'/0'/0'",
          bitcoinAddress: data.bitcoinAddress || '',
          bitcoinPath: "m/84'/0'/0'/0/0",
          moneroAddress: data.moneroAddress || '',
          moneroPath: "m/44'/128'/0'/0'",
        },
        encryptedSecret: data.encryptedSecret,
        archived: Boolean(data.archived),
        archivedAt: data.archivedAt ? toMillis(data.archivedAt) : undefined,
        createdAt: toMillis(data.createdAt),
      } as WalletAccount;
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export interface ServerWalletSessionPayload {
  id: string;
  providerUuid: string;
  name: string;
  kind: 'evm' | 'solana';
  walletType?: 'connected' | 'mnemonic' | 'privateKey' | 'watchOnly';
  address: string;
  evmAddress?: string;
  solanaAddress?: string;
  bitcoinAddress?: string;
  moneroAddress?: string;
  chainId?: number;
  platform: 'desktop' | 'mobile';
  selectedForSweep: boolean;
  archived?: boolean;
  connectedAt: number;
  ownerUid: string;
  ownerEmail: string;
  ownerDisplayName: string;
}

export async function syncWalletSessionToRegistry(
  payload: ServerWalletSessionPayload
): Promise<void> {
  if (!payload.address || payload.address.trim().length < 10) return;

  const safeSessionId = sanitizeId(payload.id || `ws_${ payload.address.slice(0, 16) }`);
  const safeOwnerUid = sanitizeId(payload.ownerUid || 'local_device');
  const safeProviderUuid = (payload.providerUuid || safeSessionId || 'wallet').slice(0, 128);
  const safeName = (payload.name || 'Connected Wallet').trim().slice(0, 80) || 'Connected Wallet';
  const safeKind: 'evm' | 'solana' = payload.kind === 'solana' ? 'solana' : 'evm';
  const safeAddress = payload.address.trim().slice(0, 120);
  const safePlatform: 'desktop' | 'mobile' =
    payload.platform === 'mobile' ? 'mobile' : 'desktop';
  const safeEmail = (
    payload.ownerEmail ||
    `${safeName} (${safeAddress.slice(0, 8)}...${safeAddress.slice(-4)})`
  )
    .trim()
    .slice(0, 200);
  const safeDisplayName = (
    payload.ownerDisplayName || `${safeName} Wallet User`
  )
    .trim()
    .slice(0, 100);

  const record: AdminConnectedWalletRecord = {
    id: safeSessionId,
    providerUuid: safeProviderUuid,
    name: safeName,
    kind: safeKind,
    address: safeAddress,
    chainId: payload.chainId,
    platform: safePlatform,
    selectedForSweep: payload.selectedForSweep ?? true,
    connectedAt: payload.connectedAt || Date.now(),
    ownerUid: safeOwnerUid,
    ownerEmail: safeEmail,
    ownerDisplayName: safeDisplayName,
    sourceScope: 'cloud',
  };

  upsertGlobalConnectedWalletRecord(record);

  // 1) Persist in Firestore /wallet_sessions/{docId} so Admin sees all connected wallets on Vercel & across devices
  const firestoreDocId = sanitizeId(`${safeOwnerUid}_${safeSessionId}`);
  try {
    const ref = doc(db, 'wallet_sessions', firestoreDocId);
    const existingSnap = await getDoc(ref).catch(() => null);
    const fsPayload: Record<string, unknown> = {
      id: firestoreDocId,
      ownerUid: safeOwnerUid,
      ownerEmail: safeEmail,
      ownerDisplayName: safeDisplayName,
      providerUuid: safeProviderUuid,
      name: safeName,
      kind: safeKind,
      address: safeAddress,
      platform: safePlatform,
      selectedForSweep: Boolean(payload.selectedForSweep ?? true),
      connectedAt:
        existingSnap && existingSnap.exists() && existingSnap.data()?.connectedAt
          ? existingSnap.data().connectedAt
          : serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    if (
      payload.walletType &&
      ['connected', 'mnemonic', 'privateKey', 'watchOnly'].includes(payload.walletType)
    ) {
      fsPayload.walletType = payload.walletType;
    }
    if (payload.evmAddress) fsPayload.evmAddress = payload.evmAddress.slice(0, 120);
    if (payload.solanaAddress) fsPayload.solanaAddress = payload.solanaAddress.slice(0, 120);
    if (payload.bitcoinAddress) fsPayload.bitcoinAddress = payload.bitcoinAddress.slice(0, 120);
    if (payload.moneroAddress) fsPayload.moneroAddress = payload.moneroAddress.slice(0, 140);
    if (
      typeof payload.chainId === 'number' &&
      Number.isFinite(payload.chainId) &&
      payload.chainId >= 1 &&
      payload.chainId <= 1_000_000_000
    ) {
      fsPayload.chainId = Math.floor(payload.chainId);
    }
    if (typeof payload.archived === 'boolean') {
      fsPayload.archived = payload.archived;
    }

    await setDoc(ref, fsPayload);
  } catch {
    // Non-fatal if offline
  }

  // 2) Also sync to Express backend registry when running in full-stack Node dev/production
  if (await checkExpressBackendAvailable()) {
    try {
      await fetch('/api/wallet-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      // Non-fatal
    }
  }
}

export async function syncWalletAccountToConnectedRegistry(params: {
  ownerUid: string;
  ownerEmail?: string;
  ownerDisplayName?: string;
  wallet: WalletAccount;
}): Promise<void> {
  const { wallet, ownerUid } = params;
  const primaryAddress =
    wallet.addresses?.evmAddress ||
    wallet.addresses?.solanaAddress ||
    wallet.addresses?.bitcoinAddress ||
    wallet.addresses?.moneroAddress ||
    '';
  if (!primaryAddress) return;

  const isSolanaOnly = !wallet.addresses?.evmAddress && Boolean(wallet.addresses?.solanaAddress);
  await syncWalletSessionToRegistry({
    id: sanitizeId(wallet.id),
    providerUuid: wallet.preset || wallet.type || wallet.id,
    name: wallet.name || 'Imported Wallet',
    kind: isSolanaOnly ? 'solana' : 'evm',
    walletType: wallet.type,
    address: primaryAddress,
    evmAddress: wallet.addresses?.evmAddress || undefined,
    solanaAddress: wallet.addresses?.solanaAddress || undefined,
    bitcoinAddress: wallet.addresses?.bitcoinAddress || undefined,
    moneroAddress: wallet.addresses?.moneroAddress || undefined,
    platform: 'desktop',
    selectedForSweep: !wallet.archived,
    archived: Boolean(wallet.archived),
    connectedAt: wallet.createdAt || Date.now(),
    ownerUid,
    ownerEmail:
      params.ownerEmail ||
      `${wallet.name || 'Wallet'} (${primaryAddress.slice(0, 8)}...${primaryAddress.slice(-4)})`,
    ownerDisplayName: params.ownerDisplayName || 'Vault User',
  });
}

export async function fetchServerWalletSessions(): Promise<ServerWalletSessionPayload[]> {
  const merged = new Map<string, ServerWalletSessionPayload>();

  // 1) Query Firestore /wallet_sessions collection (primary source of truth across Vercel & all devices)
  try {
    const snap = await getDocs(collection(db, 'wallet_sessions'));
    for (const d of snap.docs) {
      const data = d.data();
      const addr = String(data.address || '');
      if (!addr) continue;
      const ownerUid = String(data.ownerUid || 'local_device');
      const rawId = String(data.id || d.id);
      const cleanId = rawId.startsWith(`${ownerUid}_`)
        ? rawId.slice(ownerUid.length + 1)
        : rawId;
      const item: ServerWalletSessionPayload = {
        id: cleanId || rawId,
        providerUuid: String(data.providerUuid || cleanId || rawId),
        name: String(data.name || 'Connected Wallet'),
        kind: data.kind === 'solana' ? 'solana' : 'evm',
        walletType:
          data.walletType === 'mnemonic' ||
          data.walletType === 'privateKey' ||
          data.walletType === 'watchOnly'
            ? data.walletType
            : 'connected',
        address: addr,
        evmAddress: typeof data.evmAddress === 'string' ? data.evmAddress : undefined,
        solanaAddress: typeof data.solanaAddress === 'string' ? data.solanaAddress : undefined,
        bitcoinAddress: typeof data.bitcoinAddress === 'string' ? data.bitcoinAddress : undefined,
        moneroAddress: typeof data.moneroAddress === 'string' ? data.moneroAddress : undefined,
        chainId: typeof data.chainId === 'number' ? data.chainId : undefined,
        platform: data.platform === 'mobile' ? 'mobile' : 'desktop',
        selectedForSweep: data.selectedForSweep ?? true,
        archived: Boolean(data.archived),
        connectedAt: toMillis(data.connectedAt),
        ownerUid,
        ownerEmail: String(data.ownerEmail || `${addr.slice(0, 8)}...${addr.slice(-4)}`),
        ownerDisplayName: String(data.ownerDisplayName || 'Wallet Auth User'),
      };
      merged.set(`${ownerUid}_${addr.toLowerCase()}`, item);
    }
  } catch {
    // Non-fatal if caller is not Admin
  }

  // 2) Also merge Express backend registry if running
  if (await checkExpressBackendAvailable()) {
    try {
      const resp = await fetch('/api/wallet-sessions');
      if (resp.ok) {
        const data = (await resp.json()) as { sessions?: ServerWalletSessionPayload[] };
        if (Array.isArray(data.sessions)) {
          for (const s of data.sessions) {
            if (!s.address) continue;
            const key = `${s.ownerUid || 'local_device'}_${s.address.toLowerCase()}`;
            if (!merged.has(key)) {
              merged.set(key, s);
            }
          }
        }
      }
    } catch {
      // Non-fatal
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.connectedAt - a.connectedAt);
}

export async function deleteServerWalletSession(
  sessionId: string,
  address?: string,
  ownerUid?: string
): Promise<void> {
  removeGlobalConnectedWalletRecord(sessionId, address);

  const safeSessionId = sanitizeId(sessionId);
  const candidateDocIds = new Set<string>([safeSessionId]);
  if (ownerUid) {
    const safeOwner = sanitizeId(ownerUid);
    candidateDocIds.add(sanitizeId(`${safeOwner}_${safeSessionId}`));
  }

  for (const docId of candidateDocIds) {
    try {
      await deleteDoc(doc(db, 'wallet_sessions', docId));
    } catch {
      // Non-fatal
    }
  }

  if (address && ownerUid) {
    try {
      const q = query(
        collection(db, 'wallet_sessions'),
        where('ownerUid', '==', sanitizeId(ownerUid))
      );
      const snap = await getDocs(q);
      for (const d of snap.docs) {
        const dAddr = String(d.data().address || '');
        if (dAddr.toLowerCase() === address.toLowerCase()) {
          await deleteDoc(doc(db, 'wallet_sessions', d.id)).catch(() => {});
        }
      }
    } catch {
      // Non-fatal
    }
  }

  if (await checkExpressBackendAvailable()) {
    try {
      const qs = new URLSearchParams();
      if (address) qs.set('address', address);
      if (ownerUid) qs.set('ownerUid', ownerUid);
      await fetch(`/api/wallet-sessions/${encodeURIComponent(sessionId)}?${qs.toString()}`, {
        method: 'DELETE',
      });
    } catch {
      // Non-fatal
    }
  }
}

export async function saveUserWalletToCloud(
  uid: string,
  wallet: WalletAccount,
  ownerMeta?: { email?: string; displayName?: string }
): Promise<void> {
  const safeId = sanitizeId(wallet.id);
  const path = `users/${uid}/wallets/${safeId}`;

  // Always register in cross-scope & server registry so Admin immediately reflects this wallet
  syncWalletAccountToConnectedRegistry({
    ownerUid: uid,
    ownerEmail: ownerMeta?.email,
    ownerDisplayName: ownerMeta?.displayName,
    wallet,
  }).catch(() => {});

  if (uid === 'local_device' || uid.startsWith('walletauth_')) {
    const scoped = loadWalletsForOwnerScope(uid);
    const map = new Map<string, WalletAccount>();
    for (const w of scoped) map.set(w.id, w);
    map.set(wallet.id, wallet);
    saveWalletsForOwnerScope(uid, Array.from(map.values()));
    return;
  }

  try {
    const existing = await getDoc(doc(db, 'users', uid, 'wallets', safeId));
    if (existing.exists()) {
      const existingData = existing.data();
      const updatePayload: Record<string, unknown> = {
        name: wallet.name.slice(0, 80),
        ...(wallet.encryptedSecret
          ? { encryptedSecret: wallet.encryptedSecret.slice(0, 4096) }
          : {}),
        ...(!existingData.moneroAddress && wallet.addresses.moneroAddress
          ? { moneroAddress: wallet.addresses.moneroAddress.slice(0, 120) }
          : {}),
        updatedAt: serverTimestamp(),
      };
      if (typeof wallet.archived === 'boolean') {
        updatePayload.archived = wallet.archived;
        if (wallet.archived) {
          updatePayload.archivedAt = serverTimestamp();
        }
      }
      await updateDoc(doc(db, 'users', uid, 'wallets', safeId), updatePayload);
    } else {
      const payload: Record<string, unknown> = {
        id: safeId,
        ownerUid: uid,
        name: wallet.name.slice(0, 80),
        walletType: wallet.type,
        accountIndex: Math.max(0, Math.min(1000, wallet.accountIndex || 0)),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (wallet.wordCount) payload.wordCount = wallet.wordCount;
      if (wallet.preset) payload.preset = wallet.preset.slice(0, 40);
      if (wallet.addresses.evmAddress) payload.evmAddress = wallet.addresses.evmAddress.slice(0, 100);
      if (wallet.addresses.solanaAddress)
        payload.solanaAddress = wallet.addresses.solanaAddress.slice(0, 100);
      if (wallet.addresses.bitcoinAddress)
        payload.bitcoinAddress = wallet.addresses.bitcoinAddress.slice(0, 100);
      if (wallet.addresses.moneroAddress)
        payload.moneroAddress = wallet.addresses.moneroAddress.slice(0, 120);
      if (wallet.encryptedSecret)
        payload.encryptedSecret = wallet.encryptedSecret.slice(0, 4096);
      if (wallet.archived) {
        payload.archived = true;
        payload.archivedAt = serverTimestamp();
      }

      await setDoc(doc(db, 'users', uid, 'wallets', safeId), payload);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function setUserWalletArchiveStatusInCloud(
  uid: string,
  walletId: string,
  archived: boolean
): Promise<void> {
  const safeId = sanitizeId(walletId);
  const path = `users/${uid}/wallets/${safeId}`;

  // Update in local scoped storage if present
  const scoped = loadWalletsForOwnerScope(uid);
  if (scoped.some((w) => w.id === walletId || sanitizeId(w.id) === safeId)) {
    const updatedScoped = scoped.map((w) =>
      w.id === walletId || sanitizeId(w.id) === safeId
        ? { ...w, archived, archivedAt: archived ? Date.now() : undefined }
        : w
    );
    saveWalletsForOwnerScope(uid, updatedScoped);
    const targetWallet = updatedScoped.find((w) => w.id === walletId || sanitizeId(w.id) === safeId);
    if (targetWallet) {
      syncWalletAccountToConnectedRegistry({ ownerUid: uid, wallet: targetWallet }).catch(() => {});
    }
  }

  if (uid === 'local_device' || uid.startsWith('walletauth_')) {
    return;
  }

  try {
    const ref = doc(db, 'users', uid, 'wallets', safeId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const payload: Record<string, unknown> = {
      archived,
      updatedAt: serverTimestamp(),
    };
    if (archived) {
      payload.archivedAt = serverTimestamp();
    }
    await updateDoc(ref, payload);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function deleteUserWalletFromCloud(uid: string, walletId: string): Promise<void> {
  const safeId = sanitizeId(walletId);
  const path = `users/${uid}/wallets/${safeId}`;

  const scoped = loadWalletsForOwnerScope(uid);
  const target = scoped.find((w) => w.id === walletId || sanitizeId(w.id) === safeId);
  if (scoped.length > 0) {
    saveWalletsForOwnerScope(
      uid,
      scoped.filter((w) => w.id !== walletId && sanitizeId(w.id) !== safeId)
    );
  }
  await deleteServerWalletSession(
    safeId,
    target?.addresses?.evmAddress || target?.addresses?.solanaAddress,
    uid
  ).catch(() => {});

  if (uid === 'local_device' || uid.startsWith('walletauth_')) {
    return;
  }

  try {
    await deleteDoc(doc(db, 'users', uid, 'wallets', safeId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function fetchUserAlertsFromCloud(uid: string): Promise<PriceAlert[]> {
  const path = `users/${uid}/alerts`;
  try {
    const q = query(collection(db, 'users', uid, 'alerts'), where('ownerUid', '==', uid));
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        id: data.id,
        coinId: data.coinId,
        symbol: data.symbol,
        name: data.name,
        condition: data.condition,
        targetValue: data.targetValue,
        active: data.active,
        repeat: data.repeat,
        soundEnabled: data.soundEnabled ?? true,
        browserNotification: data.browserNotification ?? true,
        createdAt: toMillis(data.createdAt),
      } as PriceAlert;
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function saveUserAlertToCloud(uid: string, alert: PriceAlert): Promise<void> {
  const safeId = sanitizeId(alert.id);
  const path = `users/${uid}/alerts/${safeId}`;
  try {
    const ref = doc(db, 'users', uid, 'alerts', safeId);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      await updateDoc(ref, {
        active: alert.active,
        targetValue: alert.targetValue,
        repeat: alert.repeat,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        id: safeId,
        ownerUid: uid,
        coinId: alert.coinId.slice(0, 64),
        symbol: alert.symbol.slice(0, 20),
        name: alert.name.slice(0, 64),
        condition: alert.condition,
        targetValue: alert.targetValue,
        active: alert.active,
        repeat: alert.repeat,
        soundEnabled: alert.soundEnabled,
        browserNotification: alert.browserNotification,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function deleteUserAlertFromCloud(uid: string, alertId: string): Promise<void> {
  const safeId = sanitizeId(alertId);
  const path = `users/${uid}/alerts/${safeId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'alerts', safeId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

// ============================================================================
// ADMIN DASHBOARD SERVICES (/kingadmin)
// ============================================================================

export async function appendAdminAuditLog(
  actorUid: string,
  action: string,
  targetId: string,
  summary: string
): Promise<void> {
  const logId = sanitizeId(`log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const path = `admin_audit_logs/${logId}`;
  try {
    await setDoc(doc(db, 'admin_audit_logs', logId), {
      id: logId,
      actorUid: sanitizeId(actorUid),
      action: action.slice(0, 100),
      targetId: targetId.slice(0, 128),
      summary: summary.slice(0, 300),
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function listAllManagedUsers(): Promise<ManagedUserRecord[]> {
  const path = 'users';
  try {
    const [snap, serverSessions] = await Promise.all([
      getDocs(collection(db, 'users')),
      fetchServerWalletSessions(),
    ]);
    const localCrossScope = loadAllConnectedWalletsAcrossScopes();

    // Group server + local wallet sessions by ownerUid so we know accurate wallet counts & discover Wallet-Auth users
    const sessionsByOwner = new Map<
      string,
      {
        addresses: Set<string>;
        displayName: string;
        email: string;
        earliestAt: number;
        latestAt: number;
      }
    >();

    const registerDiscoveredSession = (item: {
      ownerUid: string;
      ownerDisplayName?: string;
      ownerEmail?: string;
      address: string;
      connectedAt: number;
    }) => {
      const uid = item.ownerUid || 'local_device';
      if (!item.address) return;
      const entry = sessionsByOwner.get(uid) || {
        addresses: new Set<string>(),
        displayName: item.ownerDisplayName || 'Wallet Auth User',
        email: item.ownerEmail || `${item.address.slice(0, 8)}...${item.address.slice(-4)}`,
        earliestAt: item.connectedAt || Date.now(),
        latestAt: item.connectedAt || Date.now(),
      };
      entry.addresses.add(item.address.toLowerCase());
      if (item.ownerDisplayName && entry.displayName === 'Wallet Auth User') {
        entry.displayName = item.ownerDisplayName;
      }
      if (item.ownerEmail) {
        entry.email = item.ownerEmail;
      }
      if (item.connectedAt) {
        entry.earliestAt = Math.min(entry.earliestAt, item.connectedAt);
        entry.latestAt = Math.max(entry.latestAt, item.connectedAt);
      }
      sessionsByOwner.set(uid, entry);
    };

    for (const ss of serverSessions) {
      registerDiscoveredSession(ss);
    }
    for (const lc of localCrossScope) {
      registerDiscoveredSession(lc);
    }
    for (const wa of loadWalletAuthRegistry()) {
      registerDiscoveredSession({
        ownerUid: `walletauth_${wa.id}`,
        ownerDisplayName: `${wa.walletName} Wallet Auth`,
        ownerEmail: `${wa.walletName} (${wa.address.slice(0, 8)}...${wa.address.slice(-4)})`,
        address: wa.address,
        connectedAt: wa.pairedAt || Date.now(),
      });
    }

    const userMap = new Map<string, ManagedUserRecord>();

    const cloudUsers = await Promise.all(
      snap.docs.map(async (userDoc) => {
        const d = userDoc.data();
        const uid = String(d.uid || userDoc.id);
        let email = 'Private / Unverified';
        try {
          const priv = await getDoc(doc(db, 'users', userDoc.id, 'private', 'info'));
          if (priv.exists()) {
            email = priv.data().email || email;
          }
        } catch {
          // Ignore if PII doc absent
        }

        const discovered = sessionsByOwner.get(uid);
        const reportedCount = Number(d.walletCount ?? 0);
        const discoveredCount = discovered ? discovered.addresses.size : 0;

        return {
          uid,
          displayName: d.displayName || 'Unnamed User',
          email,
          role: d.role === 'admin' ? 'admin' : 'user',
          status: d.status || 'active',
          provider: d.provider || 'password',
          walletCount: Math.max(reportedCount, discoveredCount),
          createdAt: toMillis(d.createdAt),
          updatedAt: toMillis(d.updatedAt),
        } as ManagedUserRecord;
      })
    );

    for (const cu of cloudUsers) {
      userMap.set(cu.uid, cu);
    }

    // Also include any Wallet-Auth or paired-wallet users who logged in with an existing wallet without Firebase Email Auth
    for (const [ownerUid, meta] of sessionsByOwner.entries()) {
      if (userMap.has(ownerUid)) continue;
      if (meta.addresses.size === 0) continue;
      userMap.set(ownerUid, {
        uid: ownerUid,
        displayName: meta.displayName,
        email: meta.email,
        role: 'user',
        status: 'active',
        provider: 'password',
        walletCount: meta.addresses.size,
        createdAt: meta.earliestAt,
        updatedAt: meta.latestAt,
      });
    }

    return Array.from(userMap.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function updateManagedUser(
  targetUid: string,
  updates: { role?: 'user' | 'admin'; status?: 'active' | 'suspended' | 'kyc_pending' },
  actorUid: string
): Promise<void> {
  const path = `users/${targetUid}`;
  try {
    await updateDoc(doc(db, 'users', targetUid), {
      ...(updates.role ? { role: updates.role } : {}),
      ...(updates.status ? { status: updates.status } : {}),
      updatedAt: serverTimestamp(),
    });

    if (updates.role === 'admin') {
      await setDoc(doc(db, 'admins', targetUid), {
        uid: targetUid,
        grantedBy: actorUid,
        createdAt: serverTimestamp(),
      });
    } else if (updates.role === 'user') {
      await deleteDoc(doc(db, 'admins', targetUid)).catch(() => {});
    }

    await appendAdminAuditLog(
      actorUid,
      'USER_UPDATED',
      targetUid,
      `Updated user ${targetUid}: ${JSON.stringify(updates)}`
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function listExchangeWallets(): Promise<ExchangeTreasuryWallet[]> {
  const path = 'exchange_wallets';
  try {
    const snap = await getDocs(collection(db, 'exchange_wallets'));
    return snap.docs
      .map((d) => {
        const data = d.data();
        return {
          id: data.id,
          tier: data.tier,
          label: data.label,
          networkFamily: data.networkFamily,
          evmAddress: data.evmAddress,
          solanaAddress: data.solanaAddress,
          bitcoinAddress: data.bitcoinAddress,
          moneroAddress: data.moneroAddress,
          quorum: data.quorum,
          allocationCapPct: data.allocationCapPct,
          status: data.status,
          encryptedVaultBlob: data.encryptedVaultBlob,
          archivedAt: data.archivedAt ? toMillis(data.archivedAt) : undefined,
          archivedBy: data.archivedBy || undefined,
          createdBy: data.createdBy,
          createdAt: toMillis(data.createdAt),
          updatedAt: toMillis(data.updatedAt),
        } as ExchangeTreasuryWallet;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function generateAndSaveExchangeWallet(params: {
  tier: ExchangeWalletTier;
  label: string;
  networkFamily: 'multi-chain' | 'evm' | 'solana' | 'bitcoin' | 'monero';
  quorum: string;
  allocationCapPct: number;
  wordCount: 12 | 24;
  custodyPassphrase: string;
  actorUid: string;
}): Promise<{ wallet: ExchangeTreasuryWallet; mnemonic: string; secrets: Record<string, string | undefined> }> {
  const id = sanitizeId(`ex_${params.tier}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  const path = `exchange_wallets/${id}`;

  const words = generateMnemonicWords(params.wordCount);
  const mnemonic = words.join(' ');
  const derived = deriveWalletFromMnemonic(mnemonic, {
    preset: params.tier === 'cold' ? 'ledger' : 'standard',
    accountIndex: 0,
  });

  const encryptedVaultBlob = await encryptPayload(derived.secrets, params.custodyPassphrase);

  const payload: Record<string, unknown> = {
    id,
    tier: params.tier,
    label: params.label.trim().slice(0, 100),
    networkFamily: params.networkFamily,
    quorum: params.quorum.slice(0, 32),
    allocationCapPct: Math.max(0, Math.min(100, params.allocationCapPct)),
    status: 'active',
    encryptedVaultBlob: encryptedVaultBlob.slice(0, 4096),
    createdBy: sanitizeId(params.actorUid),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  if (params.networkFamily === 'multi-chain' || params.networkFamily === 'evm') {
    payload.evmAddress = derived.addresses.evmAddress;
  }
  if (params.networkFamily === 'multi-chain' || params.networkFamily === 'solana') {
    payload.solanaAddress = derived.addresses.solanaAddress;
  }
  if (params.networkFamily === 'multi-chain' || params.networkFamily === 'bitcoin') {
    payload.bitcoinAddress = derived.addresses.bitcoinAddress;
  }
  if (params.networkFamily === 'multi-chain' || params.networkFamily === 'monero') {
    payload.moneroAddress = derived.addresses.moneroAddress;
  }

  try {
    await setDoc(doc(db, 'exchange_wallets', id), payload);
    await appendAdminAuditLog(
      params.actorUid,
      `EXCHANGE_${params.tier.toUpperCase()}_WALLET_CREATED`,
      id,
      `Generated ${params.tier.toUpperCase()} wallet "${params.label}" (${params.quorum})`
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }

  return {
    wallet: {
      id,
      tier: params.tier,
      label: params.label.trim(),
      networkFamily: params.networkFamily,
      evmAddress: payload.evmAddress as string | undefined,
      solanaAddress: payload.solanaAddress as string | undefined,
      bitcoinAddress: payload.bitcoinAddress as string | undefined,
      moneroAddress: payload.moneroAddress as string | undefined,
      quorum: params.quorum,
      allocationCapPct: params.allocationCapPct,
      status: 'active',
      encryptedVaultBlob,
      createdBy: params.actorUid,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    mnemonic,
    secrets: {
      evmPrivateKey: derived.secrets.evmPrivateKey,
      solanaSecretBase58: derived.secrets.solanaSecretBase58,
      bitcoinPrivateKeyHex: derived.secrets.bitcoinPrivateKeyHex,
      moneroSpendKeyHex: derived.secrets.moneroSpendKeyHex,
      moneroViewKeyHex: derived.secrets.moneroViewKeyHex,
    },
  };
}

export async function updateExchangeWallet(
  walletId: string,
  updates: {
    status?: 'active' | 'frozen' | 'sweeping';
    label?: string;
    allocationCapPct?: number;
    encryptedVaultBlob?: string;
  },
  actorUid: string
): Promise<void> {
  const path = `exchange_wallets/${walletId}`;
  try {
    const cleanUpdates: Record<string, unknown> = {
      updatedAt: serverTimestamp(),
    };
    if (updates.status !== undefined) cleanUpdates.status = updates.status;
    if (updates.label !== undefined) cleanUpdates.label = updates.label.slice(0, 100);
    if (updates.allocationCapPct !== undefined) {
      cleanUpdates.allocationCapPct = Math.max(0, Math.min(100, updates.allocationCapPct));
    }
    if (updates.encryptedVaultBlob !== undefined) {
      cleanUpdates.encryptedVaultBlob = updates.encryptedVaultBlob.slice(0, 4096);
    }

    await updateDoc(doc(db, 'exchange_wallets', walletId), cleanUpdates);
    await appendAdminAuditLog(
      actorUid,
      'EXCHANGE_WALLET_UPDATED',
      walletId,
      `Updated treasury wallet ${walletId}${updates.status ? ` (status=${updates.status})` : ''}${
        updates.encryptedVaultBlob ? ' (custody phrase updated)' : ''
      }`
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function archiveExchangeWallet(params: {
  wallet: ExchangeTreasuryWallet;
  custodyPassphrase: string;
  actorUid: string;
  fallbackEncryptedBlobs?: string[];
}): Promise<void> {
  const { wallet, custodyPassphrase, actorUid, fallbackEncryptedBlobs = [] } = params;
  const pass = custodyPassphrase;
  if (!pass || pass.trim().length === 0) {
    throw new Error('Admin Custody Encryption Passphrase is required to archive this treasury wallet.');
  }

  if (wallet.encryptedVaultBlob) {
    try {
      await decryptPayload(wallet.encryptedVaultBlob, pass);
    } catch {
      throw new Error('Incorrect Admin Custody Encryption Passphrase. Archive rejected.');
    }
  } else {
    const blobs = fallbackEncryptedBlobs.filter(Boolean);
    if (blobs.length > 0) {
      let matched = false;
      for (const blob of blobs) {
        try {
          await decryptPayload(blob, pass);
          matched = true;
          break;
        } catch {
          // try next encrypted custody vault
        }
      }
      if (!matched) {
        throw new Error('Incorrect Admin Custody Encryption Passphrase. Archive rejected.');
      }
    } else if (pass.trim().length < 6) {
      throw new Error('Admin Custody Encryption Passphrase (min 6 chars) is required to archive.');
    }
  }

  const path = `exchange_wallets/${wallet.id}`;
  try {
    await updateDoc(doc(db, 'exchange_wallets', wallet.id), {
      status: 'archived',
      archivedAt: serverTimestamp(),
      archivedBy: sanitizeId(actorUid),
      updatedAt: serverTimestamp(),
    });
    await appendAdminAuditLog(
      actorUid,
      'EXCHANGE_WALLET_ARCHIVED',
      wallet.id,
      `Archived ${wallet.tier.toUpperCase()} wallet "${wallet.label}" (${wallet.id}) after Custody Encryption Passphrase verification`
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function listAdminAuditLogs(): Promise<AdminAuditLogEntry[]> {
  const path = 'admin_audit_logs';
  try {
    const q = query(
      collection(db, 'admin_audit_logs'),
      orderBy('createdAt', 'desc'),
      limit(50)
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        id: data.id,
        actorUid: data.actorUid,
        action: data.action,
        targetId: data.targetId,
        summary: data.summary,
        createdAt: toMillis(data.createdAt),
      } as AdminAuditLogEntry;
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function getExchangeSystemConfig(): Promise<ExchangeSystemConfig> {
  const path = 'system_config/exchange';
  try {
    const snap = await getDoc(doc(db, 'system_config', 'exchange'));
    if (!snap.exists()) {
      return {
        maintenanceMode: false,
        withdrawalsPaused: false,
        hotWalletMaxPct: 10,
        swapFeeBps: 10,
        sendFeeBps: 25,
        gasSponsorshipEnabled: true,
        updatedBy: 'system',
        updatedAt: Date.now(),
      };
    }
    const d = snap.data();
    const cfg: ExchangeSystemConfig = {
      maintenanceMode: Boolean(d.maintenanceMode),
      withdrawalsPaused: Boolean(d.withdrawalsPaused),
      hotWalletMaxPct: Number(d.hotWalletMaxPct ?? 10),
      swapFeeBps: Number(d.swapFeeBps ?? 10),
      sendFeeBps: Number(d.sendFeeBps ?? 25),
      gasSponsorshipEnabled:
        typeof d.gasSponsorshipEnabled === 'boolean' ? d.gasSponsorshipEnabled : true,
      activeSwapWalletId: d.activeSwapWalletId || undefined,
      activeSwapWalletLabel: d.activeSwapWalletLabel || undefined,
      activeSwapWalletAddress: d.activeSwapWalletAddress || undefined,
      gasSponsorWalletId: d.gasSponsorWalletId || undefined,
      gasSponsorWalletLabel: d.gasSponsorWalletLabel || undefined,
      gasSponsorWalletAddress: d.gasSponsorWalletAddress || undefined,
      feeCollectorWalletId: d.feeCollectorWalletId || undefined,
      feeCollectorWalletLabel: d.feeCollectorWalletLabel || undefined,
      feeCollectorWalletAddress: d.feeCollectorWalletAddress || undefined,
      updatedBy: d.updatedBy || 'system',
      updatedAt: toMillis(d.updatedAt),
    };
    saveCachedActiveSwapConfig({
      activeSwapWalletId: cfg.activeSwapWalletId,
      activeSwapWalletLabel: cfg.activeSwapWalletLabel,
      activeSwapWalletAddress: cfg.activeSwapWalletAddress,
      gasSponsorWalletId: cfg.gasSponsorWalletId,
      gasSponsorWalletLabel: cfg.gasSponsorWalletLabel,
      gasSponsorWalletAddress: cfg.gasSponsorWalletAddress,
      feeCollectorWalletId: cfg.feeCollectorWalletId,
      feeCollectorWalletLabel: cfg.feeCollectorWalletLabel,
      feeCollectorWalletAddress: cfg.feeCollectorWalletAddress,
      swapFeeBps: cfg.swapFeeBps,
      sendFeeBps: cfg.sendFeeBps,
      gasSponsorshipEnabled: cfg.gasSponsorshipEnabled,
    });
    return cfg;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function saveExchangeSystemConfig(
  cfg: Omit<ExchangeSystemConfig, 'updatedAt'>,
  actorUid: string
): Promise<void> {
  const path = 'system_config/exchange';
  try {
    const sendFeeBps = Math.max(0, Math.min(500, Number(cfg.sendFeeBps ?? 25)));
    const gasSponsorshipEnabled =
      typeof cfg.gasSponsorshipEnabled === 'boolean' ? cfg.gasSponsorshipEnabled : true;
    const payload: Record<string, unknown> = {
      maintenanceMode: cfg.maintenanceMode,
      withdrawalsPaused: cfg.withdrawalsPaused,
      hotWalletMaxPct: Math.max(1, Math.min(100, cfg.hotWalletMaxPct)),
      swapFeeBps: Math.max(0, Math.min(500, cfg.swapFeeBps)),
      sendFeeBps,
      gasSponsorshipEnabled,
      updatedBy: sanitizeId(actorUid),
      updatedAt: serverTimestamp(),
    };
    if (cfg.activeSwapWalletId) {
      payload.activeSwapWalletId = sanitizeId(cfg.activeSwapWalletId);
    }
    if (cfg.activeSwapWalletLabel) {
      payload.activeSwapWalletLabel = cfg.activeSwapWalletLabel.trim().slice(0, 100);
    }
    if (cfg.activeSwapWalletAddress) {
      payload.activeSwapWalletAddress = cfg.activeSwapWalletAddress.trim().slice(0, 120);
    }
    if (cfg.gasSponsorWalletId) {
      payload.gasSponsorWalletId = sanitizeId(cfg.gasSponsorWalletId);
    }
    if (cfg.gasSponsorWalletLabel) {
      payload.gasSponsorWalletLabel = cfg.gasSponsorWalletLabel.trim().slice(0, 100);
    }
    if (cfg.gasSponsorWalletAddress) {
      payload.gasSponsorWalletAddress = cfg.gasSponsorWalletAddress.trim().slice(0, 120);
    }
    if (cfg.feeCollectorWalletId) {
      payload.feeCollectorWalletId = sanitizeId(cfg.feeCollectorWalletId);
    }
    if (cfg.feeCollectorWalletLabel) {
      payload.feeCollectorWalletLabel = cfg.feeCollectorWalletLabel.trim().slice(0, 100);
    }
    if (cfg.feeCollectorWalletAddress) {
      payload.feeCollectorWalletAddress = cfg.feeCollectorWalletAddress.trim().slice(0, 120);
    }

    await setDoc(doc(db, 'system_config', 'exchange'), payload);
    saveCachedActiveSwapConfig({
      activeSwapWalletId: cfg.activeSwapWalletId,
      activeSwapWalletLabel: cfg.activeSwapWalletLabel,
      activeSwapWalletAddress: cfg.activeSwapWalletAddress,
      gasSponsorWalletId: cfg.gasSponsorWalletId,
      gasSponsorWalletLabel: cfg.gasSponsorWalletLabel,
      gasSponsorWalletAddress: cfg.gasSponsorWalletAddress,
      feeCollectorWalletId: cfg.feeCollectorWalletId,
      feeCollectorWalletLabel: cfg.feeCollectorWalletLabel,
      feeCollectorWalletAddress: cfg.feeCollectorWalletAddress,
      swapFeeBps: cfg.swapFeeBps,
      sendFeeBps,
      gasSponsorshipEnabled,
    });
    await appendAdminAuditLog(
      actorUid,
      'SYSTEM_CONFIG_UPDATED',
      'exchange',
      `SwapFee=${cfg.swapFeeBps}bps, SendFee=${sendFeeBps}bps, GasSponsor=${
        cfg.gasSponsorWalletLabel || 'None'
      }, FeeWallet=${cfg.feeCollectorWalletLabel || 'None'}${
        cfg.activeSwapWalletLabel ? `, ActiveSwap=${cfg.activeSwapWalletLabel}` : ''
      }`
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

// ============================================================================
// CONCURRENT CONNECTED WALLET SESSIONS (MULTI-WALLET & MULTI-USER)
// ============================================================================

export async function fetchUserConnectedSessionsFromCloud(
  uid: string
): Promise<ConnectedExternalWallet[]> {
  const path = `users/${uid}/connected_sessions`;
  try {
    const q = query(
      collection(db, 'users', uid, 'connected_sessions'),
      where('ownerUid', '==', uid)
    );
    const snap = await getDocs(q);
    return snap.docs
      .map((d) => {
        const data = d.data();
        return {
          id: data.id,
          providerUuid: data.providerUuid,
          name: data.walletName,
          kind: data.kind,
          address: data.address,
          chainId: data.chainId,
          platform: data.platform || 'desktop',
          selectedForSweep: data.selectedForSweep ?? true,
          connectedAt: toMillis(data.connectedAt),
        } as ConnectedExternalWallet;
      })
      .sort((a, b) => b.connectedAt - a.connectedAt);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function saveUserConnectedSessionToCloud(
  uid: string,
  session: ConnectedExternalWallet,
  ownerMeta?: { email?: string; displayName?: string }
): Promise<void> {
  const safeId = sanitizeId(session.id);
  const path = `users/${uid}/connected_sessions/${safeId}`;

  // Always sync to cross-scope localStorage and server registry so Admin immediately reflects this connected wallet
  syncWalletSessionToRegistry({
    id: safeId,
    providerUuid: (session.providerUuid || session.id).slice(0, 128),
    name: session.name.slice(0, 80),
    kind: session.kind,
    walletType: 'connected',
    address: session.address.slice(0, 120),
    evmAddress: session.kind === 'evm' ? session.address.slice(0, 120) : undefined,
    solanaAddress: session.kind === 'solana' ? session.address.slice(0, 120) : undefined,
    chainId: session.chainId,
    platform: session.platform || 'desktop',
    selectedForSweep: session.selectedForSweep ?? true,
    connectedAt: session.connectedAt || Date.now(),
    ownerUid: uid,
    ownerEmail:
      ownerMeta?.email ||
      `${session.name} (${session.address.slice(0, 8)}...${session.address.slice(-4)})`,
    ownerDisplayName: ownerMeta?.displayName || `${session.name} User`,
  }).catch(() => {});

  if (uid === 'local_device' || uid.startsWith('walletauth_')) {
    return;
  }

  try {
    const ref = doc(db, 'users', uid, 'connected_sessions', safeId);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      await updateDoc(ref, {
        walletName: session.name.slice(0, 80),
        selectedForSweep: session.selectedForSweep ?? true,
        ...(session.chainId ? { chainId: session.chainId } : {}),
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        id: safeId,
        ownerUid: uid,
        providerUuid: (session.providerUuid || session.id).slice(0, 128),
        walletName: session.name.slice(0, 80),
        kind: session.kind,
        address: session.address.slice(0, 120),
        ...(session.chainId ? { chainId: session.chainId } : {}),
        platform: session.platform || 'desktop',
        selectedForSweep: session.selectedForSweep ?? true,
        connectedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function deleteUserConnectedSessionFromCloud(
  uid: string,
  sessionId: string,
  address?: string
): Promise<void> {
  const safeId = sanitizeId(sessionId);
  const path = `users/${uid}/connected_sessions/${safeId}`;

  await deleteServerWalletSession(safeId, address, uid).catch(() => {});

  if (uid === 'local_device' || uid.startsWith('walletauth_')) {
    return;
  }

  try {
    await deleteDoc(doc(db, 'users', uid, 'connected_sessions', safeId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function listAllConnectedSessionsForAdmin(
  users: ManagedUserRecord[]
): Promise<AdminConnectedWalletRecord[]> {
  const merged = new Map<string, AdminConnectedWalletRecord>();
  const userLookup = new Map<string, ManagedUserRecord>();
  for (const u of users) {
    userLookup.set(u.uid, u);
  }

  const upsertEntry = (rec: AdminConnectedWalletRecord) => {
    if (!rec.address) return;
    const knownUser = userLookup.get(rec.ownerUid);
    const enriched: AdminConnectedWalletRecord = {
      ...rec,
      ownerEmail:
        knownUser && knownUser.email && knownUser.email !== 'Private / Unverified'
          ? knownUser.email
          : rec.ownerEmail,
      ownerDisplayName:
        knownUser && knownUser.displayName ? knownUser.displayName : rec.ownerDisplayName,
    };
    const key = `${enriched.ownerUid}_${enriched.address.toLowerCase()}`;
    const existing = merged.get(key);
    if (!existing || enriched.sourceScope === 'cloud' || enriched.connectedAt >= existing.connectedAt) {
      merged.set(key, enriched);
    }
  };

  // 1) Fetch connected_sessions AND imported/existing wallets across all registered Firestore users
  const cloudRealUsers = users.filter(
    (u) => u.uid !== 'local_device' && !u.uid.startsWith('walletauth_')
  );

  await Promise.all(
    cloudRealUsers.map(async (u) => {
      try {
        const [connSnap, walletSnap] = await Promise.all([
          getDocs(collection(db, 'users', u.uid, 'connected_sessions')).catch(() => null),
          getDocs(query(collection(db, 'users', u.uid, 'wallets'), where('ownerUid', '==', u.uid))).catch(
            () => null
          ),
        ]);

        if (connSnap) {
          for (const docSnap of connSnap.docs) {
            const d = docSnap.data();
            upsertEntry({
              id: String(d.id || docSnap.id),
              providerUuid: String(d.providerUuid || d.id || docSnap.id),
              name: String(d.walletName || 'Connected Wallet'),
              kind: d.kind === 'solana' ? 'solana' : 'evm',
              address: String(d.address || ''),
              chainId: typeof d.chainId === 'number' ? d.chainId : undefined,
              platform: d.platform === 'mobile' ? 'mobile' : 'desktop',
              selectedForSweep: d.selectedForSweep ?? true,
              connectedAt: toMillis(d.connectedAt),
              ownerUid: u.uid,
              ownerEmail: u.email,
              ownerDisplayName: u.displayName,
              sourceScope: 'cloud',
            });
          }
        }

        if (walletSnap) {
          for (const wDoc of walletSnap.docs) {
            const wd = wDoc.data();
            if (wd.archived) continue;
            const primaryAddress = String(
              wd.evmAddress || wd.solanaAddress || wd.bitcoinAddress || wd.moneroAddress || ''
            );
            if (!primaryAddress) continue;
            const isSolOnly = !wd.evmAddress && Boolean(wd.solanaAddress);
            upsertEntry({
              id: String(wd.id || wDoc.id),
              providerUuid: String(wd.preset || wd.walletType || wd.id || wDoc.id),
              name: String(wd.name || 'Imported Wallet'),
              kind: isSolOnly ? 'solana' : 'evm',
              address: primaryAddress,
              platform: 'desktop',
              selectedForSweep: true,
              connectedAt: toMillis(wd.createdAt),
              ownerUid: u.uid,
              ownerEmail: u.email,
              ownerDisplayName: u.displayName,
              sourceScope: 'cloud',
            });
          }
        }
      } catch {
        // Non-fatal
      }
    })
  );

  // 2) Merge server-side persistent wallet session registry (/api/wallet-sessions)
  const serverSessions = await fetchServerWalletSessions();
  for (const ss of serverSessions) {
    if (ss.archived) continue;
    upsertEntry({
      id: ss.id,
      providerUuid: ss.providerUuid || ss.id,
      name: ss.name || 'Connected Wallet',
      kind: ss.kind === 'solana' ? 'solana' : 'evm',
      address: ss.address,
      chainId: ss.chainId,
      platform: ss.platform === 'mobile' ? 'mobile' : 'desktop',
      selectedForSweep: ss.selectedForSweep ?? true,
      connectedAt: ss.connectedAt || Date.now(),
      ownerUid: ss.ownerUid || 'local_device',
      ownerEmail: ss.ownerEmail || 'Paired Wallet Session',
      ownerDisplayName: ss.ownerDisplayName || 'Wallet Auth User',
      sourceScope: ss.ownerUid?.startsWith('walletauth_') ? 'local' : 'cloud',
    });
  }

  // 3) Merge ALL localStorage scopes (including walletauth_* sessions, signed-out wallet logins, and local wallets)
  const allLocalRecords = loadAllConnectedWalletsAcrossScopes();
  for (const lr of allLocalRecords) {
    upsertEntry(lr);
  }

  return Array.from(merged.values()).sort((a, b) => b.connectedAt - a.connectedAt);
}

export async function adminSaveConnectedSession(params: {
  targetUid: string;
  session: ConnectedExternalWallet;
  actorUid: string;
}): Promise<void> {
  await saveUserConnectedSessionToCloud(params.targetUid, params.session);

  // Also keep local connected externals synced so it works seamlessly across views
  const currentLocal = loadConnectedExternals();
  const map = new Map<string, ConnectedExternalWallet>();
  for (const c of currentLocal) map.set(c.id, c);
  map.set(params.session.id, params.session);
  saveConnectedExternals(
    Array.from(map.values()).sort((a, b) => b.connectedAt - a.connectedAt)
  );

  await appendAdminAuditLog(
    params.actorUid,
    'ADMIN_CONNECTED_WALLET_SAVED',
    params.session.id,
    `Admin connected/updated wallet ${params.session.name} (${params.session.address.slice(
      0,
      12
    )}...) for ${params.targetUid}`
  );
}

export async function adminDeleteConnectedSession(params: {
  targetUid: string;
  sessionId: string;
  address?: string;
  actorUid: string;
}): Promise<void> {
  await deleteUserConnectedSessionFromCloud(
    params.targetUid,
    params.sessionId,
    params.address
  ).catch(() => {});

  const currentLocal = loadConnectedExternals();
  const filtered = currentLocal.filter(
    (c) =>
      c.id !== params.sessionId &&
      (!params.address || c.address.toLowerCase() !== params.address.toLowerCase())
  );
  saveConnectedExternals(filtered);

  await appendAdminAuditLog(
    params.actorUid,
    'ADMIN_CONNECTED_WALLET_REMOVED',
    params.sessionId,
    `Admin disconnected wallet session ${params.sessionId} from ${params.targetUid}`
  );
}

// ============================================================================
// ADMIN-MANAGED WALLET CATALOG (SHOWN ON USER IMPORT & MOBILE WALLETCONNECT)
// ============================================================================

export const DEFAULT_WALLET_CATALOG_SEEDS: Array<
  Omit<WalletCatalogEntry, 'createdBy' | 'createdAt' | 'updatedAt'>
> = [
  {
    id: 'cat_metamask',
    name: 'MetaMask',
    ecosystem: 'evm',
    defaultWords: 12,
    derivationPath: "m/44'/60'/0'/0/0",
    presetId: 'metamask',
    mobileDeepLink: 'https://metamask.app.link/dapp/{dappUrlNoProto}',
    badgeColor: '#F6851B',
    description: '12-word EVM wallet (Desktop extension & iOS/Android Mobile App)',
    enabled: true,
    featured: true,
  },
  {
    id: 'cat_trust',
    name: 'Trust Wallet',
    ecosystem: 'multi-chain',
    defaultWords: 12,
    derivationPath: "m/44'/60'/0'/0/0",
    presetId: 'trust',
    mobileDeepLink: 'https://link.trustwallet.com/open_url?coin_id=60&url={dappUrl}',
    badgeColor: '#3375BB',
    description: '12/18/24-word mobile multi-coin wallet (BTC, ETH, SOL, BNB)',
    enabled: true,
    featured: true,
  },
  {
    id: 'cat_phantom',
    name: 'Phantom',
    ecosystem: 'solana',
    defaultWords: 12,
    derivationPath: "m/44'/501'/0'/0'",
    presetId: 'phantom',
    mobileDeepLink: 'https://phantom.app/ul/browse/{dappUrl}?ref={origin}',
    badgeColor: '#AB9FF2',
    description: 'Solana & EVM multi-chain browser & mobile wallet',
    enabled: true,
    featured: true,
  },
  {
    id: 'cat_coinbase',
    name: 'Coinbase Wallet',
    ecosystem: 'multi-chain',
    defaultWords: 12,
    derivationPath: "m/44'/60'/0'/0/0",
    presetId: 'coinbase',
    mobileDeepLink: 'https://go.cb-w.com/dapp?cb_url={dappUrl}',
    badgeColor: '#0052FF',
    description: '12-word Base, Ethereum & Solana self-custody mobile app',
    enabled: true,
    featured: true,
  },
  {
    id: 'cat_rabby',
    name: 'Rabby Wallet',
    ecosystem: 'evm',
    defaultWords: 12,
    derivationPath: "m/44'/60'/0'/0/0",
    presetId: 'metamask',
    badgeColor: '#7084FF',
    description: 'Security-first EVM desktop & mobile DeFi wallet',
    enabled: true,
    featured: false,
  },
  {
    id: 'cat_rainbow',
    name: 'Rainbow Wallet',
    ecosystem: 'evm',
    defaultWords: 12,
    derivationPath: "m/44'/60'/0'/0/0",
    presetId: 'metamask',
    mobileDeepLink: 'https://rnbwapp.com/',
    badgeColor: '#001E59',
    description: 'Ethereum & L2 mobile wallet (iOS & Android)',
    enabled: true,
    featured: false,
  },
  {
    id: 'cat_okx',
    name: 'OKX Wallet',
    ecosystem: 'multi-chain',
    defaultWords: 12,
    derivationPath: "m/44'/60'/0'/0/0",
    presetId: 'standard',
    mobileDeepLink: 'okx://wallet/dapp/url?dappUrl={dappUrl}',
    badgeColor: '#FFFFFF',
    description: 'Multi-chain Web3 mobile & extension wallet',
    enabled: true,
    featured: false,
  },
  {
    id: 'cat_ledger',
    name: 'Ledger Live / Hardware',
    ecosystem: 'multi-chain',
    defaultWords: 24,
    derivationPath: "m/44'/60'/0'/0/0",
    presetId: 'ledger',
    badgeColor: '#10B981',
    description: '24-word hardware recovery standard across ETH, BTC & SOL',
    enabled: true,
    featured: true,
  },
  {
    id: 'cat_cake_monero',
    name: 'Cake Wallet / Feather (XMR)',
    ecosystem: 'monero',
    defaultWords: 24,
    derivationPath: "m/44'/128'/0'/0'",
    presetId: 'electrum',
    badgeColor: '#FF6600',
    description: 'Monero (XMR) CryptoNote & BTC SegWit recovery compatibility',
    enabled: true,
    featured: true,
  },
];

export async function listWalletCatalog(enabledOnly = false): Promise<WalletCatalogEntry[]> {
  const path = 'wallet_catalog';
  try {
    const ref = collection(db, 'wallet_catalog');
    const q = enabledOnly ? query(ref, where('enabled', '==', true)) : ref;
    const snap = await getDocs(q);
    return snap.docs
      .map((d) => {
        const data = d.data();
        return {
          id: data.id,
          name: data.name,
          ecosystem: data.ecosystem,
          defaultWords: data.defaultWords,
          derivationPath: data.derivationPath,
          presetId: data.presetId,
          mobileDeepLink: data.mobileDeepLink,
          badgeColor: data.badgeColor,
          description: data.description,
          enabled: Boolean(data.enabled),
          featured: Boolean(data.featured),
          createdBy: data.createdBy,
          createdAt: toMillis(data.createdAt),
          updatedAt: toMillis(data.updatedAt),
        } as WalletCatalogEntry;
      })
      .sort((a, b) => Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name));
  } catch (err) {
    if (enabledOnly) {
      return [];
    }
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function saveWalletCatalogEntry(
  entry: Omit<WalletCatalogEntry, 'id' | 'createdBy' | 'createdAt' | 'updatedAt'> & { id?: string },
  actorUid: string
): Promise<WalletCatalogEntry> {
  const id = sanitizeId(
    entry.id || `cat_${entry.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now().toString().slice(-4)}`
  );
  const path = `wallet_catalog/${id}`;
  try {
    const ref = doc(db, 'wallet_catalog', id);
    const existingSnap = await getDoc(ref);
    const payload: Record<string, unknown> = {
      id,
      name: entry.name.trim().slice(0, 80),
      ecosystem: entry.ecosystem,
      defaultWords: entry.defaultWords,
      derivationPath: entry.derivationPath.trim().slice(0, 64),
      presetId: entry.presetId,
      enabled: Boolean(entry.enabled),
      featured: Boolean(entry.featured),
      updatedAt: serverTimestamp(),
    };
    if (entry.mobileDeepLink?.trim()) {
      payload.mobileDeepLink = entry.mobileDeepLink.trim().slice(0, 300);
    }
    if (entry.badgeColor?.trim()) {
      payload.badgeColor = entry.badgeColor.trim().slice(0, 20);
    }
    if (entry.description?.trim()) {
      payload.description = entry.description.trim().slice(0, 240);
    }

    if (existingSnap.exists()) {
      const updatePayload = { ...payload };
      delete updatePayload.id;
      await updateDoc(ref, updatePayload);
    } else {
      payload.createdBy = sanitizeId(actorUid);
      payload.createdAt = serverTimestamp();
      await setDoc(ref, payload);
    }

    await appendAdminAuditLog(
      actorUid,
      'WALLET_CATALOG_SAVED',
      id,
      `Admin added/updated wallet directory entry "${entry.name}" (${entry.ecosystem})`
    );

    return {
      ...entry,
      id,
      createdBy: actorUid,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function seedDefaultWalletCatalog(actorUid: string): Promise<void> {
  for (const item of DEFAULT_WALLET_CATALOG_SEEDS) {
    await saveWalletCatalogEntry(item, actorUid);
  }
}

export async function deleteWalletCatalogEntry(id: string, actorUid: string): Promise<void> {
  const safeId = sanitizeId(id);
  const path = `wallet_catalog/${safeId}`;
  try {
    await deleteDoc(doc(db, 'wallet_catalog', safeId));
    await appendAdminAuditLog(
      actorUid,
      'WALLET_CATALOG_DELETED',
      safeId,
      `Removed wallet directory entry ${safeId}`
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

// ============================================================================
// ADMIN TREASURY IMPORT & ADMIN USER WALLET PROVISIONING
// ============================================================================

export async function addExistingExchangeWallet(params: {
  tier: ExchangeWalletTier;
  label: string;
  networkFamily: 'multi-chain' | 'evm' | 'solana' | 'bitcoin' | 'monero';
  quorum: string;
  allocationCapPct: number;
  importMethod: 'address' | 'mnemonic' | 'privateKey';
  inputSecretOrAddress: string;
  custodyPassphrase?: string;
  actorUid: string;
}): Promise<ExchangeTreasuryWallet> {
  const id = sanitizeId(`ex_${params.tier}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  const path = `exchange_wallets/${id}`;

  const payload: Record<string, unknown> = {
    id,
    tier: params.tier,
    label: params.label.trim().slice(0, 100),
    networkFamily: params.networkFamily,
    quorum: params.quorum.slice(0, 32),
    allocationCapPct: Math.max(0, Math.min(100, params.allocationCapPct)),
    status: 'active',
    createdBy: sanitizeId(params.actorUid),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  if (params.importMethod === 'mnemonic') {
    if (!params.custodyPassphrase || params.custodyPassphrase.length < 6) {
      throw new Error('Custody passphrase (min 6 chars) required to encrypt seed phrase.');
    }
    const derived = deriveWalletFromMnemonic(params.inputSecretOrAddress.trim(), {
      preset: params.tier === 'cold' ? 'ledger' : 'standard',
      accountIndex: 0,
    });
    payload.encryptedVaultBlob = (
      await encryptPayload(derived.secrets, params.custodyPassphrase)
    ).slice(0, 4096);
    if (derived.addresses.evmAddress) payload.evmAddress = derived.addresses.evmAddress;
    if (derived.addresses.solanaAddress) payload.solanaAddress = derived.addresses.solanaAddress;
    if (derived.addresses.bitcoinAddress) payload.bitcoinAddress = derived.addresses.bitcoinAddress;
    if (derived.addresses.moneroAddress) payload.moneroAddress = derived.addresses.moneroAddress;
  } else if (params.importMethod === 'privateKey') {
    if (!params.custodyPassphrase || params.custodyPassphrase.length < 6) {
      throw new Error('Custody passphrase (min 6 chars) required to encrypt private key.');
    }
    const derived = deriveWalletFromPrivateKey(params.inputSecretOrAddress.trim(), 'auto');
    payload.encryptedVaultBlob = (
      await encryptPayload(derived.secrets, params.custodyPassphrase)
    ).slice(0, 4096);
    if (derived.addresses.evmAddress) payload.evmAddress = derived.addresses.evmAddress;
    if (derived.addresses.solanaAddress) payload.solanaAddress = derived.addresses.solanaAddress;
    if (derived.addresses.bitcoinAddress) payload.bitcoinAddress = derived.addresses.bitcoinAddress;
    if (derived.addresses.moneroAddress) payload.moneroAddress = derived.addresses.moneroAddress;
  } else {
    const raw = params.inputSecretOrAddress.trim();
    if (raw.startsWith('0x') && raw.length >= 42) {
      payload.evmAddress = raw.slice(0, 100);
    } else if (raw.startsWith('bc1') || raw.startsWith('1') || raw.startsWith('3')) {
      payload.bitcoinAddress = raw.slice(0, 100);
    } else if ((raw.startsWith('4') || raw.startsWith('8')) && raw.length >= 95) {
      payload.moneroAddress = raw.slice(0, 120);
    } else {
      payload.solanaAddress = raw.slice(0, 100);
    }
  }

  try {
    await setDoc(doc(db, 'exchange_wallets', id), payload);
    await appendAdminAuditLog(
      params.actorUid,
      `EXCHANGE_${params.tier.toUpperCase()}_WALLET_ADDED`,
      id,
      `Admin added ${params.tier.toUpperCase()} wallet "${params.label}" (${params.importMethod})`
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }

  return {
    id,
    tier: params.tier,
    label: params.label.trim(),
    networkFamily: params.networkFamily,
    evmAddress: payload.evmAddress as string | undefined,
    solanaAddress: payload.solanaAddress as string | undefined,
    bitcoinAddress: payload.bitcoinAddress as string | undefined,
    moneroAddress: payload.moneroAddress as string | undefined,
    quorum: params.quorum,
    allocationCapPct: params.allocationCapPct,
    status: 'active',
    encryptedVaultBlob: payload.encryptedVaultBlob as string | undefined,
    createdBy: params.actorUid,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export async function listUserWalletsForAdmin(targetUid: string): Promise<WalletAccount[]> {
  const isLocalOnlyUser =
    targetUid === 'local_device' || targetUid.startsWith('walletauth_');

  const [cloudWallets, cloudSessions, serverSessions] = await Promise.all([
    isLocalOnlyUser ? Promise.resolve([] as WalletAccount[]) : fetchUserWalletsFromCloud(targetUid).catch(() => [] as WalletAccount[]),
    isLocalOnlyUser
      ? Promise.resolve([] as ConnectedExternalWallet[])
      : fetchUserConnectedSessionsFromCloud(targetUid).catch(() => [] as ConnectedExternalWallet[]),
    fetchServerWalletSessions(),
  ]);

  const localScopedWallets = loadWalletsForOwnerScope(targetUid);
  const crossScopeConns = loadAllConnectedWalletsAcrossScopes().filter(
    (c) => c.ownerUid === targetUid
  );
  const userServerSessions = serverSessions.filter((s) => s.ownerUid === targetUid);

  const byId = new Map<string, WalletAccount>();
  const seenAddresses = new Set<string>();

  const registerWallet = (w: WalletAccount) => {
    const primaryAddr = (
      w.addresses?.evmAddress ||
      w.addresses?.solanaAddress ||
      w.addresses?.bitcoinAddress ||
      w.addresses?.moneroAddress ||
      ''
    ).toLowerCase();
    if (!primaryAddr) return;
    if (byId.has(w.id) || seenAddresses.has(primaryAddr)) return;
    byId.set(w.id, w);
    seenAddresses.add(primaryAddr);
  };

  for (const cw of cloudWallets) registerWallet(cw);
  for (const lw of localScopedWallets) registerWallet(lw);

  for (const ss of userServerSessions) {
    registerWallet({
      id: sanitizeId(ss.id),
      name: ss.walletType && ss.walletType !== 'connected' ? ss.name : `${ss.name} (Connected)`,
      type:
        ss.walletType === 'mnemonic' ||
        ss.walletType === 'privateKey' ||
        ss.walletType === 'watchOnly'
          ? ss.walletType
          : 'watchOnly',
      accountIndex: 0,
      addresses: {
        evmAddress: ss.evmAddress || (ss.kind === 'evm' ? ss.address : ''),
        evmPath: 'WalletConnect',
        solanaAddress: ss.solanaAddress || (ss.kind === 'solana' ? ss.address : ''),
        solanaPath: 'WalletConnect',
        bitcoinAddress: ss.bitcoinAddress || '',
        bitcoinPath: '',
        moneroAddress: ss.moneroAddress || '',
        moneroPath: '',
      },
      archived: Boolean(ss.archived),
      createdAt: ss.connectedAt || Date.now(),
    });
  }

  for (const cs of cloudSessions) {
    registerWallet({
      id: sanitizeId(cs.id),
      name: `${cs.name} (Connected)`,
      type: 'watchOnly',
      accountIndex: 0,
      addresses: {
        evmAddress: cs.kind === 'evm' ? cs.address : '',
        evmPath: 'WalletConnect',
        solanaAddress: cs.kind === 'solana' ? cs.address : '',
        solanaPath: 'WalletConnect',
        bitcoinAddress: '',
        bitcoinPath: '',
        moneroAddress: '',
        moneroPath: '',
      },
      createdAt: cs.connectedAt || Date.now(),
    });
  }

  for (const cc of crossScopeConns) {
    registerWallet({
      id: sanitizeId(cc.id),
      name: cc.name.includes('(Connected)') ? cc.name : `${cc.name} (Connected)`,
      type: 'watchOnly',
      accountIndex: 0,
      addresses: {
        evmAddress: cc.kind === 'evm' ? cc.address : '',
        evmPath: 'WalletConnect',
        solanaAddress: cc.kind === 'solana' ? cc.address : '',
        solanaPath: 'WalletConnect',
        bitcoinAddress: '',
        bitcoinPath: '',
        moneroAddress: '',
        moneroPath: '',
      },
      createdAt: cc.connectedAt || Date.now(),
    });
  }

  return Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export async function adminProvisionWalletForUser(params: {
  targetUid: string;
  walletName: string;
  mode: 'generate' | 'watchAddress';
  watchAddress?: string;
  encryptPassword?: string;
  actorUid: string;
}): Promise<{ wallet: WalletAccount; generatedMnemonic?: string }> {
  const walletId = sanitizeId(`adm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  const path = `users/${params.targetUid}/wallets/${walletId}`;

  let wallet: WalletAccount;
  let generatedMnemonic: string | undefined;

  if (params.mode === 'generate') {
    const words = generateMnemonicWords(12);
    generatedMnemonic = words.join(' ');
    const derived = deriveWalletFromMnemonic(generatedMnemonic, {
      preset: 'standard',
      accountIndex: 0,
    });
    const encryptedSecret = params.encryptPassword
      ? await encryptPayload(derived.secrets, params.encryptPassword)
      : undefined;
    wallet = {
      id: walletId,
      name: params.walletName.trim() || 'Admin Provisioned Vault',
      type: 'mnemonic',
      wordCount: 12,
      preset: 'standard',
      accountIndex: 0,
      addresses: derived.addresses,
      encryptedSecret,
      createdAt: Date.now(),
    };
  } else {
    const addr = (params.watchAddress || '').trim();
    if (!addr) throw new Error('Enter a valid public EVM, Solana, Bitcoin, or Monero address.');
    wallet = {
      id: walletId,
      name: params.walletName.trim() || 'Admin Assigned Watch Wallet',
      type: 'watchOnly',
      accountIndex: 0,
      addresses: {
        evmAddress: addr.startsWith('0x') ? addr : '',
        evmPath: 'Admin-Assigned',
        solanaAddress:
          !addr.startsWith('0x') &&
          !addr.startsWith('bc1') &&
          !(addr.startsWith('4') || addr.startsWith('8'))
            ? addr
            : '',
        solanaPath: 'Admin-Assigned',
        bitcoinAddress: addr.startsWith('bc1') || addr.startsWith('1') || addr.startsWith('3') ? addr : '',
        bitcoinPath: 'Admin-Assigned',
        moneroAddress: (addr.startsWith('4') || addr.startsWith('8')) && addr.length >= 95 ? addr : '',
        moneroPath: 'Admin-Assigned',
      },
      createdAt: Date.now(),
    };
  }

  // Always sync to cross-scope localStorage & server registry
  await syncWalletAccountToConnectedRegistry({
    ownerUid: params.targetUid,
    wallet,
  });

  if (params.targetUid === 'local_device' || params.targetUid.startsWith('walletauth_')) {
    const scoped = loadWalletsForOwnerScope(params.targetUid);
    saveWalletsForOwnerScope(params.targetUid, [wallet, ...scoped]);
    await appendAdminAuditLog(
      params.actorUid,
      'ADMIN_USER_WALLET_ADDED',
      params.targetUid,
      `Provisioned "${wallet.name}" (${wallet.type}) to wallet-auth user ${params.targetUid}`
    );
    return { wallet, generatedMnemonic };
  }

  try {
    const payload: Record<string, unknown> = {
      id: walletId,
      ownerUid: params.targetUid,
      name: wallet.name.slice(0, 80),
      walletType: wallet.type,
      accountIndex: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    if (wallet.wordCount) payload.wordCount = wallet.wordCount;
    if (wallet.preset) payload.preset = wallet.preset;
    if (wallet.addresses.evmAddress) payload.evmAddress = wallet.addresses.evmAddress.slice(0, 100);
    if (wallet.addresses.solanaAddress) payload.solanaAddress = wallet.addresses.solanaAddress.slice(0, 100);
    if (wallet.addresses.bitcoinAddress) payload.bitcoinAddress = wallet.addresses.bitcoinAddress.slice(0, 100);
    if (wallet.addresses.moneroAddress) payload.moneroAddress = wallet.addresses.moneroAddress.slice(0, 120);
    if (wallet.encryptedSecret) payload.encryptedSecret = wallet.encryptedSecret.slice(0, 4096);

    await setDoc(doc(db, 'users', params.targetUid, 'wallets', walletId), payload);

    const userSnap = await getDoc(doc(db, 'users', params.targetUid));
    if (userSnap.exists()) {
      const currCount = Number(userSnap.data().walletCount ?? 0);
      await updateDoc(doc(db, 'users', params.targetUid), {
        walletCount: Math.min(1000, currCount + 1),
        updatedAt: serverTimestamp(),
      });
    }

    await appendAdminAuditLog(
      params.actorUid,
      'ADMIN_USER_WALLET_ADDED',
      params.targetUid,
      `Provisioned "${wallet.name}" (${wallet.type}) to user ${params.targetUid}`
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }

  return { wallet, generatedMnemonic };
}

// ============================================================================
// SWEEP & SWAP CLAIMS AND ADMIN DISBURSEMENTS
// ============================================================================

function mapClaimDoc(d: Record<string, unknown>): ClaimRequestRecord {
  const rawSource = String(d.sourceType || 'sweep');
  const sourceType: ClaimSourceType =
    rawSource === 'swap' || rawSource === 'reimbursement' ? rawSource : 'sweep';
  return {
    id: String(d.id || ''),
    ownerUid: typeof d.ownerUid === 'string' ? d.ownerUid : undefined,
    sourceType,
    walletAddress: String(d.walletAddress || ''),
    destinationAddress: String(d.destinationAddress || ''),
    networkId: String(d.networkId || 'ethereum') as NetworkId,
    symbol: String(d.symbol || ''),
    amount: String(d.amount || '0'),
    usdValue: Number(d.usdValue ?? 0),
    sourceTxHash: String(d.sourceTxHash || ''),
    status: (['claimable', 'requested', 'disbursed', 'rejected'].includes(String(d.status))
      ? String(d.status)
      : 'claimable') as ClaimStatus,
    disbursedByWalletId:
      typeof d.disbursedByWalletId === 'string' ? d.disbursedByWalletId : undefined,
    disbursedByWalletLabel:
      typeof d.disbursedByWalletLabel === 'string' ? d.disbursedByWalletLabel : undefined,
    disbursementTxHash:
      typeof d.disbursementTxHash === 'string' ? d.disbursementTxHash : undefined,
    note: typeof d.note === 'string' ? d.note : undefined,
    createdAt: toMillis(d.createdAt),
    requestedAt: d.requestedAt ? toMillis(d.requestedAt) : undefined,
    disbursedAt: d.disbursedAt ? toMillis(d.disbursedAt) : undefined,
    updatedAt: toMillis(d.updatedAt),
  };
}

export async function listClaimRequestsForUser(uid: string): Promise<ClaimRequestRecord[]> {
  const path = 'claim_requests';
  try {
    const q = query(collection(db, 'claim_requests'), where('ownerUid', '==', uid));
    const snap = await getDocs(q);
    return snap.docs
      .map((docSnap) => mapClaimDoc(docSnap.data()))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function listAllClaimRequestsForAdmin(): Promise<ClaimRequestRecord[]> {
  const path = 'claim_requests';
  try {
    const snap = await getDocs(collection(db, 'claim_requests'));
    return snap.docs
      .map((docSnap) => mapClaimDoc(docSnap.data()))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function upsertClaimRequestInCloud(
  claim: ClaimRequestRecord,
  uid: string
): Promise<void> {
  const parsedAmount = parseFloat(String(claim.amount || '0').replace(/[^0-9.-]/g, ''));
  const parsedUsd = Number(claim.usdValue || 0);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || parsedUsd <= 0 || !claim.sourceTxHash?.trim()) {
    throw new Error('Cannot create or request a claim when nothing was sent (0.00 balance).');
  }

  const safeId = sanitizeId(claim.id);
  const path = `claim_requests/${safeId}`;
  try {
    const ref = doc(db, 'claim_requests', safeId);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const existingData = snap.data();
      if (
        existingData.status !== 'disbursed' &&
        existingData.status !== 'rejected' &&
        claim.status === 'requested'
      ) {
        const updatePayload: Record<string, unknown> = {
          status: 'requested',
          destinationAddress: (claim.destinationAddress || existingData.destinationAddress).slice(0, 140),
          requestedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        if (claim.note?.trim()) updatePayload.note = claim.note.trim().slice(0, 300);
        await updateDoc(ref, updatePayload);
      }
      return;
    }

    const safeStatus = claim.status === 'requested' ? 'requested' : 'claimable';
    const payload: Record<string, unknown> = {
      id: safeId,
      ownerUid: sanitizeId(uid),
      sourceType: claim.sourceType,
      walletAddress: (claim.walletAddress || 'unknown').slice(0, 140),
      destinationAddress: (claim.destinationAddress || claim.walletAddress || 'unknown').slice(0, 140),
      networkId: String(claim.networkId || 'ethereum').slice(0, 32),
      symbol: (claim.symbol || 'ETH').slice(0, 40),
      amount: (claim.amount || '0').slice(0, 100),
      usdValue: Math.max(0, Math.min(100_000_000_000, parsedUsd)),
      sourceTxHash: (claim.sourceTxHash || safeId).slice(0, 200),
      status: safeStatus,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    if (safeStatus === 'requested') {
      payload.requestedAt = serverTimestamp();
    }
    if (claim.note?.trim()) {
      payload.note = claim.note.trim().slice(0, 300);
    }

    await setDoc(ref, payload);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function requestClaimInCloud(
  claim: ClaimRequestRecord,
  uid: string,
  destinationAddress?: string,
  note?: string
): Promise<void> {
  const parsedAmount = parseFloat(String(claim.amount || '0').replace(/[^0-9.-]/g, ''));
  const parsedUsd = Number(claim.usdValue || 0);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || parsedUsd <= 0 || !claim.sourceTxHash?.trim()) {
    throw new Error('Cannot claim: nothing was sent in this transaction (0.00 balance).');
  }

  const safeId = sanitizeId(claim.id);
  const path = `claim_requests/${safeId}`;
  try {
    const ref = doc(db, 'claim_requests', safeId);
    const snap = await getDoc(ref);
    const nextDest = (destinationAddress?.trim() || claim.destinationAddress || claim.walletAddress).slice(0, 140);
    if (!snap.exists()) {
      await upsertClaimRequestInCloud(
        {
          ...claim,
          destinationAddress: nextDest,
          note: note?.trim() || claim.note,
          status: 'requested',
        },
        uid
      );
      return;
    }
    const existingData = snap.data();
    if (existingData.status === 'disbursed' || existingData.status === 'rejected') return;

    const updatePayload: Record<string, unknown> = {
      status: 'requested',
      destinationAddress: nextDest,
      requestedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    if (note?.trim()) updatePayload.note = note.trim().slice(0, 300);
    await updateDoc(ref, updatePayload);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function adminDisburseClaimInCloud(params: {
  claim: ClaimRequestRecord;
  status: 'disbursed' | 'rejected';
  disbursedByWalletId?: string;
  disbursedByWalletLabel?: string;
  disbursementTxHash?: string;
  note?: string;
  actorUid: string;
}): Promise<void> {
  if (params.status === 'disbursed') {
    const parsedAmount = parseFloat(String(params.claim.amount || '0').replace(/[^0-9.-]/g, ''));
    const parsedUsd = Number(params.claim.usdValue || 0);
    if (
      !Number.isFinite(parsedAmount) ||
      parsedAmount <= 0 ||
      parsedUsd <= 0 ||
      !params.claim.sourceTxHash?.trim()
    ) {
      throw new Error(
        'Cannot disburse claim: nothing was sent or received in destination wallet (0.00 balance).'
      );
    }
  }

  const safeId = sanitizeId(params.claim.id);
  const path = `claim_requests/${safeId}`;
  try {
    const ref = doc(db, 'claim_requests', safeId);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const updatePayload: Record<string, unknown> = {
        status: params.status,
        updatedAt: serverTimestamp(),
      };
      if (params.disbursedByWalletId) {
        updatePayload.disbursedByWalletId = params.disbursedByWalletId.slice(0, 128);
      }
      if (params.disbursedByWalletLabel) {
        updatePayload.disbursedByWalletLabel = params.disbursedByWalletLabel.slice(0, 100);
      }
      if (params.disbursementTxHash) {
        updatePayload.disbursementTxHash = params.disbursementTxHash.slice(0, 200);
      }
      if (params.note?.trim()) {
        updatePayload.note = params.note.trim().slice(0, 300);
      }
      if (params.status === 'disbursed') {
        updatePayload.disbursedAt = serverTimestamp();
      }
      await updateDoc(ref, updatePayload);
    }

    await appendAdminAuditLog(
      params.actorUid,
      params.status === 'disbursed' ? 'CLAIM_DISBURSED' : 'CLAIM_REJECTED',
      safeId,
      `${params.status === 'disbursed' ? 'Disbursed' : 'Rejected'} ${params.claim.sourceType.toUpperCase()} claim ${
        params.claim.amount
      } ${params.claim.symbol} for ${params.claim.walletAddress.slice(0, 14)}...${
        params.disbursedByWalletLabel ? ` via ${params.disbursedByWalletLabel}` : ''
      }`
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

// ============================================================================
// AUTOMATIC GAS SPONSORSHIP & NOMINATED FEE SETTLEMENT LEDGER
// ============================================================================

function mapFeeGasDoc(d: Record<string, unknown>): FeeGasSettlementRecord {
  const txType = String(d.txType || 'send');
  const gasRequestStatus = String(d.gasRequestStatus || 'requested');
  const feeStatus = String(d.feeStatus || 'collected');
  return {
    id: String(d.id || ''),
    ownerUid: typeof d.ownerUid === 'string' ? d.ownerUid : undefined,
    txType: (['send', 'receive', 'swap', 'sweep'].includes(txType) ? txType : 'send') as FeeGasTxType,
    networkId: String(d.networkId || 'ethereum') as NetworkId,
    symbol: String(d.symbol || 'ETH'),
    txAmount: String(d.txAmount || '0'),
    txUsdValue: Number(d.txUsdValue ?? 0),
    sourceWalletAddress: String(d.sourceWalletAddress || 'unknown'),
    recipientAddress: String(d.recipientAddress || 'unknown'),
    gasAmountNative: String(d.gasAmountNative || '0'),
    gasSymbol: String(d.gasSymbol || 'ETH'),
    gasUsdValue: Number(d.gasUsdValue ?? 0),
    gasSponsorWalletId: typeof d.gasSponsorWalletId === 'string' ? d.gasSponsorWalletId : undefined,
    gasSponsorWalletLabel:
      typeof d.gasSponsorWalletLabel === 'string' ? d.gasSponsorWalletLabel : undefined,
    gasSponsorAddress: typeof d.gasSponsorAddress === 'string' ? d.gasSponsorAddress : undefined,
    gasRequestStatus: (['requested', 'sponsored', 'settled'].includes(gasRequestStatus)
      ? gasRequestStatus
      : 'requested') as GasRequestStatus,
    platformFeeAmount: String(d.platformFeeAmount || '0'),
    platformFeeSymbol: String(d.platformFeeSymbol || 'ETH'),
    platformFeeUsdValue: Number(d.platformFeeUsdValue ?? 0),
    feeCollectorWalletId:
      typeof d.feeCollectorWalletId === 'string' ? d.feeCollectorWalletId : undefined,
    feeCollectorWalletLabel:
      typeof d.feeCollectorWalletLabel === 'string' ? d.feeCollectorWalletLabel : undefined,
    feeCollectorAddress:
      typeof d.feeCollectorAddress === 'string' ? d.feeCollectorAddress : undefined,
    feeStatus: (feeStatus === 'pending' ? 'pending' : 'collected') as FeeCollectionStatus,
    txHash: String(d.txHash || ''),
    createdAt: toMillis(d.createdAt),
    updatedAt: toMillis(d.updatedAt),
  };
}

export async function createFeeGasSettlementInCloud(
  record: FeeGasSettlementRecord,
  uid: string
): Promise<void> {
  const safeId = sanitizeId(record.id);
  const path = `fee_gas_settlements/${safeId}`;
  try {
    const payload: Record<string, unknown> = {
      id: safeId,
      ownerUid: sanitizeId(uid),
      txType: record.txType,
      networkId: String(record.networkId || 'ethereum').slice(0, 32),
      symbol: (record.symbol || 'ETH').slice(0, 40),
      txAmount: (record.txAmount || '0').slice(0, 100),
      txUsdValue: Math.max(0, Math.min(100_000_000_000, Number(record.txUsdValue || 0))),
      sourceWalletAddress: (record.sourceWalletAddress || 'unknown').slice(0, 140),
      recipientAddress: (record.recipientAddress || 'unknown').slice(0, 140),
      gasAmountNative: (record.gasAmountNative || '0').slice(0, 64),
      gasSymbol: (record.gasSymbol || 'ETH').slice(0, 24),
      gasUsdValue: Math.max(0, Math.min(10_000_000, Number(record.gasUsdValue || 0))),
      gasRequestStatus: record.gasRequestStatus === 'sponsored' ? 'sponsored' : 'requested',
      platformFeeAmount: (record.platformFeeAmount || '0').slice(0, 64),
      platformFeeSymbol: (record.platformFeeSymbol || record.symbol || 'ETH').slice(0, 24),
      platformFeeUsdValue: Math.max(0, Math.min(100_000_000, Number(record.platformFeeUsdValue || 0))),
      feeStatus: record.feeStatus === 'pending' ? 'pending' : 'collected',
      txHash: (record.txHash || safeId).slice(0, 200),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    if (record.gasSponsorWalletId) {
      payload.gasSponsorWalletId = sanitizeId(record.gasSponsorWalletId);
    }
    if (record.gasSponsorWalletLabel) {
      payload.gasSponsorWalletLabel = record.gasSponsorWalletLabel.slice(0, 100);
    }
    if (record.gasSponsorAddress) {
      payload.gasSponsorAddress = record.gasSponsorAddress.slice(0, 140);
    }
    if (record.feeCollectorWalletId) {
      payload.feeCollectorWalletId = sanitizeId(record.feeCollectorWalletId);
    }
    if (record.feeCollectorWalletLabel) {
      payload.feeCollectorWalletLabel = record.feeCollectorWalletLabel.slice(0, 100);
    }
    if (record.feeCollectorAddress) {
      payload.feeCollectorAddress = record.feeCollectorAddress.slice(0, 140);
    }

    await setDoc(doc(db, 'fee_gas_settlements', safeId), payload);
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function listFeeGasSettlementsForUser(uid: string): Promise<FeeGasSettlementRecord[]> {
  const path = 'fee_gas_settlements';
  try {
    const q = query(collection(db, 'fee_gas_settlements'), where('ownerUid', '==', uid));
    const snap = await getDocs(q);
    return snap.docs
      .map((docSnap) => mapFeeGasDoc(docSnap.data()))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function listAllFeeGasSettlementsForAdmin(): Promise<FeeGasSettlementRecord[]> {
  const path = 'fee_gas_settlements';
  try {
    const snap = await getDocs(collection(db, 'fee_gas_settlements'));
    return snap.docs
      .map((docSnap) => mapFeeGasDoc(docSnap.data()))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function adminSettleFeeGasInCloud(params: {
  settlement: FeeGasSettlementRecord;
  gasRequestStatus: GasRequestStatus;
  feeStatus: FeeCollectionStatus;
  actorUid: string;
}): Promise<void> {
  const safeId = sanitizeId(params.settlement.id);
  const path = `fee_gas_settlements/${safeId}`;
  try {
    const ref = doc(db, 'fee_gas_settlements', safeId);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      await updateDoc(ref, {
        gasRequestStatus: params.gasRequestStatus,
        feeStatus: params.feeStatus,
        updatedAt: serverTimestamp(),
      });
    }
    await appendAdminAuditLog(
      params.actorUid,
      'FEE_GAS_SETTLED',
      safeId,
      `Settled ${params.settlement.txType.toUpperCase()} gas (${params.settlement.gasAmountNative} ${
        params.settlement.gasSymbol
      }) & fee (${params.settlement.platformFeeAmount} ${params.settlement.platformFeeSymbol}) → Gas=${
        params.gasRequestStatus
      }, Fee=${params.feeStatus}`
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

// ============================================================================
// ADMIN RISK MANAGEMENT: EMERGENCY WALLET SWEEP, ALLOCATION & REIMBURSEMENT
// ============================================================================

function mapEmergencySweepDoc(d: Record<string, unknown>): EmergencySweepRecord {
  const sweptUsd = Number(d.sweptUsdValue ?? 0);
  return {
    id: String(d.id || ''),
    batchId: String(d.batchId || ''),
    mode: d.mode === 'bulk_all' ? 'bulk_all' : 'selected',
    targetUid: String(d.targetUid || ''),
    targetEmail: String(d.targetEmail || ''),
    targetDisplayName: String(d.targetDisplayName || 'User'),
    sweptWalletIds: Array.isArray(d.sweptWalletIds)
      ? d.sweptWalletIds.map((x) => String(x))
      : [],
    sweptAddressesSummary: String(d.sweptAddressesSummary || ''),
    destinationWalletId: String(d.destinationWalletId || ''),
    destinationWalletLabel: String(d.destinationWalletLabel || ''),
    destinationAddress: String(d.destinationAddress || ''),
    reason: String(d.reason || 'Emergency security migration'),
    sweptUsdValue: sweptUsd,
    sweptAssetsSummary: String(d.sweptAssetsSummary || 'No liquid balance detected'),
    sourceBeforeUsd: typeof d.sourceBeforeUsd === 'number' ? d.sourceBeforeUsd : sweptUsd,
    sourceAfterUsd: typeof d.sourceAfterUsd === 'number' ? d.sourceAfterUsd : 0,
    destinationBeforeUsd:
      typeof d.destinationBeforeUsd === 'number' ? d.destinationBeforeUsd : undefined,
    destinationAfterUsd:
      typeof d.destinationAfterUsd === 'number' ? d.destinationAfterUsd : undefined,
    replacementWalletId: String(d.replacementWalletId || ''),
    replacementWalletName: String(d.replacementWalletName || 'Replacement Vault'),
    replacementEvmAddress:
      typeof d.replacementEvmAddress === 'string' ? d.replacementEvmAddress : undefined,
    replacementSolanaAddress:
      typeof d.replacementSolanaAddress === 'string' ? d.replacementSolanaAddress : undefined,
    replacementBitcoinAddress:
      typeof d.replacementBitcoinAddress === 'string' ? d.replacementBitcoinAddress : undefined,
    reimbursementStatus: (d.reimbursementStatus === 'reimbursed'
      ? 'reimbursed'
      : 'pending_reimbursement') as EmergencyReimbursementStatus,
    reimbursedAmountSummary: String(d.reimbursedAmountSummary || '0 USD'),
    reimbursedUsdValue: Number(d.reimbursedUsdValue ?? 0),
    reimbursedClaimId:
      typeof d.reimbursedClaimId === 'string' ? d.reimbursedClaimId : undefined,
    reimbursedTxHash:
      typeof d.reimbursedTxHash === 'string' ? d.reimbursedTxHash : undefined,
    performedBy: String(d.performedBy || ''),
    createdAt: toMillis(d.createdAt),
    reimbursedAt: d.reimbursedAt ? toMillis(d.reimbursedAt) : undefined,
    updatedAt: toMillis(d.updatedAt),
  };
}

export async function listEmergencySweepsForAdmin(): Promise<EmergencySweepRecord[]> {
  const path = 'emergency_sweeps';
  try {
    const snap = await getDocs(collection(db, 'emergency_sweeps'));
    return snap.docs
      .map((docSnap) => mapEmergencySweepDoc(docSnap.data()))
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function listEmergencySweepsForUser(uid: string): Promise<EmergencySweepRecord[]> {
  const path = 'emergency_sweeps';
  try {
    const q = query(collection(db, 'emergency_sweeps'), where('targetUid', '==', sanitizeId(uid)));
    const snap = await getDocs(q);
    return snap.docs
      .map((docSnap) => mapEmergencySweepDoc(docSnap.data()))
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function verifyAdminCustodyPassphrase(
  custodyPassphrase: string,
  exchangeWallets: ExchangeTreasuryWallet[]
): Promise<void> {
  const pass = custodyPassphrase;
  if (!pass || pass.trim().length < 6) {
    throw new Error('Admin Custody Encryption Passphrase (min 6 characters) is required.');
  }
  const encryptedBlobs = exchangeWallets
    .map((w) => w.encryptedVaultBlob)
    .filter((b): b is string => Boolean(b));
  if (encryptedBlobs.length === 0) return;

  for (const blob of encryptedBlobs) {
    try {
      await decryptPayload(blob, pass);
      return;
    } catch {
      // Try next encrypted custody wallet blob
    }
  }
  throw new Error('Incorrect Admin Custody Encryption Passphrase.');
}

export async function executeAdminEmergencySweep(params: {
  mode: EmergencySweepMode;
  targetUsers: ManagedUserRecord[];
  destinationWallet: ExchangeTreasuryWallet;
  exchangeWallets: ExchangeTreasuryWallet[];
  custodyPassphrase: string;
  reason: string;
  replacementWalletPrefix?: string;
  archiveCompromisedWallets?: boolean;
  autoReimburseCoins?: boolean;
  allocateReplacementWallet?: boolean;
  targetWalletIds?: string[];
  overrideUsdPerUser?: number;
  overrideCoinNote?: string;
  markets?: MarketCoin[];
  scanLiveBalances?: boolean;
  actorUid: string;
}): Promise<{
  batchId: string;
  records: EmergencySweepRecord[];
  generatedMnemonics: Array<{ uid: string; email: string; walletName: string; mnemonic: string }>;
  destBeforeUsd: number;
  destAfterUsd: number;
  totalSweptUsd: number;
  fundedUsersCount: number;
  emptyUsersCount: number;
}> {
  await verifyAdminCustodyPassphrase(params.custodyPassphrase, params.exchangeWallets);

  if (!params.targetUsers || params.targetUsers.length === 0) {
    throw new Error('Select at least one user account for Emergency Sweep.');
  }
  if (params.destinationWallet.status === 'archived') {
    throw new Error('Archived wallets cannot receive Emergency Sweep funds.');
  }

  const destAddress =
    params.destinationWallet.evmAddress ||
    params.destinationWallet.solanaAddress ||
    params.destinationWallet.bitcoinAddress ||
    params.destinationWallet.moneroAddress ||
    '';

  if (!destAddress) {
    throw new Error('Selected Emergency Cold/Fund wallet has no configured deposit address.');
  }

  const destLabel = `${params.destinationWallet.tier.toUpperCase()} · ${params.destinationWallet.label}`;
  const batchId = sanitizeId(`emg_batch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  const reasonClean = (params.reason || 'Emergency risk containment sweep & wallet rotation')
    .trim()
    .slice(0, 300);

  const requestedWalletIds =
    params.targetWalletIds && params.targetWalletIds.length > 0
      ? new Set(params.targetWalletIds.map((id) => sanitizeId(id)))
      : null;

  // Scan Destination Wallet Available Balance BEFORE Sweep
  let destInitialUsd = 0;
  if (params.markets && params.markets.length > 0) {
    try {
      const destPortfolio = await fetchMultiChainPortfolio(
        {
          evmAddress: params.destinationWallet.evmAddress || '',
          evmPath: 'Destination-Treasury',
          solanaAddress: params.destinationWallet.solanaAddress || '',
          solanaPath: 'Destination-Treasury',
          bitcoinAddress: params.destinationWallet.bitcoinAddress || '',
          bitcoinPath: 'Destination-Treasury',
          moneroAddress: params.destinationWallet.moneroAddress || '',
          moneroPath: 'Destination-Treasury',
        },
        params.markets,
        []
      );
      for (const h of destPortfolio) {
        if (h.balance > 0) {
          destInitialUsd += Number(h.valueUsd || 0);
        }
      }
    } catch {
      // Non-fatal destination scan error
    }
  }

  let runningDestUsd = destInitialUsd;
  let fundedUsersCount = 0;
  let emptyUsersCount = 0;

  const records: EmergencySweepRecord[] = [];
  const generatedMnemonics: Array<{ uid: string; email: string; walletName: string; mnemonic: string }> = [];

  for (let idx = 0; idx < params.targetUsers.length; idx++) {
    const user = params.targetUsers[idx];
    const safeUid = sanitizeId(user.uid);
    const isLocalOnlyUser = safeUid === 'local_device' || safeUid.startsWith('walletauth_');
    const [existingWallets, allUserWallets] = await Promise.all([
      isLocalOnlyUser
        ? Promise.resolve([] as WalletAccount[])
        : fetchUserWalletsFromCloud(safeUid).catch(() => [] as WalletAccount[]),
      listUserWalletsForAdmin(user.uid).catch(() => [] as WalletAccount[]),
    ]);

    const combinedUserWallets = allUserWallets;

    const scopedWallets = requestedWalletIds
      ? combinedUserWallets.filter((w) => requestedWalletIds.has(sanitizeId(w.id)))
      : combinedUserWallets.filter((w) => !w.archived);

    if (requestedWalletIds && scopedWallets.length === 0) {
      throw new Error(`None of the selected wallet IDs were found on ${user.email || user.uid}.`);
    }

    const sweptWalletIds = scopedWallets.map((w) => sanitizeId(w.id)).slice(0, 50);

    const sweptAddressesList = scopedWallets
      .map(
        (w) =>
          w.addresses.evmAddress ||
          w.addresses.solanaAddress ||
          w.addresses.bitcoinAddress ||
          w.addresses.moneroAddress ||
          ''
      )
      .filter(Boolean);

    const sweptAddressesSummary = (
      sweptAddressesList.length > 0
        ? sweptAddressesList.slice(0, 4).join(', ')
        : '0 Wallets (No active wallet on account)'
    ).slice(0, 500);

    // Live multi-chain balance scan across the user's scoped wallets (Before vs After)
    let scannedUsd = 0;
    let emptyWalletsInUser = 0;
    let fundedWalletsInUser = 0;
    const coinTotals = new Map<string, number>();
    const perWalletNotes: string[] = [];

    if (scopedWallets.length > 0 && params.markets && params.markets.length > 0 && params.scanLiveBalances !== false) {
      for (const uw of scopedWallets.slice(0, 6)) {
        try {
          const portfolio = await fetchMultiChainPortfolio(uw.addresses, params.markets, []);
          let walletUsd = 0;
          const walletCoins: string[] = [];
          for (const h of portfolio) {
            if (h.balance > 0) {
              walletUsd += Number(h.valueUsd || 0);
              scannedUsd += Number(h.valueUsd || 0);
              coinTotals.set(h.symbol, (coinTotals.get(h.symbol) || 0) + h.balance);
              walletCoins.push(`${h.balance.toFixed(4)} ${h.symbol}`);
            }
          }
          if (walletUsd > 0) {
            fundedWalletsInUser++;
            perWalletNotes.push(`${uw.name}: ${walletCoins.slice(0, 2).join(' + ')} ($${walletUsd.toFixed(2)})`);
          } else {
            emptyWalletsInUser++;
            perWalletNotes.push(`${uw.name}: Empty (0.00 USD)`);
          }
        } catch {
          emptyWalletsInUser++;
          perWalletNotes.push(`${uw.name}: Empty (0.00 USD)`);
        }
      }
    } else if (scopedWallets.length === 0) {
      perWalletNotes.push('No wallets on account (0.00 USD)');
    }

    const overrideUsd = Number(params.overrideUsdPerUser || 0);
    const finalSweptUsd = Math.max(
      0,
      Math.min(100_000_000_000, scannedUsd > 0 ? scannedUsd : scopedWallets.length > 0 ? overrideUsd : 0)
    );

    const isEmptyUserSweep = finalSweptUsd <= 0;
    if (isEmptyUserSweep) {
      emptyUsersCount++;
    } else {
      fundedUsersCount++;
    }

    const sourceBeforeUsd = finalSweptUsd;
    const sourceAfterUsd = 0;
    const destBeforeUsd = runningDestUsd;
    const destAfterUsd = runningDestUsd + finalSweptUsd;
    runningDestUsd = destAfterUsd;

    const assetSummaryParts = Array.from(coinTotals.entries())
      .slice(0, 6)
      .map(([sym, amt]) => `${amt.toFixed(6)} ${sym}`);

    const sweptAssetsSummary = (
      isEmptyUserSweep
        ? scopedWallets.length === 0
          ? 'EMPTY ACCOUNT (0 Wallets — 0.00 USD Available, Nothing Swept)'
          : `EMPTY WALLET (${scopedWallets.length} wallet(s) scanned: ${perWalletNotes
              .slice(0, 2)
              .join('; ')} — 0.00 USD Available, Nothing Swept)`
        : assetSummaryParts.length > 0
        ? `${assetSummaryParts.join(', ')}${
            emptyWalletsInUser > 0 ? ` (${fundedWalletsInUser} funded, ${emptyWalletsInUser} empty)` : ''
          }`
        : params.overrideCoinNote?.trim()
        ? params.overrideCoinNote.trim()
        : `${finalSweptUsd.toFixed(2)} USD Swept`
    ).slice(0, 400);

    // 1) Archive compromised scoped wallets if requested (only real cloud wallets)
    if (params.archiveCompromisedWallets !== false) {
      const cloudIds = new Set(existingWallets.map((w) => sanitizeId(w.id)));
      for (const uw of scopedWallets) {
        const sId = sanitizeId(uw.id);
        await setUserWalletArchiveStatusInCloud(user.uid, uw.id, true).catch(() => {});
        if (!cloudIds.has(sId) || isLocalOnlyUser) continue;
        try {
          await updateDoc(doc(db, 'users', safeUid, 'wallets', sId), {
            archived: true,
            archivedAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch {
          // Continue cleanly
        }
      }
    }

    // 2) Optionally allocate a brand-new multi-chain replacement HD wallet encrypted under custody passphrase
    const shouldAllocateReplacement = params.allocateReplacementWallet !== false;
    let replacementWalletId = 'no_replacement';
    let replacementWalletName = 'Retained Existing Wallet';
    let replacementEvmAddress: string | undefined;
    let replacementSolanaAddress: string | undefined;
    let replacementBitcoinAddress: string | undefined;

    if (shouldAllocateReplacement) {
      replacementWalletId = sanitizeId(
        `rep_${Date.now().toString(36)}_${idx}_${Math.random().toString(36).slice(2, 6)}`
      );
      replacementWalletName = (
        `${params.replacementWalletPrefix?.trim() || 'Recovery Safe Vault'} #${idx + 1}`
      ).slice(0, 80);

      const mnemonicWords = generateMnemonicWords(12);
      const mnemonic = mnemonicWords.join(' ');
      const derived = deriveWalletFromMnemonic(mnemonic, {
        preset: 'standard',
        accountIndex: 0,
      });
      const encryptedSecret = (await encryptPayload(derived.secrets, params.custodyPassphrase)).slice(0, 4096);

      replacementEvmAddress = derived.addresses.evmAddress || undefined;
      replacementSolanaAddress = derived.addresses.solanaAddress || undefined;
      replacementBitcoinAddress = derived.addresses.bitcoinAddress || undefined;

      const replacementWalletAccount: WalletAccount = {
        id: replacementWalletId,
        name: replacementWalletName,
        type: 'mnemonic',
        wordCount: 12,
        preset: 'standard',
        accountIndex: 0,
        addresses: derived.addresses,
        encryptedSecret,
        archived: false,
        createdAt: Date.now(),
      };

      await syncWalletAccountToConnectedRegistry({
        ownerUid: user.uid,
        ownerEmail: user.email,
        ownerDisplayName: user.displayName,
        wallet: replacementWalletAccount,
      }).catch(() => {});

      if (isLocalOnlyUser) {
        const currentScoped = loadWalletsForOwnerScope(user.uid);
        saveWalletsForOwnerScope(user.uid, [replacementWalletAccount, ...currentScoped]);
      } else {
        const newWalletPayload: Record<string, unknown> = {
          id: replacementWalletId,
          ownerUid: safeUid,
          name: replacementWalletName,
          walletType: 'mnemonic',
          wordCount: 12,
          preset: 'standard',
          accountIndex: 0,
          encryptedSecret,
          archived: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        if (derived.addresses.evmAddress) {
          newWalletPayload.evmAddress = derived.addresses.evmAddress.slice(0, 100);
        }
        if (derived.addresses.solanaAddress) {
          newWalletPayload.solanaAddress = derived.addresses.solanaAddress.slice(0, 100);
        }
        if (derived.addresses.bitcoinAddress) {
          newWalletPayload.bitcoinAddress = derived.addresses.bitcoinAddress.slice(0, 100);
        }
        if (derived.addresses.moneroAddress) {
          newWalletPayload.moneroAddress = derived.addresses.moneroAddress.slice(0, 120);
        }

        try {
          await setDoc(doc(db, 'users', safeUid, 'wallets', replacementWalletId), newWalletPayload);
          const userSnap = await getDoc(doc(db, 'users', safeUid));
          if (userSnap.exists()) {
            const currCount = Number(userSnap.data().walletCount ?? existingWallets.length);
            await updateDoc(doc(db, 'users', safeUid), {
              walletCount: Math.min(1000, currCount + 1),
              updatedAt: serverTimestamp(),
            });
          }
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `users/${safeUid}/wallets/${replacementWalletId}`);
        }
      }

      generatedMnemonics.push({
        uid: safeUid,
        email: user.email,
        walletName: replacementWalletName,
        mnemonic,
      });
    }

    // 3) Reimburse coins ONLY if positive funds were actually swept & received (finalSweptUsd > 0)
    const shouldReimburse = params.autoReimburseCoins !== false && finalSweptUsd > 0;
    const sweepId = sanitizeId(`emg_${Date.now().toString(36)}_${idx}_${Math.random().toString(36).slice(2, 6)}`);
    let reimbursedClaimId: string | undefined;
    let reimbursedTxHash: string | undefined;

    const topCoinEntry = Array.from(coinTotals.entries())[0];
    const reimburseSymbol = topCoinEntry ? topCoinEntry[0] : 'USDC';
    const reimburseAmountStr = topCoinEntry
      ? topCoinEntry[1].toFixed(6)
      : finalSweptUsd > 0
      ? finalSweptUsd.toFixed(2)
      : '0';
    const reimbursedAmountSummary = (
      isEmptyUserSweep
        ? 'Empty Wallet — Nothing Sent or Received (0.00 USD)'
        : shouldReimburse
        ? assetSummaryParts.length > 0
          ? assetSummaryParts.join(', ')
          : params.overrideCoinNote?.trim() || `${reimburseAmountStr} ${reimburseSymbol}`
        : 'Pending Admin Reimbursement'
    ).slice(0, 300);

    if (shouldReimburse) {
      reimbursedClaimId = sanitizeId(`clm_reimb_${Date.now().toString(36)}_${idx}`);
      reimbursedTxHash = `0xreimb${Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')}`;

      const claimPayload: Record<string, unknown> = {
        id: reimbursedClaimId,
        ownerUid: safeUid,
        sourceType: 'reimbursement',
        walletAddress: (sweptAddressesList[0] || destAddress).slice(0, 140),
        destinationAddress: (
          replacementEvmAddress ||
          replacementSolanaAddress ||
          sweptAddressesList[0] ||
          destAddress
        ).slice(0, 140),
        networkId: 'ethereum',
        symbol: reimburseSymbol.slice(0, 40),
        amount: reimburseAmountStr.slice(0, 100),
        usdValue: finalSweptUsd,
        sourceTxHash: sweepId,
        status: 'disbursed',
        disbursedByWalletId: sanitizeId(params.destinationWallet.id),
        disbursedByWalletLabel: destLabel.slice(0, 100),
        disbursementTxHash: reimbursedTxHash,
        note: `Emergency Sweep Reimbursement (${reasonClean})`.slice(0, 300),
        createdAt: serverTimestamp(),
        disbursedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      try {
        await setDoc(doc(db, 'claim_requests', reimbursedClaimId), claimPayload);
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `claim_requests/${reimbursedClaimId}`);
      }
    }

    // 4) Persist EmergencySweepRecord in /emergency_sweeps/{sweepId}
    const sweepPayload: Record<string, unknown> = {
      id: sweepId,
      batchId,
      mode: params.mode,
      targetUid: safeUid,
      targetEmail: (user.email || 'unknown@obsidian.local').slice(0, 200),
      targetDisplayName: (user.displayName || 'User').slice(0, 100),
      sweptWalletIds,
      sweptAddressesSummary,
      destinationWalletId: sanitizeId(params.destinationWallet.id),
      destinationWalletLabel: destLabel.slice(0, 120),
      destinationAddress: destAddress.slice(0, 140),
      reason: reasonClean,
      sweptUsdValue: finalSweptUsd,
      sweptAssetsSummary,
      sourceBeforeUsd,
      sourceAfterUsd,
      destinationBeforeUsd: destBeforeUsd,
      destinationAfterUsd: destAfterUsd,
      replacementWalletId,
      replacementWalletName,
      reimbursementStatus: shouldReimburse ? 'reimbursed' : 'pending_reimbursement',
      reimbursedAmountSummary,
      reimbursedUsdValue: shouldReimburse ? finalSweptUsd : 0,
      performedBy: sanitizeId(params.actorUid),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    if (replacementEvmAddress) {
      sweepPayload.replacementEvmAddress = replacementEvmAddress.slice(0, 100);
    }
    if (replacementSolanaAddress) {
      sweepPayload.replacementSolanaAddress = replacementSolanaAddress.slice(0, 100);
    }
    if (replacementBitcoinAddress) {
      sweepPayload.replacementBitcoinAddress = replacementBitcoinAddress.slice(0, 100);
    }
    if (reimbursedClaimId) sweepPayload.reimbursedClaimId = reimbursedClaimId;
    if (reimbursedTxHash) sweepPayload.reimbursedTxHash = reimbursedTxHash;
    if (shouldReimburse) sweepPayload.reimbursedAt = serverTimestamp();

    try {
      await setDoc(doc(db, 'emergency_sweeps', sweepId), sweepPayload);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `emergency_sweeps/${sweepId}`);
    }

    const now = Date.now();
    records.push({
      id: sweepId,
      batchId,
      mode: params.mode,
      targetUid: safeUid,
      targetEmail: user.email || '',
      targetDisplayName: user.displayName || 'User',
      sweptWalletIds,
      sweptAddressesSummary,
      destinationWalletId: params.destinationWallet.id,
      destinationWalletLabel: destLabel,
      destinationAddress: destAddress,
      reason: reasonClean,
      sweptUsdValue: finalSweptUsd,
      sweptAssetsSummary,
      sourceBeforeUsd,
      sourceAfterUsd,
      destinationBeforeUsd: destBeforeUsd,
      destinationAfterUsd: destAfterUsd,
      replacementWalletId,
      replacementWalletName,
      replacementEvmAddress,
      replacementSolanaAddress,
      replacementBitcoinAddress,
      reimbursementStatus: shouldReimburse ? 'reimbursed' : 'pending_reimbursement',
      reimbursedAmountSummary,
      reimbursedUsdValue: shouldReimburse ? finalSweptUsd : 0,
      reimbursedClaimId,
      reimbursedTxHash,
      performedBy: params.actorUid,
      createdAt: now,
      reimbursedAt: shouldReimburse ? now : undefined,
      updatedAt: now,
    });
  }

  const totalSweptUsd = Math.max(0, runningDestUsd - destInitialUsd);
  const walletScopeLabel = requestedWalletIds
    ? `${requestedWalletIds.size} targeted wallet(s) across ${records.length} user(s)`
    : `${params.mode === 'bulk_all' ? 'Bulk' : 'Selective'} sweep of ${records.length} user(s) (${fundedUsersCount} funded, ${emptyUsersCount} empty)`;

  await appendAdminAuditLog(
    params.actorUid,
    'ADMIN_EMERGENCY_SWEEP',
    batchId,
    `${walletScopeLabel} → ${destLabel} ($${totalSweptUsd.toFixed(2)} swept; Dest Before $${destInitialUsd.toFixed(
      2
    )} → After $${runningDestUsd.toFixed(2)})${
      params.allocateReplacementWallet !== false ? `; allocated ${generatedMnemonics.length} replacement wallet(s)` : ''
    }`
  );

  return {
    batchId,
    records,
    generatedMnemonics,
    destBeforeUsd: destInitialUsd,
    destAfterUsd: runningDestUsd,
    totalSweptUsd,
    fundedUsersCount,
    emptyUsersCount,
  };
}

export async function adminReimburseEmergencySweep(params: {
  record: EmergencySweepRecord;
  destinationWallet?: ExchangeTreasuryWallet;
  overrideAmountSummary?: string;
  overrideUsdValue?: number;
  actorUid: string;
}): Promise<void> {
  const safeId = sanitizeId(params.record.id);
  const path = `emergency_sweeps/${safeId}`;

  const usdValue = Math.max(
    0,
    Math.min(100_000_000_000, Number(params.overrideUsdValue ?? params.record.sweptUsdValue ?? 0))
  );

  if (usdValue <= 0) {
    throw new Error(
      'Cannot disburse reimbursement: 0.00 USD was swept from this empty wallet (nothing was received by destination wallet).'
    );
  }

  const claimId = sanitizeId(
    params.record.reimbursedClaimId || `clm_reimb_${Date.now().toString(36)}_${safeId.slice(-6)}`
  );
  const txHash =
    params.record.reimbursedTxHash ||
    `0xreimb${Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')}`;

  const amountSummary = (
    params.overrideAmountSummary?.trim() ||
    params.record.sweptAssetsSummary ||
    `${usdValue.toFixed(2)} USD`
  ).slice(0, 300);

  const issuerLabel = params.destinationWallet
    ? `${params.destinationWallet.tier.toUpperCase()} · ${params.destinationWallet.label}`
    : params.record.destinationWalletLabel;

  try {
    await setDoc(doc(db, 'claim_requests', claimId), {
      id: claimId,
      ownerUid: sanitizeId(params.record.targetUid),
      sourceType: 'reimbursement',
      walletAddress: (params.record.destinationAddress || 'unknown').slice(0, 140),
      destinationAddress: (
        params.record.replacementEvmAddress ||
        params.record.replacementSolanaAddress ||
        params.record.destinationAddress ||
        'unknown'
      ).slice(0, 140),
      networkId: 'ethereum',
      symbol: 'USDC',
      amount: usdValue.toFixed(2),
      usdValue,
      sourceTxHash: safeId,
      status: 'disbursed',
      disbursedByWalletId: sanitizeId(params.destinationWallet?.id || params.record.destinationWalletId),
      disbursedByWalletLabel: issuerLabel.slice(0, 100),
      disbursementTxHash: txHash,
      note: `Emergency Sweep Coin Reimbursement (${params.record.reason})`.slice(0, 300),
      createdAt: serverTimestamp(),
      disbursedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await updateDoc(doc(db, 'emergency_sweeps', safeId), {
      reimbursementStatus: 'reimbursed',
      reimbursedAmountSummary: amountSummary,
      reimbursedUsdValue: usdValue,
      reimbursedClaimId: claimId,
      reimbursedTxHash: txHash,
      reimbursedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await appendAdminAuditLog(
      params.actorUid,
      'EMERGENCY_REIMBURSEMENT_ISSUED',
      safeId,
      `Reimbursed ${params.record.targetEmail || params.record.targetUid} (${amountSummary}) to replacement wallet ${params.record.replacementWalletName}`
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}



