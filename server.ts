import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

interface MarketCoin {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  price_change_percentage_24h: number;
  market_cap: number;
  total_volume: number;
  high_24h: number;
  low_24h: number;
  sparkline_in_7d?: { price: number[] };
  last_updated: string;
  source: string;
}

const TRACKED_COINS: Array<{ id: string; symbol: string; name: string }> = [
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin' },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum' },
  { id: 'solana', symbol: 'SOL', name: 'Solana' },
  { id: 'binancecoin', symbol: 'BNB', name: 'BNB' },
  { id: 'matic-network', symbol: 'POL', name: 'Polygon' },
  { id: 'avalanche-2', symbol: 'AVAX', name: 'Avalanche' },
  { id: 'arbitrum', symbol: 'ARB', name: 'Arbitrum' },
  { id: 'optimism', symbol: 'OP', name: 'Optimism' },
  { id: 'chainlink', symbol: 'LINK', name: 'Chainlink' },
  { id: 'uniswap', symbol: 'UNI', name: 'Uniswap' },
  { id: 'aave', symbol: 'AAVE', name: 'Aave' },
  { id: 'usd-coin', symbol: 'USDC', name: 'USD Coin' },
  { id: 'tether', symbol: 'USDT', name: 'Tether' },
  { id: 'wrapped-bitcoin', symbol: 'WBTC', name: 'Wrapped Bitcoin' },
  { id: 'dai', symbol: 'DAI', name: 'Dai' },
  { id: 'tron', symbol: 'TRX', name: 'TRON' },
  { id: 'monero', symbol: 'XMR', name: 'Monero' },
];

const RPC_ENDPOINTS: Record<string, string[]> = {
  ethereum: [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
  ],
  arbitrum: [
    'https://arb1.arbitrum.io/rpc',
    'https://arbitrum-one-rpc.publicnode.com',
  ],
  optimism: [
    'https://mainnet.optimism.io',
    'https://optimism-rpc.publicnode.com',
  ],
  base: [
    'https://mainnet.base.org',
    'https://base-rpc.publicnode.com',
  ],
  polygon: [
    'https://polygon-bor-rpc.publicnode.com',
    'https://polygon-rpc.com',
  ],
  bsc: [
    'https://bsc-rpc.publicnode.com',
    'https://bsc-dataseed.binance.org',
  ],
  avalanche: [
    'https://avalanche-c-chain-rpc.publicnode.com',
    'https://api.avax.network/ext/bc/C/rpc',
  ],
  sepolia: [
    'https://ethereum-sepolia-rpc.publicnode.com',
    'https://rpc.sepolia.org',
  ],
  solana: [
    'https://solana-rpc.publicnode.com',
    'https://api.mainnet-beta.solana.com',
  ],
};

const BLOCKSCOUT_URLS: Record<string, string> = {
  ethereum: 'https://eth.blockscout.com/api/v2',
  arbitrum: 'https://arbitrum.blockscout.com/api/v2',
  optimism: 'https://optimism.blockscout.com/api/v2',
  base: 'https://base.blockscout.com/api/v2',
  polygon: 'https://polygon.blockscout.com/api/v2',
  sepolia: 'https://eth-sepolia.blockscout.com/api/v2',
};

let marketCache: { data: MarketCoin[]; timestamp: number } = {
  data: [],
  timestamp: 0,
};

