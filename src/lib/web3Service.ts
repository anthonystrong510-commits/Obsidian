import {
  Contract,
  JsonRpcProvider,
  Network,
  Wallet,
  formatEther,
  formatUnits,
  parseEther,
  parseUnits,
} from 'ethers';
import { NETWORKS, NETWORK_MAP } from './networks';
import type {
  DerivedAddresses,
  MarketCoin,
  NetworkId,
  NetworkTelemetry,
  PortfolioHolding,
  TokenConfig,
  WalletTransaction,
} from '../types/wallet';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

const PUBLIC_RPC_FALLBACKS: Record<NetworkId, string> = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  optimism: 'https://mainnet.optimism.io',
  base: 'https://mainnet.base.org',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
  bsc: 'https://bsc-rpc.publicnode.com',
  avalanche: 'https://avalanche-c-chain-rpc.publicnode.com',
  sepolia: 'https://ethereum-sepolia-rpc.publicnode.com',
  solana: 'https://solana-rpc.publicnode.com',
  bitcoin: 'https://mempool.space/api',
  monero: 'https://xmr-node.cakewallet.com:18081/json_rpc',
};

const apiRpcBrokenMap = new Set<NetworkId>();

async function postJsonRpc(networkId: NetworkId, body: unknown): Promise<unknown> {
  const tryEndpoint = async (url: string) => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const ct = resp.headers.get('content-type') || '';
    if (!resp.ok || !ct.includes('application/json')) {
      throw new Error(`Non-JSON or error response from ${url}`);
    }
    return resp.json();
  };

  if (!apiRpcBrokenMap.has(networkId)) {
    try {
      return await tryEndpoint(`${window.location.origin}/api/rpc?network=${networkId}`);
    } catch {
      apiRpcBrokenMap.add(networkId);
    }
  }
  return tryEndpoint(PUBLIC_RPC_FALLBACKS[networkId]);
}

function getRpcUrl(networkId: NetworkId): string {
  if (apiRpcBrokenMap.has(networkId)) {
    return PUBLIC_RPC_FALLBACKS[networkId];
  }
  return `${window.location.origin}/api/rpc?network=${networkId}`;
}

export function getEvmProvider(networkId: NetworkId): JsonRpcProvider {
  const cfg = NETWORK_MAP[networkId];
  const chainId = cfg.chainId || 1;
  const staticNet = Network.from({ name: cfg.id, chainId });
  return new JsonRpcProvider(getRpcUrl(networkId), staticNet, {
    staticNetwork: staticNet,
  });
}

export function getEvmFallbackProvider(networkId: NetworkId): JsonRpcProvider {
  apiRpcBrokenMap.add(networkId);
  const cfg = NETWORK_MAP[networkId];
  const chainId = cfg.chainId || 1;
  const staticNet = Network.from({ name: cfg.id, chainId });
  return new JsonRpcProvider(PUBLIC_RPC_FALLBACKS[networkId], staticNet, {
    staticNetwork: staticNet,
  });
}

export async function resolveEnsAddress(nameOrAddress: string): Promise<string | null> {
  const trimmed = nameOrAddress.trim();
  if (!trimmed.includes('.')) return null;
  try {
    const provider = getEvmProvider('ethereum');
    return await provider.resolveName(trimmed);
  } catch {
    try {
      return await getEvmFallbackProvider('ethereum').resolveName(trimmed);
    } catch {
      return null;
    }
  }
}

