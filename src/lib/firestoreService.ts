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
import { deriveWalletFromMnemonic, generateMnemonicWords } from './crypto';
import { encryptPayload } from './vaultStorage';
import { OperationType, db, handleFirestoreError } from './firebase';
import type {
  AdminAuditLogEntry,
  ExchangeSystemConfig,
  ExchangeTreasuryWallet,
  ExchangeWalletTier,
  ManagedUserRecord,
  PriceAlert,
  WalletAccount,
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
      await updateDoc(doc(db, 'users', uid, 'wallets', safeId), {
        name: wallet.name.slice(0, 80),
        ...(wallet.encryptedSecret
          ? { encryptedSecret: wallet.encryptedSecret.slice(0, 4096) }
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
  networkFamily: 'multi-chain' | 'evm' | 'solana' | 'bitcoin';
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
    },
  };
}

export async function updateExchangeWallet(
  walletId: string,
  updates: { status?: 'active' | 'frozen' | 'sweeping'; label?: string; allocationCapPct?: number },
  actorUid: string
): Promise<void> {
  const path = `exchange_wallets/${walletId}`;
  try {
    await updateDoc(doc(db, 'exchange_wallets', walletId), {
      ...updates,
      updatedAt: serverTimestamp(),
    });
    await appendAdminAuditLog(
      actorUid,
      'EXCHANGE_WALLET_UPDATED',
      walletId,
      `Updated treasury wallet ${walletId}: ${JSON.stringify(updates)}`
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
    return {
      maintenanceMode: Boolean(d.maintenanceMode),
      withdrawalsPaused: Boolean(d.withdrawalsPaused),
      hotWalletMaxPct: Number(d.hotWalletMaxPct ?? 10),
      swapFeeBps: Number(d.swapFeeBps ?? 10),
      updatedBy: d.updatedBy || 'system',
      updatedAt: toMillis(d.updatedAt),
    };
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
    await setDoc(doc(db, 'system_config', 'exchange'), {
      maintenanceMode: cfg.maintenanceMode,
      withdrawalsPaused: cfg.withdrawalsPaused,
      hotWalletMaxPct: Math.max(1, Math.min(100, cfg.hotWalletMaxPct)),
      swapFeeBps: Math.max(0, Math.min(500, cfg.swapFeeBps)),
      updatedBy: sanitizeId(actorUid),
      updatedAt: serverTimestamp(),
    });
    await appendAdminAuditLog(
      actorUid,
      'SYSTEM_CONFIG_UPDATED',
      'exchange',
      `Maintenance=${cfg.maintenanceMode}, WithdrawalsPaused=${cfg.withdrawalsPaused}, HotCap=${cfg.hotWalletMaxPct}%, Fee=${cfg.swapFeeBps}bps`
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}