const historyCache = new Map<string, { data: Array<[number, number]>; timestamp: number }>();

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 7000): Promise<globalThis.Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function fetchCryptoCompareMarkets(): Promise<MarketCoin[]> {
  const fsyms = TRACKED_COINS.map((c) => (c.symbol === 'POL' ? 'POL,MATIC' : c.symbol)).join(',');
  const url = `https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${encodeURIComponent(fsyms)}&tsyms=USD`;
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) throw new Error(`CryptoCompare HTTP ${resp.status}`);
  const json = (await resp.json()) as { RAW?: Record<string, { USD?: Record<string, number> }> };
  const raw = json.RAW || {};

  return TRACKED_COINS.map((coin) => {
    const entry = raw[coin.symbol]?.USD || (coin.symbol === 'POL' ? raw['MATIC']?.USD : undefined);
    const price = entry?.PRICE ?? (coin.symbol === 'USDC' || coin.symbol === 'USDT' || coin.symbol === 'DAI' ? 1 : 0);
    return {
      id: coin.id,
      symbol: coin.symbol,
      name: coin.name,
      current_price: price,
      price_change_percentage_24h: entry?.CHANGEPCT24HOUR ?? 0,
      market_cap: entry?.MKTCAP ?? 0,
      total_volume: entry?.TOTALVOLUME24HTO ?? 0,
      high_24h: entry?.HIGH24HOUR ?? price,
      low_24h: entry?.LOW24HOUR ?? price,
      last_updated: new Date().toISOString(),
      source: 'cryptocompare',
    };
  }).filter((c) => c.current_price > 0);
}

async function fetchCoinGeckoMarkets(): Promise<MarketCoin[]> {
  const ids = TRACKED_COINS.map((c) => c.id).join(',');
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids)}&order=market_cap_desc&per_page=50&page=1&sparkline=true&price_change_percentage=24h`;
  const resp = await fetchWithTimeout(url, {
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);
  const data = (await resp.json()) as Array<{
    id: string;
    symbol: string;
    name: string;
    current_price: number;
    price_change_percentage_24h: number | null;
    market_cap: number;
    total_volume: number;
    high_24h: number;
    low_24h: number;
    sparkline_in_7d?: { price: number[] };
    last_updated: string;
  }>;

  return data.map((d) => ({
    id: d.id,
    symbol: d.symbol.toUpperCase() === 'MATIC' ? 'POL' : d.symbol.toUpperCase(),
    name: d.name,
    current_price: d.current_price,
    price_change_percentage_24h: d.price_change_percentage_24h ?? 0,
    market_cap: d.market_cap ?? 0,
    total_volume: d.total_volume ?? 0,
    high_24h: d.high_24h ?? d.current_price,
    low_24h: d.low_24h ?? d.current_price,
    sparkline_in_7d: d.sparkline_in_7d,
    last_updated: d.last_updated || new Date().toISOString(),
    source: 'coingecko',
  }));
}

async function getLiveMarkets(forceRefresh = false): Promise<MarketCoin[]> {
  const now = Date.now();
  if (!forceRefresh && marketCache.data.length > 0 && now - marketCache.timestamp < 9000) {
    return marketCache.data;
  }

  // Prefer CryptoCompare for fast unthrottled spot + CoinGecko sparklines if available
  try {
    const cg = await fetchCoinGeckoMarkets();
    if (cg.length > 0) {
      marketCache = { data: cg, timestamp: now };
      return cg;
    }
  } catch {
    // Fallback to CryptoCompare
  }

  try {
    const cc = await fetchCryptoCompareMarkets();
    if (cc.length > 0) {
      // Preserve sparklines from previous cache if any
      const prevSparklines = new Map(marketCache.data.map((m) => [m.id, m.sparkline_in_7d]));
      const merged = cc.map((m) => ({
        ...m,
        sparkline_in_7d: prevSparklines.get(m.id),
      }));
      marketCache = { data: merged, timestamp: now };
      return merged;
    }
  } catch {
    // Return stale cache if both upstream providers transiently fail
  }

  return marketCache.data;
}

async function fetchCoinHistory(coinId: string, days: string): Promise<Array<[number, number]>> {
  const cacheKey = `${coinId}:${days}`;
  const cached = historyCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 60000) {
    return cached.data;
  }

  try {
    const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${encodeURIComponent(days)}`;
    const resp = await fetchWithTimeout(url);
    if (resp.ok) {
      const json = (await resp.json()) as { prices?: Array<[number, number]> };
      if (json.prices && json.prices.length > 0) {
        historyCache.set(cacheKey, { data: json.prices, timestamp: Date.now() });
        return json.prices;
      }
    }
  } catch {
    // Fall back to CryptoCompare
  }

  const coin = TRACKED_COINS.find((c) => c.id === coinId);
  const fsym = coin ? (coin.symbol === 'POL' ? 'MATIC' : coin.symbol) : 'ETH';
  const isHourly = days === '1' || days === '7';
  const endpoint = isHourly ? 'histohour' : 'histoday';
  const limit = days === '1' ? 24 : days === '7' ? 168 : days === '30' ? 30 : 365;
  const ccUrl = `https://min-api.cryptocompare.com/data/v2/${endpoint}?fsym=${encodeURIComponent(fsym)}&tsym=USD&limit=${limit}`;
  const ccResp = await fetchWithTimeout(ccUrl);
  if (!ccResp.ok) {
    return cached?.data || [];
  }
  const ccJson = (await ccResp.json()) as { Data?: { Data?: Array<{ time: number; close: number }> } };
  const rows = ccJson.Data?.Data || [];
  const points: Array<[number, number]> = rows.map((r) => [r.time * 1000, r.close]);
  if (points.length > 0) {
    historyCache.set(cacheKey, { data: points, timestamp: Date.now() });
  }
  return points;
}