export async function fetchCustomErc20Metadata(
  networkId: NetworkId,
  contractAddress: string
): Promise<TokenConfig> {
  let provider = getEvmProvider(networkId);
  try {
    const contract = new Contract(contractAddress, ERC20_ABI, provider);
    const [symbol, name, decimals] = await Promise.all([
      contract.symbol() as Promise<string>,
      contract.name() as Promise<string>,
      contract.decimals() as Promise<bigint>,
    ]);
    return {
      symbol,
      name,
      decimals: Number(decimals),
      address: contractAddress,
      coinGeckoId: symbol.toLowerCase(),
      networkId,
      isCustom: true,
    };
  } catch {
    provider = getEvmFallbackProvider(networkId);
    const contract = new Contract(contractAddress, ERC20_ABI, provider);
    const [symbol, name, decimals] = await Promise.all([
      contract.symbol() as Promise<string>,
      contract.name() as Promise<string>,
      contract.decimals() as Promise<bigint>,
    ]);
    return {
      symbol,
      name,
      decimals: Number(decimals),
      address: contractAddress,
      coinGeckoId: symbol.toLowerCase(),
      networkId,
      isCustom: true,
    };
  }
}

const DIRECT_MARKET_IDS = [
  'bitcoin',
  'ethereum',
  'solana',
  'binancecoin',
  'matic-network',
  'avalanche-2',
  'arbitrum',
  'optimism',
  'chainlink',
  'uniswap',
  'aave',
  'usd-coin',
  'tether',
  'wrapped-bitcoin',
  'dai',
  'monero',
];

export async function fetchLiveMarkets(force = false): Promise<MarketCoin[]> {
  try {
    const resp = await fetch(`/api/markets${force ? '?force=1' : ''}`);
    const ct = resp.headers.get('content-type') || '';
    if (resp.ok && ct.includes('application/json')) {
      const json = (await resp.json()) as { coins: MarketCoin[] };
      if (json.coins && json.coins.length > 0) return json.coins;
    }
  } catch {
    // Fall back to direct CoinGecko / CryptoCompare for static SPA hosts
  }

  try {
    const cgUrl = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(
      DIRECT_MARKET_IDS.join(',')
    )}&order=market_cap_desc&per_page=50&page=1&sparkline=true&price_change_percentage=24h`;
    const resp = await fetch(cgUrl);
    if (resp.ok) {
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
        source: 'coingecko-direct',
      }));
    }
  } catch {
    // ignore
  }

  const ccResp = await fetch(
    'https://min-api.cryptocompare.com/data/pricemultifull?fsyms=BTC,ETH,SOL,BNB,POL,MATIC,AVAX,ARB,OP,LINK,UNI,AAVE,USDC,USDT,WBTC,DAI,XMR&tsyms=USD'
  );
  if (!ccResp.ok) throw new Error('Market feed temporarily unavailable');
  const ccJson = (await ccResp.json()) as { RAW?: Record<string, { USD?: Record<string, number> }> };
  const raw = ccJson.RAW || {};
  const mapList: Array<[string, string, string]> = [
    ['bitcoin', 'BTC', 'Bitcoin'],
    ['ethereum', 'ETH', 'Ethereum'],
    ['solana', 'SOL', 'Solana'],
    ['binancecoin', 'BNB', 'BNB'],
    ['matic-network', 'POL', 'Polygon'],
    ['avalanche-2', 'AVAX', 'Avalanche'],
    ['arbitrum', 'ARB', 'Arbitrum'],
    ['optimism', 'OP', 'Optimism'],
    ['chainlink', 'LINK', 'Chainlink'],
    ['uniswap', 'UNI', 'Uniswap'],
    ['aave', 'AAVE', 'Aave'],
    ['usd-coin', 'USDC', 'USD Coin'],
    ['tether', 'USDT', 'Tether'],
    ['wrapped-bitcoin', 'WBTC', 'Wrapped Bitcoin'],
    ['dai', 'DAI', 'Dai'],
    ['monero', 'XMR', 'Monero'],
  ];
  return mapList
    .map(([id, sym, name]) => {
      const entry = raw[sym]?.USD || (sym === 'POL' ? raw['MATIC']?.USD : undefined);
      const price = entry?.PRICE ?? (sym === 'USDC' || sym === 'USDT' || sym === 'DAI' ? 1 : 0);
      return {
        id,
        symbol: sym,
        name,
        current_price: price,
        price_change_percentage_24h: entry?.CHANGEPCT24HOUR ?? 0,
        market_cap: entry?.MKTCAP ?? 0,
        total_volume: entry?.TOTALVOLUME24HTO ?? 0,
        high_24h: entry?.HIGH24HOUR ?? price,
        low_24h: entry?.LOW24HOUR ?? price,
        last_updated: new Date().toISOString(),
        source: 'cryptocompare-direct',
      };
    })
    .filter((c) => c.current_price > 0);
}

export async function fetchCoinHistory(
  coinId: string,
  days: string
): Promise<Array<[number, number]>> {
  try {
    const resp = await fetch(
      `/api/markets/history?coinId=${encodeURIComponent(coinId)}&days=${encodeURIComponent(days)}`
    );
    const ct = resp.headers.get('content-type') || '';
    if (resp.ok && ct.includes('application/json')) {
      const json = (await resp.json()) as { prices?: Array<[number, number]> };
      if (json.prices && json.prices.length > 0) return json.prices;
    }
  } catch {
    // Fallback
  }
  try {
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${encodeURIComponent(days)}`
    );
    if (!resp.ok) return [];
    const json = (await resp.json()) as { prices?: Array<[number, number]> };
    return json.prices || [];
  } catch {
    return [];
  }
}

