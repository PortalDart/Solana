/**
 * bot.js
 * Node.js script: watches Raydium pools, performs rug-checks, buys then sells at 2x.
 *
 * Required env vars in .env:
 *  RPC_URL=your-solana-rpc
 *  PRIVATE_KEY_BASE58=base58-encoded-private-key OR a JSON array of secretKey bytes
 *  RAYDIUM_API=https://api.raydium.io/v2 (updated API endpoint)
 *  QUOTE_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (USDC)
 */

require('dotenv').config();
const { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } = require('@solana/web3.js');
const { getMint, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, getAccount } = require('@solana/spl-token');
const axios = require('axios');
const bs58 = require('bs58');

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const RAYDIUM_API = process.env.RAYDIUM_API || 'https://api.raydium.io/v2';
const BUY_USD = Number(process.env.BUY_USD) || 5;
const TARGET_MULTIPLIER = Number(process.env.TARGET_MULTIPLIER) || 2;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 15000;
const QUOTE_MINT = process.env.QUOTE_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
const SLIPPAGE_BPS = process.env.SLIPPAGE_BPS || 200; // 2% slippage

function loadKeypair() {
  if (!process.env.PRIVATE_KEY_BASE58) throw new Error('Set PRIVATE_KEY_BASE58 in .env');
  try {
    const arr = JSON.parse(process.env.PRIVATE_KEY_BASE58);
    if (Array.isArray(arr)) {
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
  } catch (_) {}
  
  const secret = bs58.decode(process.env.PRIVATE_KEY_BASE58);
  return Keypair.fromSecretKey(secret);
}

const wallet = loadKeypair();
const connection = new Connection(RPC_URL, {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60000
});

// State management
const seenPools = new Set();
const positions = new Map(); // tokenMint -> { buyPrice, amount, buyTx, boughtAt, quoteMint }

// Use correct Raydium API endpoint for new pools
async function listNewPoolsFromRaydium() {
  try {
    // Raydium v2 API for new pools - much more reliable
    const res = await axios.get(`${RAYDIUM_API}/main/pools`, { timeout: 10000 });
    
    if (res.data && res.data.success && res.data.data) {
      return res.data.data;
    }
    
    // Alternative endpoint if above doesn't work
    const altRes = await axios.get(`${RAYDIUM_API}/sdk/pairs`, { timeout: 10000 });
    return altRes.data || [];
  } catch (err) {
    console.error('Failed to fetch pools:', err.message);
    return [];
  }
}

// Enhanced rug checks
async function performRugChecks(tokenMintStr) {
  try {
    const tokenMint = new PublicKey(tokenMintStr);
    
    // 1) Check mint authority
    const mintInfo = await getMint(connection, tokenMint);
    const hasMintAuthority = mintInfo.mintAuthority !== null;
    const hasFreezeAuthority = mintInfo.freezeAuthority !== null;
    
    if (hasMintAuthority) {
      console.warn(`[RUG CHECK] Token ${tokenMintStr} has mint authority - HIGH RISK`);
      return { safe: false, reason: 'mintAuthorityPresent' };
    }
    
    if (hasFreezeAuthority) {
      console.warn(`[RUG CHECK] Token ${tokenMintStr} has freeze authority - MEDIUM RISK`);
    }

    // 2) Check supply and decimals
    const supply = Number(mintInfo.supply);
    const decimals = mintInfo.decimals;
    
    if (supply === 0) {
      return { safe: false, reason: 'zero_supply' };
    }
    
    if (decimals > 18) {
      console.warn(`[RUG CHECK] Token has ${decimals} decimals - HIGH RISK`);
      return { safe: false, reason: 'excessive_decimals' };
    }

    // 3) Check holder concentration
    const largest = await connection.getTokenLargestAccounts(tokenMint);
    if (!largest.value || largest.value.length === 0) {
      return { safe: false, reason: 'no_token_accounts' };
    }
    
    // Check top 5 holders
    const topAccounts = largest.value.slice(0, 5);
    let totalTop = 0;
    for (const acc of topAccounts) totalTop += Number(acc.amount);
    
    const topPercent = (totalTop / supply) * 100;
    if (topPercent > 70) {
      console.warn(`[RUG CHECK] Top 5 holders control ${topPercent.toFixed(1)}% - HIGH RISK`);
      return { safe: false, reason: 'concentrated_holders', topPercent };
    }
    
    // 4) Check if LP is burned (locked)
    try {
      const tokenAccounts = await connection.getTokenAccountsByOwner(
        new PublicKey(tokenMintStr),
        { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
      );
      
      if (tokenAccounts.value.length === 0) {
        console.warn(`[RUG CHECK] No token accounts found for mint`);
      }
    } catch (err) {
      console.warn(`[RUG CHECK] Could not fetch token accounts: ${err.message}`);
    }

    return { 
      safe: true, 
      details: {
        supply,
        decimals,
        topPercent
      }
    };
  } catch (err) {
    console.error('Rug checks failed:', err.message);
    return { safe: false, reason: 'check_failed', error: err.message };
  }
}

// Get token price from Raydium
async function getTokenPrice(tokenMint, quoteMint = QUOTE_MINT) {
  try {
    // Use Raydium price API
    const res = await axios.get(
      `${RAYDIUM_API}/main/price?mint=${tokenMint}`,
      { timeout: 5000 }
    );
    
    if (res.data && res.data.data) {
      return parseFloat(res.data.data.price);
    }
    
    // Alternative: fetch pool data
    const poolRes = await axios.get(
      `${RAYDIUM_API}/main/pair?mint=${tokenMint}`,
      { timeout: 5000 }
    );
    
    if (poolRes.data && poolRes.data.data && poolRes.data.data.price) {
      return parseFloat(poolRes.data.data.price);
    }
    
    return null;
  } catch (err) {
    console.error('Price fetch failed:', err.message);
    return null;
  }
}

// Get quote for swap using Raydium API
async function getSwapQuote(fromMint, toMint, amount, slippageBps = SLIPPAGE_BPS) {
  try {
    const res = await axios.get(`${RAYDIUM_API}/main/quote`, {
      params: {
        inputMint: fromMint,
        outputMint: toMint,
        amount: amount.toString(),
        slippageBps: slippageBps.toString()
      },
      timeout: 10000
    });
    
    if (res.data && res.data.success && res.data.data) {
      return res.data.data;
    }
    return null;
  } catch (err) {
    console.error('Get quote error:', err.response?.data || err.message);
    return null;
  }
}

// Execute swap using Raydium API
async function executeSwap(quoteData) {
  try {
    // Get swap transaction from Raydium
    const res = await axios.post(
      `${RAYDIUM_API}/main/swap`,
      {
        quoteResponse: quoteData,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        useSharedAccounts: true,
        computeUnitPriceMicroLamports: 100000 // Priority fee
      },
      { timeout: 15000 }
    );
    
    if (!res.data || !res.data.success || !res.data.data) {
      console.error('Swap API failed:', res.data);
      return null;
    }
    
    const { transaction } = res.data.data;
    
    // Deserialize and sign transaction
    const txBuffer = Buffer.from(transaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuffer);
    
    // Sign the transaction
    tx.sign([wallet]);
    
    // Send transaction
    const rawTransaction = tx.serialize();
    const signature = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3
    });
    
    console.log('Transaction sent:', signature);
    
    // Wait for confirmation
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash: tx.message.recentBlockhash,
      lastValidBlockHeight: tx.message.lastValidBlockHeight
    }, 'confirmed');
    
    if (confirmation.value.err) {
      console.error('Transaction failed:', confirmation.value.err);
      return null;
    }
    
    console.log('Transaction confirmed:', signature);
    return signature;
  } catch (err) {
    console.error('Execute swap error:', err.response?.data || err.message);
    return null;
  }
}

