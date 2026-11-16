import type {
  AddressBookEntry,
  ConnectedExternalWallet,
  NetworkId,
  PriceAlert,
  TokenConfig,
  UnlockedSecrets,
  WalletAccount,
  WalletAuthSession,
  WalletTransaction,
} from '../types/wallet';

const LEGACY_KEYS = {
  WALLETS: 'obsidian_vault_wallets_v1',
  ACTIVE_WALLET_ID: 'obsidian_vault_active_id_v1',
  PASSWORD_VERIFIER: 'obsidian_vault_verifier_v1',
  ALERTS: 'obsidian_vault_alerts_v1',
  LOCAL_TXS: 'obsidian_vault_txs_v1',
  ADDRESS_BOOK: 'obsidian_vault_contacts_v1',
  CUSTOM_TOKENS: 'obsidian_vault_custom_tokens_v1',
  SETTINGS: 'obsidian_vault_settings_v1',
  CONNECTED_EXTERNALS: 'obsidian_vault_connected_v1',
};

let currentUserScope: string | null = null;

export function setActiveUserScope(uid: string | null): void {
  currentUserScope = uid ? uid.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) : null;
}

function scopedKey(baseKey: string): string {
  return currentUserScope ? `${baseKey}__${currentUserScope}` : baseKey;
}

function readScopedRaw(baseKey: string): string | null {
  const sKey = scopedKey(baseKey);
  const val = localStorage.getItem(sKey);
  if (val !== null) return val;
  if (currentUserScope && !currentUserScope.startsWith('walletauth_')) {
    // One-time seamless fallback for legacy unscoped single-user data (never cross-contaminate walletauth scopes)
    return localStorage.getItem(baseKey);
  }
  return null;
}

function writeScopedRaw(baseKey: string, value: string): void {
  localStorage.setItem(scopedKey(baseKey), value);
}

function removeScopedRaw(baseKey: string): void {
  localStorage.removeItem(scopedKey(baseKey));
  if (!currentUserScope) {
    localStorage.removeItem(baseKey);
  }
}

const SESSION_UNLOCK_PREFIX = 'obsidian_session_unlock_v1__';

export function saveSessionUnlockToken(uid: string | null, password: string): void {
  if (!uid || !password) return;
  try {
    sessionStorage.setItem(
      `${SESSION_UNLOCK_PREFIX}${uid}`,
      JSON.stringify({ pw: password, ts: Date.now() })
    );
  } catch {
    // Ignore storage quota / private mode restrictions
  }
}