async function fetchSolanaBalances(
  address: string,
  tokens: TokenConfig[],
  priceMap: Map<string, MarketCoin>
): Promise<PortfolioHolding[]> {
  if (!address) return [];
  const holdings: PortfolioHolding[] = [];

  try {
    const json = (await postJsonRpc('solana', {
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [address],
    })) as { result?: { value?: number } };
    const lamports = json.result?.value ?? 0;
    const solAmount = lamports / 1e9;
    const market = priceMap.get('solana');
    const price = market?.current_price ?? 0;
    holdings.push({
      id: `solana:native`,
      networkId: 'solana',
      networkName: 'Solana',
      symbol: 'SOL',
      name: 'Solana',
      address: 'native',
      decimals: 9,
      coinGeckoId: 'solana',
      balance: solAmount,
      balanceRaw: String(lamports),
      priceUsd: price,
      change24h: market?.price_change_percentage_24h ?? 0,
      valueUsd: solAmount * price,
      isNative: true,
    });

    // Fetch SPL token accounts for tracked SPL mints
    const splTokens = tokens.filter((t) => t.address !== 'native');
    if (splTokens.length > 0) {
      const splJson = (await postJsonRpc('solana', {
        jsonrpc: '2.0',
        id: 2,
        method: 'getTokenAccountsByOwner',
        params: [
          address,
          { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
          { encoding: 'jsonParsed' },
        ],
      })) as {
        result?: {
          value?: Array<{
            account?: {
              data?: {
                parsed?: {
                  info?: {
                    mint?: string;
                    tokenAmount?: { uiAmount?: number; amount?: string };
                  };
                };
              };
            };
          }>;
        };
      };

      const mintBalances = new Map<string, { uiAmount: number; raw: string }>();
      for (const acc of splJson.result?.value || []) {
        const info = acc.account?.data?.parsed?.info;
        if (info?.mint && info.tokenAmount) {
          mintBalances.set(info.mint, {
            uiAmount: info.tokenAmount.uiAmount ?? 0,
            raw: info.tokenAmount.amount ?? '0',
          });
        }
      }

      for (const tok of splTokens) {
        const bal = mintBalances.get(tok.address);
        const amount = bal?.uiAmount ?? 0;
        const mkt = priceMap.get(tok.coinGeckoId);
        const p = mkt?.current_price ?? (tok.symbol === 'USDC' ? 1 : 0);
        holdings.push({
          id: `solana:${tok.address}`,
          networkId: 'solana',
          networkName: 'Solana',
          symbol: tok.symbol,
          name: tok.name,
          address: tok.address,
          decimals: tok.decimals,
          coinGeckoId: tok.coinGeckoId,
          balance: amount,
          balanceRaw: bal?.raw ?? '0',
          priceUsd: p,
          change24h: mkt?.price_change_percentage_24h ?? 0,
          valueUsd: amount * p,
          isNative: false,
        });
      }
    }
  } catch {
    const market = priceMap.get('solana');
    holdings.push({
      id: `solana:native`,
      networkId: 'solana',
      networkName: 'Solana',
      symbol: 'SOL',
      name: 'Solana',
      address: 'native',
      decimals: 9,
      coinGeckoId: 'solana',
      balance: 0,
      balanceRaw: '0',
      priceUsd: market?.current_price ?? 0,
      change24h: market?.price_change_percentage_24h ?? 0,
      valueUsd: 0,
      isNative: true,
    });
  }

  return holdings;
}

async function fetchBitcoinBalance(
  address: string,
  priceMap: Map<string, MarketCoin>
): Promise<PortfolioHolding[]> {
  if (!address) return [];
  const market = priceMap.get('bitcoin');
  const price = market?.current_price ?? 0;

  try {
    let btcVal = 0;
    let satsVal = 0;
    const resp = await fetch(`/api/btc/address/${encodeURIComponent(address)}`);
    const ct = resp.headers.get('content-type') || '';
    if (resp.ok && ct.includes('application/json')) {
      const json = (await resp.json()) as { btc: number; satoshis: number };
      btcVal = json.btc;
      satsVal = json.satoshis;
    } else {
      const memResp = await fetch(`https://mempool.space/api/address/${encodeURIComponent(address)}`);
      if (!memResp.ok) throw new Error('BTC fetch failed');
      const info = (await memResp.json()) as {
        chain_stats?: { funded_txo_sum: number; spent_txo_sum: number };
        mempool_stats?: { funded_txo_sum: number; spent_txo_sum: number };
      };
      satsVal =
        (info.chain_stats?.funded_txo_sum ?? 0) -
        (info.chain_stats?.spent_txo_sum ?? 0) +
        ((info.mempool_stats?.funded_txo_sum ?? 0) - (info.mempool_stats?.spent_txo_sum ?? 0));
      btcVal = satsVal / 1e8;
    }
    return [
      {
        id: 'bitcoin:native',
        networkId: 'bitcoin',
        networkName: 'Bitcoin',
        symbol: 'BTC',
        name: 'Bitcoin',
        address: 'native',
        decimals: 8,
        coinGeckoId: 'bitcoin',
        balance: btcVal,
        balanceRaw: String(satsVal),
        priceUsd: price,
        change24h: market?.price_change_percentage_24h ?? 0,
        valueUsd: btcVal * price,
        isNative: true,
      },
    ];
  } catch {
    return [
      {
        id: 'bitcoin:native',
        networkId: 'bitcoin',
        networkName: 'Bitcoin',
        symbol: 'BTC',
        name: 'Bitcoin',
        address: 'native',
        decimals: 8,
        coinGeckoId: 'bitcoin',
        balance: 0,
        balanceRaw: '0',
        priceUsd: price,
        change24h: market?.price_change_percentage_24h ?? 0,
        valueUsd: 0,
        isNative: true,
      },
    ];
  }
}

export async function fetchMultiChainPortfolio(
  addresses: DerivedAddresses,
  markets: MarketCoin[],
  customTokens: TokenConfig[] = []
): Promise<PortfolioHolding[]> {
  const priceMap = new Map(markets.map((m) => [m.id, m]));
  const tasks: Array<Promise<PortfolioHolding[]>> = [];

  for (const net of NETWORKS) {
    const extraTokens = customTokens.filter((t) => t.networkId === net.id);
    const allTokens = [...net.tokens, ...extraTokens];

    if (net.family === 'evm' && addresses.evmAddress) {
      tasks.push(
        (async (): Promise<PortfolioHolding[]> => {
          let provider = getEvmProvider(net.id);
          // Probe provider once; if /api/rpc returns non-JSON (e.g. static SPA host), switch to public CORS RPC
          try {
            await provider.getBlockNumber();
          } catch {
            provider = getEvmFallbackProvider(net.id);
          }
          const results: PortfolioHolding[] = [];

          await Promise.all(
            allTokens.map(async (tok) => {
              const market = priceMap.get(tok.coinGeckoId);
              const priceUsd = net.isTestnet
                ? 0
                : market?.current_price ??
                  (tok.symbol === 'USDC' || tok.symbol === 'USDT' ? 1 : 0);
              const change24h = net.isTestnet ? 0 : market?.price_change_percentage_24h ?? 0;

              try {
                let raw = 0n;
                if (tok.address === 'native') {
                  raw = await provider.getBalance(addresses.evmAddress);
                } else {
                  const contract = new Contract(tok.address, ERC20_ABI, provider);
                  raw = (await contract.balanceOf(addresses.evmAddress)) as bigint;
                }
                const balance = Number(formatUnits(raw, tok.decimals));
                results.push({
                  id: `${net.id}:${tok.address}`,
                  networkId: net.id,
                  networkName: net.name,
                  symbol: tok.symbol,
                  name: tok.name,
                  address: tok.address,
                  decimals: tok.decimals,
                  coinGeckoId: tok.coinGeckoId,
                  balance,
                  balanceRaw: raw.toString(),
                  priceUsd,
                  change24h,
                  valueUsd: balance * priceUsd,
                  isNative: tok.address === 'native',
                  isCustom: tok.isCustom,
                });
              } catch {
                results.push({
                  id: `${net.id}:${tok.address}`,
                  networkId: net.id,
                  networkName: net.name,
                  symbol: tok.symbol,
                  name: tok.name,
                  address: tok.address,
                  decimals: tok.decimals,
                  coinGeckoId: tok.coinGeckoId,
                  balance: 0,
                  balanceRaw: '0',
                  priceUsd,
                  change24h,
                  valueUsd: 0,
                  isNative: tok.address === 'native',
                  isCustom: tok.isCustom,
                });
              }
            })
          );

          return results;
        })()
      );
    } else if (net.family === 'solana' && addresses.solanaAddress) {
      tasks.push(fetchSolanaBalances(addresses.solanaAddress, allTokens, priceMap));
    } else if (net.family === 'bitcoin' && addresses.bitcoinAddress) {
      tasks.push(fetchBitcoinBalance(addresses.bitcoinAddress, priceMap));
    } else if (net.family === 'monero' && addresses.moneroAddress) {
      tasks.push(
        (async (): Promise<PortfolioHolding[]> => {
          const market = priceMap.get('monero');
          return [
            {
              id: 'monero:native',
              networkId: 'monero',
              networkName: 'Monero',
              symbol: 'XMR',
              name: 'Monero',
              address: 'native',
              decimals: 12,
              coinGeckoId: 'monero',
              balance: 0,
              balanceRaw: '0',
              priceUsd: market?.current_price ?? 0,
              change24h: market?.price_change_percentage_24h ?? 0,
              valueUsd: 0,
              isNative: true,
            },
          ];
        })()
      );
    }
  }

  const settled = await Promise.all(tasks);
  return settled.flat().sort((a, b) => b.valueUsd - a.valueUsd);
}

export async function fetchNetworkTelemetries(): Promise<NetworkTelemetry[]> {
  return Promise.all(
    NETWORKS.map(async (net): Promise<NetworkTelemetry> => {
      const start = performance.now();
      try {
        if (net.family === 'evm') {
          const provider = getEvmProvider(net.id);
          const [blockNumber, feeData] = await Promise.all([
            provider.getBlockNumber(),
            provider.getFeeData(),
          ]);
          const gasWei = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
          const gasGwei = Number(formatUnits(gasWei, 'gwei'));
          return {
            networkId: net.id,
            blockHeight: blockNumber,
            gasGwei: Number(gasGwei.toFixed(3)),
            latencyMs: Math.round(performance.now() - start),
            healthy: true,
          };
        }
        if (net.family === 'solana') {
          const resp = await fetch(getRpcUrl('solana'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
          });
          const json = (await resp.json()) as { result?: number };
          return {
            networkId: net.id,
            blockHeight: json.result ?? null,
            gasGwei: 0.000005,
            latencyMs: Math.round(performance.now() - start),
            healthy: Boolean(json.result),
          };
        }
        if (net.family === 'monero') {
          const resp = await fetch('/api/monero/info');
          const json = (await resp.json()) as { height?: number | null; healthy?: boolean };
          return {
            networkId: net.id,
            blockHeight: json.height ?? null,
            gasGwei: 0.00002,
            latencyMs: Math.round(performance.now() - start),
            healthy: Boolean(json.healthy),
          };
        }
        // Bitcoin
        const resp = await fetch(`/api/btc/address/bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh`);
        return {
          networkId: net.id,
          blockHeight: null,
          gasGwei: null,
          latencyMs: Math.round(performance.now() - start),
          healthy: resp.ok,
        };
      } catch {
        return {
          networkId: net.id,
          blockHeight: null,
          gasGwei: null,
          latencyMs: null,
          healthy: false,
        };
      }
    })
  );
}

export async function fetchOnChainTransactions(
  addresses: DerivedAddresses
): Promise<WalletTransaction[]> {
  const txs: WalletTransaction[] = [];
  const queries: Array<Promise<void>> = [];

  if (addresses.evmAddress) {
    const evmNets: NetworkId[] = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'sepolia'];
    for (const net of evmNets) {
      queries.push(
        (async () => {
          try {
            const resp = await fetch(`/api/txs/${net}/${addresses.evmAddress}`);
            if (!resp.ok) return;
            const json = (await resp.json()) as {
              transactions?: Array<{
                hash: string;
                timestamp: number;
                status: 'confirmed' | 'failed';
                type: 'send' | 'receive';
                from: string;
                to: string;
                valueWei: string;
              }>;
            };
            const cfg = NETWORK_MAP[net];
            for (const item of json.transactions || []) {
              const amount = Number(formatEther(BigInt(item.valueWei || '0'))).toFixed(5);
              txs.push({
                hash: item.hash,
                networkId: net,
                type: item.type,
                status: item.status,
                from: item.from,
                to: item.to,
                symbol: cfg.symbol,
                amount,
                timestamp: item.timestamp,
              });
            }
          } catch {
            // ignore network failure
          }
        })()
      );
    }
  }

  if (addresses.solanaAddress) {
    queries.push(
      (async () => {
        try {
          const resp = await fetch(`/api/txs/solana/${addresses.solanaAddress}`);
          if (!resp.ok) return;
          const json = (await resp.json()) as {
            transactions?: Array<{
              hash: string;
              timestamp: number;
              status: 'confirmed' | 'failed';
              from: string;
              to: string;
              valueFormatted: string;
            }>;
          };
          for (const item of json.transactions || []) {
            txs.push({
              hash: item.hash,
              networkId: 'solana',
              type: 'on-chain',
              status: item.status,
              from: item.from,
              to: item.to,
              symbol: 'SOL',
              amount: item.valueFormatted,
              timestamp: item.timestamp,
            });
          }
        } catch {
          // ignore
        }
      })()
    );
  }

  await Promise.all(queries);
  return txs.sort((a, b) => b.timestamp - a.timestamp);
}