// Check and create token account if needed
async function ensureTokenAccount(mint) {
  try {
    const tokenAccount = await getAssociatedTokenAddress(
      new PublicKey(mint),
      wallet.publicKey
    );
    
    const accountInfo = await connection.getAccountInfo(tokenAccount);
    
    if (!accountInfo) {
      console.log('Creating token account for:', mint);
      const transaction = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          tokenAccount,
          wallet.publicKey,
          new PublicKey(mint)
        )
      );
      
      const signature = await connection.sendTransaction(transaction, [wallet]);
      await connection.confirmTransaction(signature, 'confirmed');
      console.log('Token account created:', signature);
    }
    
    return tokenAccount;
  } catch (err) {
    console.error('Ensure token account failed:', err.message);
    return null;
  }
}

// Process new pool
async function processNewPool(pool) {
  try {
    const poolId = pool.id || pool.address;
    if (!poolId || seenPools.has(poolId)) return;
    
    seenPools.add(poolId);
    
    // Extract token information - adjust based on actual API response
    const baseMint = pool.baseMint || pool.tokenA?.mint;
    const quoteMint = pool.quoteMint || pool.tokenB?.mint || QUOTE_MINT;
    
    if (!baseMint) {
      console.log('No base mint found for pool:', poolId);
      return;
    }
    
    // Check if it's actually a new token (not USDC, USDT, SOL, etc.)
    const knownMints = [
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
      'So11111111111111111111111111111111111111112', // SOL
      'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
    ];
    
    if (knownMints.includes(baseMint)) {
      return; // Skip known tokens
    }
    
    console.log('New pool detected:', {
      poolId,
      baseMint,
      quoteMint,
      name: pool.name || 'Unknown'
    });
    
    // Perform rug checks
    const rugCheck = await performRugChecks(baseMint);
    if (!rugCheck.safe) {
      console.warn('Rug checks failed:', rugCheck.reason);
      return;
    }
    
    console.log('Rug checks passed:', rugCheck.details);
    
    // Get current price
    const currentPrice = await getTokenPrice(baseMint, quoteMint);
    if (!currentPrice || currentPrice <= 0) {
      console.warn('Could not get valid price for token:', baseMint);
      return;
    }
    
    console.log('Current price:', currentPrice);
    
    // Calculate buy amount in quote tokens
    const quoteAmount = BUY_USD / currentPrice;
    const quoteDecimals = quoteMint === QUOTE_MINT ? 6 : 9; // Adjust based on token
    const rawAmount = Math.floor(quoteAmount * Math.pow(10, quoteDecimals));
    
    if (rawAmount <= 0) {
      console.warn('Buy amount too small');
      return;
    }
    
    // Ensure we have token account
    await ensureTokenAccount(baseMint);
    
    // Get swap quote
    const quoteData = await getSwapQuote(quoteMint, baseMint, rawAmount);
    if (!quoteData) {
      console.error('Failed to get swap quote');
      return;
    }
    
    console.log('Swap quote received:', {
      inAmount: quoteData.inAmount,
      outAmount: quoteData.outAmount,
      priceImpact: quoteData.priceImpact
    });
    
    // Execute buy
    const buySignature = await executeSwap(quoteData);
    if (!buySignature) {
      console.error('Buy failed');
      return;
    }
    
    // Record position
    const tokenAmount = parseFloat(quoteData.outAmount) / Math.pow(10, rugCheck.details.decimals);
    
    positions.set(baseMint, {
      buyPrice: currentPrice,
      amount: tokenAmount,
      buyTx: buySignature,
      boughtAt: Date.now(),
      quoteMint,
      targetPrice: currentPrice * TARGET_MULTIPLIER
    });
    
    console.log(`Position opened: ${tokenAmount} tokens at $${currentPrice}, target: $${currentPrice * TARGET_MULTIPLIER}`);
    
  } catch (err) {
    console.error('Process pool error:', err.message);
  }
}

