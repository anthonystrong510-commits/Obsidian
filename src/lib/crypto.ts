import {
  HDNodeWallet,
  Mnemonic,
  Wallet,
  getBytes,
  hexlify,
  randomBytes,
  wordlists,
} from 'ethers';
import { HDKey } from '@scure/bip32';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import { bech32 } from 'bech32';
import { WALLET_PRESETS } from './networks';
import type { DerivedAddresses, UnlockedSecrets, WalletPresetId } from '../types/wallet';

// Extract full 2048-word BIP-39 English wordlist from ethers
export const BIP39_WORDLIST: string[] = Array.from({ length: 2048 }, (_, i) =>
  wordlists.en.getWord(i)
);

export const BIP39_WORD_SET = new Set(BIP39_WORDLIST);

export function generateMnemonicWords(wordCount: 12 | 18 | 24): string[] {
  const entropyBytes = wordCount === 12 ? 16 : wordCount === 18 ? 24 : 32;
  const entropy = randomBytes(entropyBytes);
  const mnemonic = Mnemonic.fromEntropy(entropy);
  return mnemonic.phrase.split(' ');
}

export function normalizePhrase(wordsOrPhrase: string | string[]): string {
  const raw = Array.isArray(wordsOrPhrase) ? wordsOrPhrase.join(' ') : wordsOrPhrase;
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\n\r\t,;]+/g, ' ')
    .replace(/\s+/g, ' ');
}

export function validateMnemonicPhrase(phrase: string): {
  valid: boolean;
  wordCount: number;
  invalidWords: Array<{ index: number; word: string }>;
  error?: string;
} {
  const normalized = normalizePhrase(phrase);
  if (!normalized) {
    return { valid: false, wordCount: 0, invalidWords: [], error: 'Enter your recovery phrase.' };
  }
  const words = normalized.split(' ');
  const invalidWords: Array<{ index: number; word: string }> = [];
  words.forEach((w, idx) => {
    if (!BIP39_WORD_SET.has(w)) {
      invalidWords.push({ index: idx, word: w });
    }
  });

  if (words.length !== 12 && words.length !== 18 && words.length !== 24) {
    return {
      valid: false,
      wordCount: words.length,
      invalidWords,
      error: `Expected 12, 18, or 24 words (detected ${words.length}).`,
    };
  }

  if (invalidWords.length > 0) {
    return {
      valid: false,
      wordCount: words.length,
      invalidWords,
      error: `Word #${invalidWords[0].index + 1} ("${invalidWords[0].word}") is not in the BIP-39 wordlist.`,
    };
  }

  const checksumOk = Mnemonic.isValidMnemonic(normalized);
  return {
    valid: checksumOk,
    wordCount: words.length,
    invalidWords: [],
    error: checksumOk ? undefined : 'BIP-39 checksum mismatch. Verify word order.',
  };
}

// SLIP-0010 Ed25519 deterministic key derivation for Solana (m/44'/501'/...)
function deriveSlip10Ed25519(seed: Uint8Array, path: string): Uint8Array {
  const encoder = new TextEncoder();
  let I = hmac(sha512, encoder.encode('ed25519 seed'), seed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32, 64);

  const segments = path
    .replace(/^m\/?/, '')
    .split('/')
    .filter(Boolean);

  for (const segment of segments) {
    const hardenedIndex = parseInt(segment.replace("'", ''), 10) + 0x80000000;
    const data = new Uint8Array(37);
    data[0] = 0x00;
    data.set(key, 1);
    data[33] = (hardenedIndex >>> 24) & 0xff;
    data[34] = (hardenedIndex >>> 16) & 0xff;
    data[35] = (hardenedIndex >>> 8) & 0xff;
    data[36] = hardenedIndex & 0xff;

    I = hmac(sha512, chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32, 64);
  }

  return key;
}

// BIP-84 Native SegWit (bc1q...) address from compressed secp256k1 public key
function deriveBitcoinSegwitAddress(seed: Uint8Array, path: string): {
  address: string;
  privateKeyHex: string;
} {
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(path);
  if (!child.publicKey || !child.privateKey) {
    throw new Error('Failed to derive Bitcoin BIP-84 keypair');
  }
  const pubHash160 = ripemd160(sha256(child.publicKey));
  const words = bech32.toWords(pubHash160);
  const address = bech32.encode('bc', [0, ...words]);
  return {
    address,
    privateKeyHex: hexlify(child.privateKey),
  };
}

