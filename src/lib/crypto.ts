import {
  HDNodeWallet,
  Mnemonic,
  Wallet,
  getBytes,
  hexlify,
  keccak256,
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
    .replace(/(?:^|[\s\n\r,;])#?\d+[.):-]\s*/g, ' ')
    .replace(/[\n\r\t,;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

// Monero Base58 block alphabet & Ed25519 scalar cryptography
const XMR_B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const XMR_ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];

function bytesToLeBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

function leBigIntToBytes32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let cur = n;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(cur & 0xffn);
    cur >>= 8n;
  }
  return out;
}

function moneroBase58EncodeBlock(data: Uint8Array): string {
  let num = 0n;
  for (let i = 0; i < data.length; i++) {
    num = (num << 8n) | BigInt(data[i]);
  }
  const targetLen = XMR_ENCODED_BLOCK_SIZES[data.length];
  let res = '';
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    res = XMR_B58_ALPHABET[rem] + res;
  }
  return res.padStart(targetLen, '1');
}

function moneroBase58Encode(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 8) {
    out += moneroBase58EncodeBlock(data.subarray(i, Math.min(i + 8, data.length)));
  }
  return out;
}

function moneroBase58Decode(addr: string): Uint8Array | null {
  const fullBlockSize = 11;
  const bytes: number[] = [];
  for (let i = 0; i < addr.length; i += fullBlockSize) {
    const chunk = addr.slice(i, i + fullBlockSize);
    const outBytesLen = XMR_ENCODED_BLOCK_SIZES.indexOf(chunk.length);
    if (outBytesLen <= 0) return null;

    let num = 0n;
    for (let j = 0; j < chunk.length; j++) {
      const idx = XMR_B58_ALPHABET.indexOf(chunk[j]);
      if (idx < 0) return null;
      num = num * 58n + BigInt(idx);
    }

    const block = new Uint8Array(outBytesLen);
    for (let k = outBytesLen - 1; k >= 0; k--) {
      block[k] = Number(num & 0xffn);
      num >>= 8n;
    }
    if (num > 0n) return null;
    for (let k = 0; k < outBytesLen; k++) bytes.push(block[k]);
  }
  return new Uint8Array(bytes);
}

function deriveMoneroFromSpendBytes(rawSeed: Uint8Array): {
  address: string;
  spendKeyHex: string;
  viewKeyHex: string;
} {
  const curveOrder = ed25519.Point.CURVE().n;

  let spendScalar = bytesToLeBigInt(rawSeed) % curveOrder;
  if (spendScalar === 0n) spendScalar = 1n;
  const spendBytes = leBigIntToBytes32(spendScalar);

  const viewHash = getBytes(keccak256(spendBytes));
  let viewScalar = bytesToLeBigInt(viewHash) % curveOrder;
  if (viewScalar === 0n) viewScalar = 1n;
  const viewBytes = leBigIntToBytes32(viewScalar);

  const pubSpend = ed25519.Point.BASE.multiply(spendScalar).toBytes();
  const pubView = ed25519.Point.BASE.multiply(viewScalar).toBytes();

  const payload = new Uint8Array(65);
  payload[0] = 0x12; // Monero Mainnet standard address prefix ('4...')
  payload.set(pubSpend, 1);
  payload.set(pubView, 33);

  const checksum = getBytes(keccak256(payload)).slice(0, 4);
  const full = new Uint8Array(69);
  full.set(payload, 0);
  full.set(checksum, 65);

  return {
    address: moneroBase58Encode(full),
    spendKeyHex: hexlify(spendBytes).slice(2),
    viewKeyHex: hexlify(viewBytes).slice(2),
  };
}

