/**
 * bot.js
 * Node.js script: watches Raydium pools, performs rug-checks, buys then sells at 2x.
 *
 * Required env vars in .env:
 *  RPC_URL=your-solana-rpc
 *  PRIVATE_KEY_BASE58=base58-encoded-private-key OR a JSON array of secretKey bytes
 *  RAYDIUM_API=https://api-v3.raydium.io
 */

require('dotenv').config();
const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmRawTransaction } = require('@solana/web3.js');
const { getMint } = require('@solana/spl-token');
const axios = require('axios');
const bs58 = require('bs58');

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'; // TODO: change to your node (or devnet for tests)
const RAYDIUM_API = process.env.RAYDIUM_API || 'https://api-v3.raydium.io';
const BUY_USD = Number(process.env.BUY_USD) || 5; // amount in USD (approx) to buy when new token found
const TARGET_MULTIPLIER = Number(process.env.TARGET_MULTIPLIER) || 2;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 15_000; // 15s

// Wallet loading (supports base58 or JSON array)
function loadKeypair() {
  if (!process.env.PRIVATE_KEY_BASE58) throw new Error('Set PRIVATE_KEY_BASE58 in .env');
  try {
    const maybeJson = JSON.parse(process.env.PRIVATE_KEY_BASE58);
    if (Array.isArray(maybeJson)) {
      return Keypair.fromSecretKey(Uint8Array.from(maybeJson));
    }
  } catch (e) {}
  // assume base58
  const secret = bs58.decode(process.env.PRIVATE_KEY_BASE58);
  return Keypair.fromSecretKey(secret);
}

const wallet = loadKeypair();
const connection = new Connection(RPC_URL, 'confirmed');

// Minimal in-memory state
const seenPools = new Set();
const positions = new Map(); // tokenMint -> { buyPrice, amount, txSignature, boughtAt }

async function listPoolsFromRaydium() {
  // Raydium API exposes pools, pairs, etc.
  // We'll fetch pools list; the API docs recommend https://api-v3.raydium.io/
  try {
    const res = await axios.get(`${RAYDIUM_API}/amm/main/pools` , { timeout: 8000 });
    return res.data || [];
  } catch (err) {
    console.error('Failed to fetch pools from Raydium API:', err.message);
    return [];
  }
}

// -- RUG CHECKS (heuristics) --
async function rugChecks(tokenMintStr) {
  try {
    const tokenMint = new PublicKey(tokenMintStr);
    // 1) Mint info: is mintAuthority null? null -> cannot mint more (good)
    const mintInfo = await getMint(connection, tokenMint);
    const hasMintAuthority = mintInfo.mintAuthority !== null;
    if (hasMintAuthority) {
      console.warn(`[RUG CHECK] Token ${tokenMintStr} STILL has mint authority. HIGH RISK.`);
      return { safe: false, reason: 'mintAuthorityPresent' };
    }

    // 2) Largest token accounts: check concentration
    const largest = await connection.getTokenLargestAccounts(tokenMint);
    if (!largest || !largest.value || largest.value.length === 0) {
      return { safe: false, reason: 'noTokenAccounts' };
    }
    // sum top 3 holders
    const topAccounts = largest.value.slice(0, 3);
    // convert strings -> numbers; amounts are strings
    let totalTop = 0;
    for (const acc of topAccounts) totalTop += Number(acc.amount);
    // Need total supply to compute percent; use mintInfo.supply
    const supply = Number(mintInfo.supply);
    const topPercent = supply > 0 ? (totalTop / supply) * 100 : 100;
    if (topPercent > 50) {
      console.warn(`[RUG CHECK] Top holders contain ${topPercent.toFixed(1)}% of supply. HIGH RISK.`);
      return { safe: false, reason: 'concentrated_holders', topPercent };
    }

    // 3) decimals sanity check and supply sanity (very large supply may be weird)
    if (mintInfo.decimals > 9 || supply === 0) {
      return { safe: false, reason: 'weird_mint' };
    }

    // 4) (Optional) Check program-owned accounts, or look for recent big transfers
    // We leave more sophisticated ML checks or third-party scanners to specialized services.

    return { safe: true };
  } catch (err) {
    console.error('rugChecks failed for', tokenMintStr, err.message);
    return { safe: false, reason: 'error' };
  }
}

// -- Price helpers: estimate token price via Raydium pool reserves (simple)
function estimatePriceFromPool(pool) {
  // Raydium pool object usually contains reserves and token mints in pool.baseMint and pool.quoteMint
  // Example pool structure depends on API; attempt safe access
  try {
    // many Raydium pools expose 'liquidity', 'tokenA', 'tokenB' fields. Try to handle common shapes.
    const { tokenA, tokenB } = pool; // if API returns these
    if (tokenA && tokenB && tokenA.price && tokenB.price) {
      // If API provides price fields, use them
      // we return price relative to USD if available, otherwise price ratio
      return tokenA.price; // placeholder; real mapping depends on API
    }
    // As fallback, if pool has reserves:
    if (pool.reserve0 && pool.reserve1 && pool.token0 && pool.token1) {
      // If we know which is USDC/usdt, compute token price in USD
      // This is API specific; user should adapt based on the pool shape returned by Raydium.
      return null;
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * swapViaRaydiumTradeAPI
 * Raydium Trade API provides a way to obtain an unsigned transaction payload, which you sign and send.
 * We attempt to:
 *  1) request trade payload/quote from Raydium trade endpoint
 *  2) sign the returned serialized transaction locally
 *  3) submit via RPC
 *
 * NOTE: Raydium's trade endpoints and payload shapes may change. Inspect the Raydium docs if this errors.
 */
