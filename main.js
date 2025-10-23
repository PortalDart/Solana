require('dotenv').config();
const { Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const { Connection, clusterApiUrl } = require('@solana/web3.js');
const bs58 = require('bs58');
const WebSocket = require('ws');
const axios = require('axios');

const variables = {
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY,
  BUY_AMOUNT_SOL: parseFloat(process.env.BUY_AMOUNT_SOL || 0.1),
  SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS || 500),
  STOP_LOSS_PCT: parseFloat(process.env.STOP_LOSS_PCT || 20),
};

const RAYDIUM_PROGRAM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
const keypair = Keypair.fromSecretKey(bs58.decode(variables.PRIVATE_KEY));
const walletPubkey = keypair.publicKey;
const connection = new Connection(variables.RPC_URL, 'confirmed');
const positions = {};

async function getPrice(mint) {
  const url = `https://public-api.birdeye.so/defi/price?address=${mint}`;
  const headers = { 'X-API-KEY': variables.BIRDEYE_API_KEY, 'x-chain': 'solana' };
  const resp = await axios.get(url, { headers });
  return resp.data.data?.value || 0;
}

async function swapBuy(tokenMint, amountSol) {
  const inputMint = 'So11111111111111111111111111111111111111112';
  const outputMint = tokenMint;
  const amountLamports = Math.floor(amountSol * 10**9);

  const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${variables.SLIPPAGE_BPS}`;
  const quoteResp = (await axios.get(quoteUrl)).data;
  if (quoteResp.error) {
    console.log(`Buy quote failed for ${tokenMint}`);
    return false;
  }

  const swapUrl = 'https://quote-api.jup.ag/v6/swap';
  const payload = {
    quoteResponse: quoteResp,
    userPublicKey: walletPubkey.toString(),
    wrapAndUnwrapSol: true,
  };
  const swapResp = (await axios.post(swapUrl, payload)).data;
  if (!swapResp.swapTransaction) {
    console.log(`Swap tx failed for ${tokenMint}`);
    return false;
  }

  const txBuf = Buffer.from(swapResp.swapTransaction, 'base64');
  const tx = Transaction.from(txBuf);
  tx.sign(keypair);
  const sig = await sendAndConfirmTransaction(connection, tx, [keypair]);
  console.log(`Buy tx sig: ${sig}`);
  return true;
}

async function swapSell(tokenMint, sellPct) {
  const ata = await getAssociatedTokenAddress(new PublicKey(tokenMint), walletPubkey);
  const balResp = await connection.getTokenAccountBalance(ata);
  if (!balResp.value) return false;
  const amountTokens = Math.floor(balResp.value.amount * sellPct);

  const inputMint = tokenMint;
  const outputMint = 'So11111111111111111111111111111111111111112';
  const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountTokens}&slippageBps=${variables.SLIPPAGE_BPS}`;
  const quoteResp = (await axios.get(quoteUrl)).data;
  if (quoteResp.error) return false;

  const swapUrl = 'https://quote-api.jup.ag/v6/swap';
  const payload = {
    quoteResponse: quoteResp,
    userPublicKey: walletPubkey.toString(),
    wrapAndUnwrapSol: true,
  };
  const swapResp = (await axios.post(swapUrl, payload)).data;
  if (!swapResp.swapTransaction) return false;

  const txBuf = Buffer.from(swapResp.swapTransaction, 'base64');
  const tx = Transaction.from(txBuf);
  tx.sign(keypair);
  await sendAndConfirmTransaction(connection, tx, [keypair]);
  console.log(`Sold ${sellPct*100}% of ${tokenMint}`);
  return true;
}

async function monitorPosition(tokenMint) {
  const pos = positions[tokenMint];
  while (true) {
    const currentPrice = await getPrice(tokenMint);
    if (currentPrice === 0) {
      await new Promise(resolve => setTimeout(resolve, 10000));
      continue;
    }

    const multiplier = currentPrice / pos.buy_price;
    console.log(`${tokenMint}: ${multiplier.toFixed(2)}x`);

    if (multiplier >= 3 && !pos.sold_50) {
      await swapSell(tokenMint, 0.5);
      pos.sold_50 = true;
    } else if (multiplier >= 2 && !pos.sold_25) {
      await swapSell(tokenMint, 0.25);
      pos.sold_25 = true;
    } else if (multiplier <= (1 - variables.STOP_LOSS_PCT / 100)) {
      await swapSell(tokenMint, 1.0);
      delete positions[tokenMint];
      console.log(`Stop loss triggered for ${tokenMint}`);
      break;
    }

    await new Promise(resolve => setTimeout(resolve, 10000));
  }
}

async function detectNewPools() {
  const ws = new WebSocket(variables.RPC_URL.replace('https', 'wss'));
  ws.on('open', () => {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [{ mentions: [RAYDIUM_PROGRAM.toString()] }, { commitment: 'finalized' }],
    }));
  });

  ws.on('message', async (data) => {
    const msg = JSON.parse(data);
    if (msg.result && msg.result.value && msg.result.value.logs) {
      const logs = msg.result.value.logs;
      for (const log of logs) {
        if (log.toLowerCase().includes('initialize') && log.toLowerCase().includes('pool')) {
          if (log.includes('Mint:')) {
            const tokenMintStr = log.split('Mint: ')[1].split(' ')[0];
            const tokenMint = new PublicKey(tokenMintStr);
            console.log(`New pool detected: ${tokenMint}`);

            const success = await swapBuy(tokenMint.toString(), variables.BUY_AMOUNT_SOL);
            if (success) {
              const buyPrice = await getPrice(tokenMint.toString());
              if (buyPrice > 0) {
                positions[tokenMint.toString()] = {
                  buy_price: buyPrice,
                  amount: variables.BUY_AMOUNT_SOL / buyPrice,
                  sold_25: false,
                  sold_50: false,
                };
                monitorPosition(tokenMint.toString());
              }
            }
          }
        }
      }
    }
  });
}

async function main() {
  console.log('Bot started. Monitoring new Raydium pools...');
  await detectNewPools();
}

main().catch(console.error);