export async function estimateEvmTransferFee(
  networkId: NetworkId,
  fromAddress: string,
  toAddress: string,
  amountStr: string,
  tokenAddress: string,
  decimals: number,
  speedMultiplier = 1.0
): Promise<{
  gasLimit: bigint;
  gasPriceWei: bigint;
  feeNative: string;
}> {
  const provider = getEvmProvider(networkId);
  const feeData = await provider.getFeeData();
  const baseGasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? parseUnits('15', 'gwei');
  const gasPriceWei = BigInt(Math.round(Number(baseGasPrice) * speedMultiplier));

  let gasLimit = tokenAddress === 'native' ? 21000n : 65000n;
  try {
    if (tokenAddress === 'native') {
      const est = await provider.estimateGas({
        from: fromAddress,
        to: toAddress,
        value: parseEther(amountStr || '0'),
      });
      gasLimit = est;
    } else {
      const contract = new Contract(tokenAddress, ERC20_ABI, provider);
      const data = contract.interface.encodeFunctionData('transfer', [
        toAddress,
        parseUnits(amountStr || '0', decimals),
      ]);
      const est = await provider.estimateGas({
        from: fromAddress,
        to: tokenAddress,
        data,
      });
      gasLimit = est;
    }
  } catch {
    // Fallback to standard gas limit if sender has 0 balance during estimation
  }

  const feeWei = gasLimit * gasPriceWei;
  return {
    gasLimit,
    gasPriceWei,
    feeNative: Number(formatEther(feeWei)).toFixed(6),
  };
}