async function swapViaRaydiumTradeAPI({ fromMint, toMint, amount, slippage = 1 }) {
  // This is a high-level example. The exact route & request body depends on Raydium's /trade endpoints.
  try {
    // 1) Ask Raydium for unsigned txn / quote
    const payloadResp = await axios.post(`${RAYDIUM_API}/trade/quote`, {
      sourceMint: fromMint,
      destinationMint: toMint,
      amount: amount.toString(),
      slippage,
      userPublicKey: wallet.publicKey.toBase58()
    }, { timeout: 8000 });

    if (!payloadResp.data || !payloadResp.data.unsignedTx) {
      console.error('Raydium trade API did not return unsigned transaction:', payloadResp.data);
      return null;
    }

    const unsignedTxBase64 = payloadResp.data.unsignedTx; // assume base64 tx
    const txBuffer = Buffer.from(unsignedTxBase64, 'base64');
    const tx = Transaction.from(txBuffer);

    // sign locally
    tx.partialSign(wallet);
    const signed = tx.serialize();

    // send
    const sig = await connection.sendRawTransaction(signed, { skipPreflight: false });
    console.log('Swap tx sent sig:', sig);
    await connection.confirmTransaction(sig, 'finalized');
    return sig;
  } catch (err) {
    console.error('swapViaRaydiumTradeAPI error:', err.response ? err.response.data : err.message);
    return null;
  }
}

// Worker: process new pools
async function processPool(pool) {
  // Example pool object: inspect with console.log when testing
  const poolId = pool.id || pool.ammId || pool.address || pool.lpMint;
  if (!poolId) return;
  if (seenPools.has(poolId)) return;

  // Mark seen
  seenPools.add(poolId);

  // Determine token mint for the token you want to monitor.
  // Many Raydium pools are tokenA/tokenB. This code assumes tokenA is the new token and tokenB is a common quote (USDC/USDT/SOL)
  const tokenMint = (pool.tokenA && pool.tokenA.mint) || pool.baseMint || pool.tokenMintA || null;
  const quoteMint = (pool.tokenB && pool.tokenB.mint) || pool.quoteMint || pool.tokenMintB || null;

  if (!tokenMint) {
    console.log('Pool discovered but could not find token mint shape. Pool sample:', poolId);
    return;
  }

  console.log('New pool detected:', poolId, 'token:', tokenMint);

  // Run rug checks
  const rc = await rugChecks(tokenMint);
  if (!rc.safe) {
    console.warn('Rug checks failed:', rc);
    return;
  }

  // Estimate price (best effort). If you cannot get price, skip or buy a tiny amount for testing.
  const price = estimatePriceFromPool(pool);
  console.log('Estimated price (may be null):', price);

  // Decide buy amount (amount in token units). If price null, buy a small amount by specifying quote currency
  // For simplicity we'll attempt to buy BUY_USD worth of quoteMint -> tokenMint using Raydium Trade API
  const quoteAmount = BUY_USD; // Raydium API may expect amount in quote smallest unit; adapt accordingly.

  console.log(`Attempting buy for ${tokenMint} using ${quoteMint} for approx ${BUY_USD} USD`);

  const buySig = await swapViaRaydiumTradeAPI({
    fromMint: quoteMint, // e.g., USDC mint
    toMint: tokenMint,
    amount: Math.round(quoteAmount * 1e6), // placeholder: convert to lamports/decimals accordingly
    slippage: 2
  });

  if (!buySig) {
    console.error('Buy failed or returned no signature.');
    return;
  }

  // Record position - in a real bot you'd parse logs or query token account to get exact amount bought & price.
  const buyPrice = price || null;
  positions.set(tokenMint, { buyPrice, amount: null, txSignature: buySig, boughtAt: Date.now() });
  console.log('Position recorded for', tokenMint, 'sig', buySig);
}

// Monitor loop
async function monitorLoop() {
  console.log('Starting monitor loop. Wallet:', wallet.publicKey.toBase58());
  setInterval(async () => {
    try {
      const pools = await listPoolsFromRaydium();
      if (!pools || pools.length === 0) {
        return;
      }
      // iterate pools; filter by token symbols or min liquidity if you wish
      for (const pool of pools) {
        // optional filter: skip pools that aren't new tokens or that don't match your interest
        await processPool(pool);
      }

      // Check positions for selling condition (2x)
      for (const [tokenMint, pos] of positions.entries()) {
        // Try estimate current price via Raydium API / pool lookup (left as a placeholder)
        // If buyPrice is null we might skip sell logic or fetch last trade price
        const currentPrice = null; // TODO: implement pool -> USD price translation
        if (pos.buyPrice && currentPrice && currentPrice >= pos.buyPrice * TARGET_MULTIPLIER) {
          console.log(`SELL CONDITION met for ${tokenMint} - attempting sell.`);
          // Call swap API in reverse direction
          const sellSig = await swapViaRaydiumTradeAPI({
            fromMint: tokenMint,
            toMint: /* your quote mint (USDC) */ null,
            amount: /* token amount */ 0,
            slippage: 2
          });
          if (sellSig) {
            console.log('Sold', tokenMint, 'tx', sellSig);
            positions.delete(tokenMint);
          }
        }
      }
    } catch (err) {
      console.error('monitorLoop error', err.message);
    }
  }, POLL_INTERVAL_MS);
}

monitorLoop();