const ALLOWED_HISTORY_DAYS = new Set(['1', '7', '30', '90', '365']);
const ALLOWED_RPC_METHODS = new Set([
  // EVM read & broadcast
  'eth_chainId',
  'net_version',
  'eth_blockNumber',
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
  'eth_getBalance',
  'eth_call',
  'eth_estimateGas',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_getCode',
  'eth_sendRawTransaction',
  // Solana read & broadcast
  'getBalance',
  'getLatestBlockhash',
  'getSlot',
  'getFeeForMessage',
  'getSignaturesForAddress',
  'getTransaction',
  'getAccountInfo',
  'getTokenAccountsByOwner',
  'sendTransaction',
  'simulateTransaction',
]);

const BTC_ADDR_REGEX = /^(?:[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[ac-hj-np-z02-9]{11,71})$/;
const EVM_ADDR_REGEX = /^0x[a-fA-F0-9]{40}$/;
const SOL_ADDR_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const ipRateMap = new Map<string, { count: number; resetAt: number }>();
let activeSseClients = 0;
const MAX_SSE_CLIENTS = 100;

function checkApiRateLimit(ip: string, maxPerMin = 300): boolean {
  const now = Date.now();
  const entry = ipRateMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    ipRateMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= maxPerMin) {
    return false;
  }
  entry.count += 1;
  return true;
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Security headers compatible with AI Studio iframe hosting & Firebase Auth popups
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://apis.google.com https://www.gstatic.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "img-src 'self' data: https: blob:",
        "connect-src 'self' https: wss: ws:",
        "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; ')
    );
    next();
  });

  app.use('/api', (req, res, next) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkApiRateLimit(clientIp, 300)) {
      res.status(429).json({ error: 'Rate limit exceeded. Please wait briefly and retry.' });
      return;
    }
    next();
  });

  app.use(express.json({ limit: '512kb' }));

  // Live market prices
  app.get('/api/markets', async (req: Request, res: Response) => {
    try {
      const force = req.query.force === '1';
      const data = await getLiveMarkets(force);
      res.json({ coins: data, updatedAt: new Date().toISOString() });
    } catch {
      res.status(502).json({ error: 'Market price feed temporarily unavailable' });
    }
  });

  // Historical chart prices
  app.get('/api/markets/history', async (req: Request, res: Response) => {
    const coinId = String(req.query.coinId || 'ethereum').toLowerCase();
    const days = String(req.query.days || '7');
    if (!TRACKED_COINS.some((c) => c.id === coinId) || !ALLOWED_HISTORY_DAYS.has(days)) {
      res.status(400).json({ error: 'Invalid coinId or timeframe parameter' });
      return;
    }
    try {
      const prices = await fetchCoinHistory(coinId, days);
      res.json({ coinId, days, prices });
    } catch {
      res.status(502).json({ error: 'Price history temporarily unavailable' });
    }
  });

  // Server-Sent Events real-time price stream for price alerts & live ticker
  app.get('/api/stream/prices', async (req: Request, res: Response) => {
    if (activeSseClients >= MAX_SSE_CLIENTS) {
      res.status(503).json({ error: 'Price stream capacity reached' });
      return;
    }
    activeSseClients += 1;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const pushSnapshot = async () => {
      try {
        const coins = await getLiveMarkets();
        if (coins.length > 0 && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ coins, ts: Date.now() })}\n\n`);
        }
      } catch {
        // Ignore transient upstream error in stream tick
      }
    };

    await pushSnapshot();
    const timer = setInterval(pushSnapshot, 8000);
    req.on('close', () => {
      clearInterval(timer);
      activeSseClients = Math.max(0, activeSseClients - 1);
      res.end();
    });
  });

  // Multi-chain Web3 RPC proxy (strict JSON-RPC 2.0 + method allowlist)
  app.post('/api/rpc', async (req: Request, res: Response) => {
    const network = String(req.query.network || 'ethereum').toLowerCase();
    const endpoints = RPC_ENDPOINTS[network];
    if (!endpoints || endpoints.length === 0) {
      res.status(400).json({ error: 'Unsupported RPC network' });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      body.jsonrpc !== '2.0' ||
      typeof body.method !== 'string' ||
      !ALLOWED_RPC_METHODS.has(body.method)
    ) {
      res.status(400).json({ error: 'Invalid or disallowed JSON-RPC request method' });
      return;
    }

    const sanitizedPayload = JSON.stringify({
      jsonrpc: '2.0',
      id: body.id ?? 1,
      method: body.method,
      params: Array.isArray(body.params) ? body.params : [],
    });

    for (const rpcUrl of endpoints) {
      try {
        const upstream = await fetchWithTimeout(
          rpcUrl,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: sanitizedPayload,
          },
          7000
        );
        if (upstream.ok) {
          const text = await upstream.text();
          res.setHeader('Content-Type', 'application/json');
          res.send(text);
          return;
        }
      } catch {
        // try next endpoint without leaking upstream URL or stack
      }
    }

    res.status(502).json({ error: 'Upstream RPC providers unavailable' });
  });

  // Bitcoin mainnet address & transactions via Mempool.space
  app.get('/api/btc/address/:address', async (req: Request, res: Response) => {
    const address = String(req.params.address || '').trim();
    if (!BTC_ADDR_REGEX.test(address)) {
      res.status(400).json({ error: 'Invalid Bitcoin address format' });
      return;
    }
    const baseUrls = ['https://mempool.space/api', 'https://blockstream.info/api'];

    for (const base of baseUrls) {
      try {
        const [infoResp, txsResp] = await Promise.all([
          fetchWithTimeout(`${base}/address/${encodeURIComponent(address)}`),
          fetchWithTimeout(`${base}/address/${encodeURIComponent(address)}/txs`),
        ]);
        if (infoResp.ok) {
          const info = (await infoResp.json()) as {
            chain_stats?: { funded_txo_sum: number; spent_txo_sum: number };
            mempool_stats?: { funded_txo_sum: number; spent_txo_sum: number };
          };
          const txs = txsResp.ok ? await txsResp.json() : [];
          const confirmedSats =
            (info.chain_stats?.funded_txo_sum ?? 0) - (info.chain_stats?.spent_txo_sum ?? 0);
          const unconfirmedSats =
            (info.mempool_stats?.funded_txo_sum ?? 0) - (info.mempool_stats?.spent_txo_sum ?? 0);
          res.json({
            address,
            satoshis: confirmedSats + unconfirmedSats,
            btc: (confirmedSats + unconfirmedSats) / 1e8,
            txs: Array.isArray(txs) ? txs.slice(0, 15) : [],
          });
          return;
        }
      } catch {
        // try next endpoint
      }
    }

    res.status(502).json({ error: 'Unable to fetch Bitcoin address info' });
  });

  // Monero daemon info (live height & fee estimate)
  app.get('/api/monero/info', async (_req: Request, res: Response) => {
    const nodes = [
      'https://xmr-node.cakewallet.com:18081/json_rpc',
      'https://node.moneroworld.com:18089/json_rpc',
    ];
    for (const nodeUrl of nodes) {
      try {
        const resp = await fetchWithTimeout(
          nodeUrl,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info' }),
          },
          6000
        );
        if (resp.ok) {
          const json = (await resp.json()) as {
            result?: { height?: number; target?: number; status?: string };
          };
          if (json.result?.height) {
            res.json({
              height: json.result.height,
              healthy: true,
            });
            return;
          }
        }
      } catch {
        // try next public Monero daemon
      }
    }
    res.json({ height: null, healthy: false });
  });

  // On-chain transaction history via Blockscout / Solana RPC
  app.get('/api/txs/:network/:address', async (req: Request, res: Response) => {
    const net = String(req.params.network || '').toLowerCase();
    const address = String(req.params.address || '').trim();

    if (net === 'solana') {
      if (!SOL_ADDR_REGEX.test(address)) {
        res.status(400).json({ error: 'Invalid Solana address format' });
        return;
      }
      const endpoints = RPC_ENDPOINTS.solana;
      for (const rpcUrl of endpoints) {
        try {
          const resp = await fetchWithTimeout(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'getSignaturesForAddress',
              params: [address, { limit: 12 }],
            }),
          });
          if (resp.ok) {
            const json = (await resp.json()) as {
              result?: Array<{ signature: string; blockTime?: number; err: unknown; slot: number }>;
            };
            const txs = (json.result || []).map((item) => ({
              hash: item.signature,
              timestamp: item.blockTime ? item.blockTime * 1000 : Date.now(),
              status: item.err ? 'failed' : 'confirmed',
              network: 'solana',
              type: 'on-chain',
              from: address,
              to: 'Solana Network',
              valueFormatted: 'SOL Tx',
              slot: item.slot,
            }));
            res.json({ transactions: txs });
            return;
          }
        } catch {
          // continue
        }
      }
      res.json({ transactions: [] });
      return;
    }

    const blockscoutBase = BLOCKSCOUT_URLS[net];
    if (!blockscoutBase || !EVM_ADDR_REGEX.test(address)) {
      res.status(400).json({ error: 'Invalid network or EVM address format' });
      return;
    }

    try {
      const resp = await fetchWithTimeout(
        `${blockscoutBase}/addresses/${encodeURIComponent(address)}/transactions`
      );
      if (!resp.ok) {
        res.json({ transactions: [] });
        return;
      }
      const json = (await resp.json()) as {
        items?: Array<{
          hash: string;
          timestamp: string;
          status: string;
          from?: { hash: string };
          to?: { hash: string };
          value?: string;
          method?: string;
        }>;
      };
      const txs = (json.items || []).slice(0, 15).map((item) => ({
        hash: item.hash,
        timestamp: item.timestamp ? new Date(item.timestamp).getTime() : Date.now(),
        status: item.status === 'error' ? 'failed' : 'confirmed',
        network: net,
        type: item.from?.hash?.toLowerCase() === address.toLowerCase() ? 'send' : 'receive',
        from: item.from?.hash || '',
        to: item.to?.hash || '',
        valueWei: item.value || '0',
        method: item.method || 'transfer',
      }));
      res.json({ transactions: txs });
    } catch {
      res.json({ transactions: [] });
    }
  });

  const httpServer = http.createServer(app);

  // Vite dev middleware or static dist serving
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server: httpServer },
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req: Request, res: Response) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Obsidian Vault server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