export function loadSessionUnlockToken(uid: string | null): string | null {
  if (!uid) return null;
  try {
    const raw = sessionStorage.getItem(`${SESSION_UNLOCK_PREFIX}${uid}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { pw?: string; ts?: number };
    if (!parsed.pw) return null;
    return parsed.pw;
  } catch {
    return null;
  }
}

export function clearSessionUnlockToken(uid?: string | null): void {
  try {
    if (uid) {
      sessionStorage.removeItem(`${SESSION_UNLOCK_PREFIX}${uid}`);
    } else {
      const toRemove: string[] = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith(SESSION_UNLOCK_PREFIX)) toRemove.push(k);
      }
      toRemove.forEach((k) => sessionStorage.removeItem(k));
    }
  } catch {
    // Ignore
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveAesKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: 100_000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptPayload(data: unknown, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt);
  const plaintext = encoder.encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return JSON.stringify({
    v: 1,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ciphertext)),
  });
}

export async function decryptPayload<T>(encryptedJson: string, password: string): Promise<T> {
  const parsed = JSON.parse(encryptedJson) as {
    salt: string;
    iv: string;
    ct: string;
  };
  const salt = fromBase64(parsed.salt);
  const iv = fromBase64(parsed.iv);
  const ct = fromBase64(parsed.ct);
  const key = await deriveAesKey(password, salt);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ct as BufferSource
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

export async function createVaultVerifier(password: string): Promise<void> {
  const encrypted = await encryptPayload({ check: 'OBSIDIAN_VAULT_OK' }, password);
  writeScopedRaw(LEGACY_KEYS.PASSWORD_VERIFIER, encrypted);
}

export async function verifyVaultPassword(password: string): Promise<boolean> {
  const raw = readScopedRaw(LEGACY_KEYS.PASSWORD_VERIFIER);
  if (!raw) return true;
  try {
    const res = await decryptPayload<{ check: string }>(raw, password);
    return res.check === 'OBSIDIAN_VAULT_OK';
  } catch {
    return false;
  }
}

export function hasVaultPassword(): boolean {
  return Boolean(readScopedRaw(LEGACY_KEYS.PASSWORD_VERIFIER));
}

export async function canDecryptAnyWallet(
  wallets: WalletAccount[],
  password: string
): Promise<boolean> {
  const encryptedWallets = wallets.filter((w) => Boolean(w.encryptedSecret));
  if (encryptedWallets.length === 0) return true;
  for (const w of encryptedWallets) {
    try {
      await decryptPayload<UnlockedSecrets>(w.encryptedSecret!, password);
      return true;
    } catch {
      // Try remaining wallets
    }
  }
  return false;
}

export function loadWallets(): WalletAccount[] {
  try {
    const raw = readScopedRaw(LEGACY_KEYS.WALLETS);
    return raw ? (JSON.parse(raw) as WalletAccount[]) : [];
  } catch {
    return [];
  }
}

export function saveWallets(wallets: WalletAccount[]): void {
  writeScopedRaw(LEGACY_KEYS.WALLETS, JSON.stringify(wallets));
}

export function loadActiveWalletId(): string | null {
  return readScopedRaw(LEGACY_KEYS.ACTIVE_WALLET_ID);
}

export function saveActiveWalletId(id: string | null): void {
  if (id) {
    writeScopedRaw(LEGACY_KEYS.ACTIVE_WALLET_ID, id);
  } else {
    removeScopedRaw(LEGACY_KEYS.ACTIVE_WALLET_ID);
  }
}

export async function unlockWalletSecrets(
  wallet: WalletAccount,
  password: string
): Promise<UnlockedSecrets> {
  if (!wallet.encryptedSecret) return {};
  return decryptPayload<UnlockedSecrets>(wallet.encryptedSecret, password);
}

export function loadConnectedExternals(): ConnectedExternalWallet[] {
  try {
    const raw = readScopedRaw(LEGACY_KEYS.CONNECTED_EXTERNALS);
    return raw ? (JSON.parse(raw) as ConnectedExternalWallet[]) : [];
  } catch {
    return [];
  }
}

export function saveConnectedExternals(list: ConnectedExternalWallet[]): void {
  writeScopedRaw(LEGACY_KEYS.CONNECTED_EXTERNALS, JSON.stringify(list));
}

export function loadAlerts(): PriceAlert[] {
  try {
    const raw = readScopedRaw(LEGACY_KEYS.ALERTS);
    return raw ? (JSON.parse(raw) as PriceAlert[]) : [];
  } catch {
    return [];
  }
}

export function saveAlerts(alerts: PriceAlert[]): void {
  writeScopedRaw(LEGACY_KEYS.ALERTS, JSON.stringify(alerts));
}

export function loadLocalTxs(): WalletTransaction[] {
  try {
    const raw = readScopedRaw(LEGACY_KEYS.LOCAL_TXS);
    return raw ? (JSON.parse(raw) as WalletTransaction[]) : [];
  } catch {
    return [];
  }
}

export function saveLocalTxs(txs: WalletTransaction[]): void {
  writeScopedRaw(LEGACY_KEYS.LOCAL_TXS, JSON.stringify(txs.slice(0, 100)));
}

export function loadAddressBook(): AddressBookEntry[] {
  try {
    const raw = readScopedRaw(LEGACY_KEYS.ADDRESS_BOOK);
    return raw ? (JSON.parse(raw) as AddressBookEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveAddressBook(entries: AddressBookEntry[]): void {
  writeScopedRaw(LEGACY_KEYS.ADDRESS_BOOK, JSON.stringify(entries));
}

export function loadCustomTokens(): TokenConfig[] {
  try {
    const raw = readScopedRaw(LEGACY_KEYS.CUSTOM_TOKENS);
    return raw ? (JSON.parse(raw) as TokenConfig[]) : [];
  } catch {
    return [];
  }
}

export function saveCustomTokens(tokens: TokenConfig[]): void {
  writeScopedRaw(LEGACY_KEYS.CUSTOM_TOKENS, JSON.stringify(tokens));
}

export interface VaultSettings {
  currency: 'USD' | 'EUR' | 'GBP';
  autoLockMinutes: number;
  selectedNetworkFilter: NetworkId | 'all';
}

export function loadSettings(): VaultSettings {
  try {
    const raw = readScopedRaw(LEGACY_KEYS.SETTINGS);
    return raw
      ? (JSON.parse(raw) as VaultSettings)
      : { currency: 'USD', autoLockMinutes: 15, selectedNetworkFilter: 'all' };
  } catch {
    return { currency: 'USD', autoLockMinutes: 15, selectedNetworkFilter: 'all' };
  }
}

export function saveSettings(settings: VaultSettings): void {
  writeScopedRaw(LEGACY_KEYS.SETTINGS, JSON.stringify(settings));
}

export function clearAllVaultData(): void {
  Object.values(LEGACY_KEYS).forEach((k) => removeScopedRaw(k));
  clearSessionUnlockToken(currentUserScope);
}

const WALLET_AUTH_SESSION_KEY = 'obsidian_wallet_auth_session_v1';

export function loadWalletAuthSession(): WalletAuthSession | null {
  try {
    const raw = localStorage.getItem(WALLET_AUTH_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WalletAuthSession;
    if (!parsed?.id || !parsed?.address || !parsed?.kind) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveWalletAuthSession(session: WalletAuthSession | null): void {
  if (!session) {
    localStorage.removeItem(WALLET_AUTH_SESSION_KEY);
    return;
  }
  localStorage.setItem(WALLET_AUTH_SESSION_KEY, JSON.stringify(session));
}

export function clearWalletAuthSession(): void {
  localStorage.removeItem(WALLET_AUTH_SESSION_KEY);
}