function deriveMoneroWallet(seed: Uint8Array, path: string): {
  address: string;
  spendKeyHex: string;
  viewKeyHex: string;
} {
  const rawSeed = deriveSlip10Ed25519(seed, path);
  return deriveMoneroFromSpendBytes(rawSeed);
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
  const moneroPath = preset.moneroPathTemplate(idx);

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

  // 4. Monero (XMR) Dual-Key Derivation (Spend + View Ed25519)
  const xmr = deriveMoneroWallet(seedBytes, moneroPath);

  return {
    addresses: {
      evmAddress: evmNode.address,
      evmPath,
      solanaAddress,
      solanaPath,
      bitcoinAddress: btc.address,
      bitcoinPath,
      moneroAddress: xmr.address,
      moneroPath,
    },
    secrets: {
      mnemonic: normalized,
      passphrase: passphrase || undefined,
      evmPrivateKey: evmNode.privateKey,
      solanaSecretBase58,
      bitcoinPrivateKeyHex: btc.privateKeyHex,
      moneroSpendKeyHex: xmr.spendKeyHex,
      moneroViewKeyHex: xmr.viewKeyHex,
    },
  };
}

export function deriveWalletFromPrivateKey(
  rawInput: string,
  keyType: 'auto' | 'evm' | 'solana' | 'monero' = 'auto'
): {
  family: 'evm' | 'solana' | 'monero';
  addresses: DerivedAddresses;
  secrets: UnlockedSecrets;
} {
  const trimmed = rawInput.trim();

  // Check explicit Monero Private Spend Key (or xmr:<64-hex> prefix)
  if (keyType === 'monero' || /^xmr:/i.test(trimmed)) {
    const cleanHex = trimmed.replace(/^xmr:/i, '').replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{64}$/.test(cleanHex)) {
      throw new Error('Monero private spend key must be 64 hexadecimal characters (32 bytes).');
    }
    const spendBytes = getBytes(`0x${cleanHex}`);
    const xmr = deriveMoneroFromSpendBytes(spendBytes);
    return {
      family: 'monero',
      addresses: {
        evmAddress: '',
        evmPath: 'N/A',
        solanaAddress: '',
        solanaPath: 'N/A',
        bitcoinAddress: '',
        bitcoinPath: 'N/A',
        moneroAddress: xmr.address,
        moneroPath: 'Imported Monero Spend Key',
      },
      secrets: {
        moneroSpendKeyHex: xmr.spendKeyHex,
        moneroViewKeyHex: xmr.viewKeyHex,
      },
    };
  }

  // Check EVM hex private key
  if ((keyType === 'auto' || keyType === 'evm') && /^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
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
        moneroAddress: '',
        moneroPath: 'N/A',
      },
      secrets: {
        evmPrivateKey: wallet.privateKey,
      },
    };
  }

  // Check Solana Base58 private key (64-byte secret key or 32-byte seed)
  if (keyType === 'auto' || keyType === 'solana') {
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
            moneroAddress: '',
            moneroPath: 'N/A',
          },
          secrets: {
            solanaSecretBase58: bs58.encode(full64),
          },
        };
      }
    } catch {
      // Not valid base58
    }
  }

  throw new Error(
    'Invalid private key. Enter a 64-char EVM hex key, Solana Base58 secret key, or switch to Monero Private Spend Key.'
  );
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

export function isValidMoneroAddress(address: string): boolean {
  const trimmed = address.trim();
  if (trimmed.length !== 95 && trimmed.length !== 106) return false;
  if (!/^[48][1-9A-HJ-NP-Za-km-z]+$/.test(trimmed)) return false;
  const decoded = moneroBase58Decode(trimmed);
  if (!decoded || (decoded.length !== 69 && decoded.length !== 77)) return false;
  const prefix = decoded[0];
  if (prefix !== 0x12 && prefix !== 0x2a && prefix !== 0x13) return false;
  const payload = decoded.subarray(0, decoded.length - 4);
  const checksum = decoded.subarray(decoded.length - 4);
  const expected = getBytes(keccak256(payload)).slice(0, 4);
  return checksum.every((b, idx) => b === expected[idx]);
}