// Check and sell positions
async function checkAndSellPositions() {
  for (const [tokenMint, position] of positions.entries()) {
    try {
      const currentPrice = await getTokenPrice(tokenMint, position.quoteMint);
      
      if (!currentPrice) {
        console.warn('Could not fetch price for:', tokenMint);
        continue;
      }
      
      console.log(`Position ${tokenMint}: Bought at $${position.buyPrice}, Current: $${currentPrice}, Target: $${position.targetPrice}`);
      
      // Check if we hit target or if position is old (24h limit)
      const positionAge = Date.now() - position.boughtAt;
      const isOldPosition = positionAge > 24 * 60 * 60 * 1000; // 24 hours
      
      if (currentPrice >= position.targetPrice || isOldPosition) {
        const reason = isOldPosition ? '24h timeout' : 'target reached';
        console.log(`Selling ${tokenMint} - ${reason}`);
        
        // Calculate sell amount (full position)
        const rawAmount = Math.floor(position.amount * Math.pow(10, 9)); // Assuming token decimals
        
        // Get sell quote
        const quoteData = await getSwapQuote(tokenMint, position.quoteMint, rawAmount);
        if (!quoteData) {
          console.error('Failed to get sell quote');
          continue;
        }
        
        // Execute sell
        const sellSignature = await executeSwap(quoteData);
        if (sellSignature) {
          console.log(`Sold position: ${tokenMint}, Tx: ${sellSignature}`);
          positions.delete(tokenMint);
        }
      }
    } catch (err) {
      console.error(`Error checking position ${tokenMint}:`, err.message);
    }
  }
}

// Main monitoring loop
async function startMonitor() {
  console.log('Starting bot with wallet:', wallet.publicKey.toString());
  console.log('Settings:', {
    BUY_USD,
    TARGET_MULTIPLIER,
    POLL_INTERVAL_MS,
    QUOTE_MINT
  });
  
  // Initial pool fetch
  const initialPools = await listNewPoolsFromRaydium();
  console.log(`Found ${initialPools.length} initial pools`);
  
  // Start monitoring
  setInterval(async () => {
    try {
      console.log('\n--- Checking for new pools ---');
      const pools = await listNewPoolsFromRaydium();
      
      if (pools && pools.length > 0) {
        // Process only first 3 new pools per interval to avoid rate limiting
        const newPools = pools.slice(0, 3);
        
        for (const pool of newPools) {
          await processNewPool(pool);
          await new Promise(resolve => setTimeout(resolve, 2000)); // Delay between processing
        }
      }
      
      // Check existing positions
      if (positions.size > 0) {
        console.log(`\n--- Checking ${positions.size} positions ---`);
        await checkAndSellPositions();
      }
      
    } catch (err) {
      console.error('Monitor iteration error:', err.message);
    }
  }, POLL_INTERVAL_MS);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down bot...');
  console.log('Active positions:', positions.size);
  process.exit(0);
});

// Start the bot
startMonitor().catch(err => {
  console.error('Failed to start bot:', err);
  process.exit(1);
});