export function deriveWalletFromMnemonic(
  phrase: string,
  options: {
    preset?: WalletPresetId;
    accountIndex?: number;
    passphrase?: string;
    customEvmPath?: string;
    customSolanaPath?: string;
    customBitcoinPath?: string;
  } = {}
): {
  addresses: DerivedAddresses;
  secrets: UnlockedSecrets;
} {
  const normalized = normalizePhrase(phrase);
  const preset =
    WALLET_PRESETS.find((p) => p.id === (options.preset || 'standard')) || WALLET_PRESETS[0];
  const idx = options.accountIndex ?? 0;
  const passphrase = options.passphrase || '';

  const evmPath = options.customEvmPath?.trim() || preset.evmPathTemplate(idx);
  const solanaPath = options.customSolanaPath?.trim() || preset.solanaPathTemplate(idx);
  const bitcoinPath = options.customBitcoinPath?.trim() || preset.bitcoinPathTemplate(idx);

  const mnemonic = Mnemonic.fromPhrase(normalized, passphrase);
  const seedBytes = getBytes(mnemonic.computeSeed());

  // 1. EVM Derivation
  const evmNode = HDNodeWallet.fromMnemonic(mnemonic, evmPath);

  // 2. Solana Ed25519 Derivation (SLIP-0010)
  const solSeedKey = deriveSlip10Ed25519(seedBytes, solanaPath);
  const solPubKey = ed25519.getPublicKey(solSeedKey);
  const solSecret64 = new Uint8Array(64);
  solSecret64.set(solSeedKey, 0);
  solSecret64.set(solPubKey, 32);
  const solanaAddress = bs58.encode(solPubKey);
  const solanaSecretBase58 = bs58.encode(solSecret64);

  // 3. Bitcoin BIP-84 Native SegWit Derivation
  const btc = deriveBitcoinSegwitAddress(seedBytes, bitcoinPath);

  return {
    addresses: {
      evmAddress: evmNode.address,
      evmPath,
      solanaAddress,
      solanaPath,
      bitcoinAddress: btc.address,
      bitcoinPath,
    },
    secrets: {
      mnemonic: normalized,
      passphrase: passphrase || undefined,
      evmPrivateKey: evmNode.privateKey,
      solanaSecretBase58,
      bitcoinPrivateKeyHex: btc.privateKeyHex,
    },
  };
}

export function deriveWalletFromPrivateKey(rawInput: string): {
  family: 'evm' | 'solana';
  addresses: DerivedAddresses;
  secrets: UnlockedSecrets;
} {
  const trimmed = rawInput.trim();

  // Check EVM hex private key
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
    const normalizedHex = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
    const wallet = new Wallet(normalizedHex);
    return {
      family: 'evm',
      addresses: {
        evmAddress: wallet.address,
        evmPath: 'Imported EVM Key',
        solanaAddress: '',
        solanaPath: 'N/A',
        bitcoinAddress: '',
        bitcoinPath: 'N/A',
      },
      secrets: {
        evmPrivateKey: wallet.privateKey,
      },
    };
  }

  // Check Solana Base58 private key (64-byte secret key or 32-byte seed)
  try {
    const decoded = bs58.decode(trimmed);
    if (decoded.length === 64 || decoded.length === 32) {
      const seed32 = decoded.slice(0, 32);
      const pub = ed25519.getPublicKey(seed32);
      const full64 = new Uint8Array(64);
      full64.set(seed32, 0);
      full64.set(pub, 32);
      return {
        family: 'solana',
        addresses: {
          evmAddress: '',
          evmPath: 'N/A',
          solanaAddress: bs58.encode(pub),
          solanaPath: 'Imported Solana Key',
          bitcoinAddress: '',
          bitcoinPath: 'N/A',
        },
        secrets: {
          solanaSecretBase58: bs58.encode(full64),
        },
      };
    }
  } catch {
    // Not valid base58
  }

  throw new Error('Invalid private key. Enter a 64-char EVM hex key or Solana Base58 secret key.');
}

export function shortenAddress(addr: string, start = 6, end = 4): string {
  if (!addr) return '—';
  if (addr.length <= start + end + 3) return addr;
  return `${addr.slice(0, start)}...${addr.slice(-end)}`;
}

export function isValidSolanaAddress(address: string): boolean {
  try {
    const decoded = bs58.decode(address.trim());
    return decoded.length === 32;
  } catch {
    return false;
  }
}

export function isValidBitcoinAddress(address: string): boolean {
  const trimmed = address.trim();
  if (/^(bc1|tb1)[a-zA-HJ-NP-Z0-9]{25,62}$/.test(trimmed)) return true;
  if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(trimmed)) return true;
  return false;
}