export async function signAndExecuteEvmTransfer(params: {
  networkId: NetworkId;
  privateKey: string;
  toAddress: string;
  amountStr: string;
  tokenAddress: string;
  decimals: number;
  symbol: string;
  speedMultiplier: number;
  broadcastOnChain: boolean;
}): Promise<WalletTransaction> {
  const cfg = NETWORK_MAP[params.networkId];
  const provider = getEvmProvider(params.networkId);
  const wallet = new Wallet(params.privateKey, provider);

  const feeInfo = await estimateEvmTransferFee(
    params.networkId,
    wallet.address,
    params.toAddress,
    params.amountStr,
    params.tokenAddress,
    params.decimals,
    params.speedMultiplier
  );

  let nonce = 0;
  try {
    nonce = await provider.getTransactionCount(wallet.address, 'pending');
  } catch {
    nonce = 0;
  }

  let txRequest: {
    to: string;
    value: bigint;
    data?: string;
    gasLimit: bigint;
    gasPrice: bigint;
    nonce: number;
    chainId: number;
  };

  if (params.tokenAddress === 'native') {
    txRequest = {
      to: params.toAddress,
      value: parseEther(params.amountStr),
      gasLimit: feeInfo.gasLimit,
      gasPrice: feeInfo.gasPriceWei,
      nonce,
      chainId: cfg.chainId || 1,
    };
  } else {
    const contract = new Contract(params.tokenAddress, ERC20_ABI, wallet);
    const data = contract.interface.encodeFunctionData('transfer', [
      params.toAddress,
      parseUnits(params.amountStr, params.decimals),
    ]);
    txRequest = {
      to: params.tokenAddress,
      value: 0n,
      data,
      gasLimit: feeInfo.gasLimit,
      gasPrice: feeInfo.gasPriceWei,
      nonce,
      chainId: cfg.chainId || 1,
    };
  }

  const signedHex = await wallet.signTransaction(txRequest);

  if (params.broadcastOnChain) {
    const sent = await provider.broadcastTransaction(signedHex);
    return {
      hash: sent.hash,
      networkId: params.networkId,
      type: 'send',
      status: 'pending',
      from: wallet.address,
      to: params.toAddress,
      symbol: params.symbol,
      amount: params.amountStr,
      feeFormatted: `${feeInfo.feeNative} ${cfg.symbol}`,
      rawSignedHex: signedHex,
      timestamp: Date.now(),
    };
  }

  // Signed offline / sandbox dry-run (real cryptographic EIP-155 signature without broadcasting unfunded tx)
  const localHash = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;

  return {
    hash: localHash,
    networkId: params.networkId,
    type: 'send',
    status: 'signed-sandbox',
    from: wallet.address,
    to: params.toAddress,
    symbol: params.symbol,
    amount: params.amountStr,
    feeFormatted: `${feeInfo.feeNative} ${cfg.symbol}`,
    rawSignedHex: signedHex,
    timestamp: Date.now(),
    note: 'Cryptographically signed transaction (Sandbox dry-run — insufficient gas balance on-chain)',
  };
}
