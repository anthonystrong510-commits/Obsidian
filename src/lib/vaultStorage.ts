import type {
  AddressBookEntry,
  NetworkId,
  PriceAlert,
  TokenConfig,
  UnlockedSecrets,
  WalletAccount,
  WalletTransaction,
} from '../types/wallet';

const STORAGE_KEYS = {
  WALLETS: 'obsidian_vault_wallets_v1',
  ACTIVE_WALLET_ID: 'obsidian_vault_active_id_v1',
  PASSWORD_VERIFIER: 'obsidian_vault_verifier_v1',
  ALERTS: 'obsidian_vault_alerts_v1',
  LOCAL_TXS: 'obsidian_vault_txs_v1',
  ADDRESS_BOOK: 'obsidian_vault_contacts_v1',
  CUSTOM_TOKENS: 'obsidian_vault_custom_tokens_v1',
  SETTINGS: 'obsidian_vault_settings_v1',
};

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
  localStorage.setItem(STORAGE_KEYS.PASSWORD_VERIFIER, encrypted);
}

export async function verifyVaultPassword(password: string): Promise<boolean> {
  const raw = localStorage.getItem(STORAGE_KEYS.PASSWORD_VERIFIER);
  if (!raw) return true;
  try {
    const res = await decryptPayload<{ check: string }>(raw, password);
    return res.check === 'OBSIDIAN_VAULT_OK';
  } catch {
    return false;
  }
}

export function hasVaultPassword(): boolean {
  return Boolean(localStorage.getItem(STORAGE_KEYS.PASSWORD_VERIFIER));
}

export function loadWallets(): WalletAccount[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.WALLETS);
    return raw ? (JSON.parse(raw) as WalletAccount[]) : [];
  } catch {
    return [];
  }
}

export function saveWallets(wallets: WalletAccount[]): void {
  localStorage.setItem(STORAGE_KEYS.WALLETS, JSON.stringify(wallets));
}

export function loadActiveWalletId(): string | null {
  return localStorage.getItem(STORAGE_KEYS.ACTIVE_WALLET_ID);
}

export function saveActiveWalletId(id: string | null): void {
  if (id) {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_WALLET_ID, id);
  } else {
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_WALLET_ID);
  }
}

export async function unlockWalletSecrets(
  wallet: WalletAccount,
  password: string
): Promise<UnlockedSecrets> {
  if (!wallet.encryptedSecret) return {};
  return decryptPayload<UnlockedSecrets>(wallet.encryptedSecret, password);
}

export function loadAlerts(): PriceAlert[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.ALERTS);
    return raw ? (JSON.parse(raw) as PriceAlert[]) : [];
  } catch {
    return [];
  }
}

export function saveAlerts(alerts: PriceAlert[]): void {
  localStorage.setItem(STORAGE_KEYS.ALERTS, JSON.stringify(alerts));
}

export function loadLocalTxs(): WalletTransaction[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.LOCAL_TXS);
    return raw ? (JSON.parse(raw) as WalletTransaction[]) : [];
  } catch {
    return [];
  }
}

export function saveLocalTxs(txs: WalletTransaction[]): void {
  localStorage.setItem(STORAGE_KEYS.LOCAL_TXS, JSON.stringify(txs.slice(0, 100)));
}

export function loadAddressBook(): AddressBookEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.ADDRESS_BOOK);
    return raw ? (JSON.parse(raw) as AddressBookEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveAddressBook(entries: AddressBookEntry[]): void {
  localStorage.setItem(STORAGE_KEYS.ADDRESS_BOOK, JSON.stringify(entries));
}

export function loadCustomTokens(): TokenConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CUSTOM_TOKENS);
    return raw ? (JSON.parse(raw) as TokenConfig[]) : [];
  } catch {
    return [];
  }
}

export function saveCustomTokens(tokens: TokenConfig[]): void {
  localStorage.setItem(STORAGE_KEYS.CUSTOM_TOKENS, JSON.stringify(tokens));
}

export interface VaultSettings {
  currency: 'USD' | 'EUR' | 'GBP';
  autoLockMinutes: number;
  selectedNetworkFilter: NetworkId | 'all';
}

export function loadSettings(): VaultSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    return raw
      ? (JSON.parse(raw) as VaultSettings)
      : { currency: 'USD', autoLockMinutes: 15, selectedNetworkFilter: 'all' };
  } catch {
    return { currency: 'USD', autoLockMinutes: 15, selectedNetworkFilter: 'all' };
  }
}

export function saveSettings(settings: VaultSettings): void {
  localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
}

export function clearAllVaultData(): void {
  Object.values(STORAGE_KEYS).forEach((k) => localStorage.removeItem(k));
}
