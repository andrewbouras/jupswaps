import pkg from '@solana/web3.js';
const { 
  Connection, 
  Keypair, 
  PublicKey, 
  Transaction, 
  VersionedTransaction
} = pkg;
import axios from 'axios';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import nacl from 'tweetnacl';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';

// Load environment variables
dotenv.config();

// Common token definitions
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// Configuration class for dynamic parameters
class TradingConfig {
  constructor(tokenMint, solAmount, stopLossPercentage, takeProfitPercentage, slippageBps) {
    this.tokenMint = tokenMint;         // SPL token to trade
    this.solAmount = solAmount;         // Amount of SOL to use for purchase (in lamports)
    this.stopLossPercentage = stopLossPercentage;   // Stop loss as a percentage (e.g., 0.2 = 20% loss)
    this.takeProfitPercentage = takeProfitPercentage; // Take profit as a percentage (e.g., 0.2 = 20% gain)
    this.slippageBps = slippageBps;           // Slippage in basis points (e.g., 100 = 1%)
  }
}

// Class to track purchases
class TokenPurchase {
  constructor(tokenMint, purchaseAmount, purchasePrice, targetPrice, takeProfitPrice, stopLossPrice) {
    this.tokenMint = tokenMint;
    this.purchaseAmount = purchaseAmount;
    this.purchasePrice = purchasePrice;
    this.targetPrice = targetPrice;
    this.takeProfitPrice = takeProfitPrice;
    this.stopLossPrice = stopLossPrice;
  }
}

// Load configuration from environment variables
function loadConfigFromEnv() {
  try {
    // Get token mint from env or use a default
    const tokenMintStr = process.env.TOKEN_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // Default to USDC
    const tokenMint = new PublicKey(tokenMintStr);
    
    // Get SOL amount in SOL units, then convert to lamports
    const solAmountStr = process.env.SOL_AMOUNT || '0.1'; // Default to 0.1 SOL
    const solAmountFloat = parseFloat(solAmountStr);
    if (isNaN(solAmountFloat)) {
      throw new Error(`Invalid SOL amount: ${solAmountStr}`);
    }
    const solAmount = Math.floor(solAmountFloat * 1e9); // Convert SOL to lamports
    
    // Get stop loss percentage (e.g., 0.2 = 20%)
    const stopLossStr = process.env.STOP_LOSS_PERCENTAGE || '0.2'; // Default to 20%
    const stopLossPercentage = parseFloat(stopLossStr);
    if (isNaN(stopLossPercentage)) {
      throw new Error(`Invalid stop loss percentage: ${stopLossStr}`);
    }
    
    // Get take profit percentage (e.g., 0.2 = 20%)
    const takeProfitStr = process.env.TAKE_PROFIT_PERCENTAGE || '0.2'; // Default to 20%
    const takeProfitPercentage = parseFloat(takeProfitStr);
    if (isNaN(takeProfitPercentage)) {
      throw new Error(`Invalid take profit percentage: ${takeProfitStr}`);
    }
    
    // Get slippage in basis points (100 = 1%)
    const slippageStr = process.env.SLIPPAGE_BPS || '100'; // Default to 1%
    const slippageBps = parseInt(slippageStr, 10);
    if (isNaN(slippageBps)) {
      throw new Error(`Invalid slippage basis points: ${slippageStr}`);
    }
    
    return new TradingConfig(
      tokenMint,
      solAmount,
      stopLossPercentage,
      takeProfitPercentage,
      slippageBps
    );
  } catch (error) {
    console.error(`Error loading configuration: ${error.message}`);
    throw error;
  }
}

// API client methods for Jupiter
async function getOrder(request) {
  try {
    const params = {
      amount: request.amount,
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      slippageBps: request.slippageBps
    };

    if (request.taker) {
      params.taker = request.taker;
    }

    const response = await axios.get('https://api.jup.ag/ultra/v1/order', { params });
    
    if (response.status !== 200) {
      throw new Error(`Request failed with status: ${response.status}`);
    }
    
    return response.data;
  } catch (error) {
    console.error('Error in getOrder:', error.message);
    throw error;
  }
}

async function executeTransaction(request) {
  try {
    console.log("Sending execute request to Jupiter API...");
    console.log("Request ID:", request.requestId);
    
    const response = await axios.post('https://api.jup.ag/ultra/v1/execute', {
      requestId: request.requestId,
      signedTransaction: request.signedTransaction
    });
    
    return response.data;
  } catch (error) {
    console.error('Error in executeTransaction:', error.message);
    
    if (error.response && error.response.data) {
      console.error('Error details:', JSON.stringify(error.response.data, null, 2));
    }
    
    throw error;
  }
}

// Buy tokens with SOL
async function buyTokenWithSol(connection, keypair, config) {
  try {
    console.log(`\nGetting quote for ${config.solAmount / 1e9} SOL to token...`);
    
    // Create order request
    const orderRequest = {
      amount: config.solAmount.toString(),
      inputMint: NATIVE_MINT.toString(),
      outputMint: config.tokenMint.toString(),
      slippageBps: config.slippageBps,
      taker: keypair.publicKey.toString()
    };
    
    // Get the order from Jupiter
    const orderResponse = await getOrder(orderRequest);
    
    console.log('\nQuote Details:');
    console.log(`Input: ${parseFloat(orderResponse.inAmount) / 1e9} SOL`);
    const tokenAmount = parseFloat(orderResponse.outAmount);
    console.log(`Output: ${tokenAmount} tokens`);
    console.log(`Price Impact: ${orderResponse.priceImpactPct}%`);
    
    console.log('\nExecuting swap...');
    
    // Get the transaction from Jupiter API
    console.log('\nGetting transaction from Jupiter...');
    const txBuffer = Buffer.from(orderResponse.transaction, 'base64');
    
    // Log transaction data
    console.log(`Transaction data length: ${txBuffer.length} bytes`);
    
    try {
      // Use a more direct approach - parse the transaction but don't modify its structure
      console.log('Preparing transaction for signing...');
      
      // Use Transaction.from instead, which is designed to work with base64 encoded transactions
      const transaction = pkg.VersionedTransaction.deserialize(txBuffer);
      
      // Add our signature
      console.log('Signing transaction...');
      const signatureBuffer = Buffer.alloc(64);
      const txSignature = nacl.sign.detached(
        transaction.message.serialize(),
        keypair.secretKey
      );
      Buffer.from(txSignature).copy(signatureBuffer);
      transaction.signatures[0] = signatureBuffer;
      
      console.log(`Signed for public key: ${keypair.publicKey.toString()}`);
      console.log(`Transaction has ${transaction.signatures.length} signature(s)`);
      
      // Serialize back
      console.log('Serializing signed transaction...');
      const signedTransaction = Buffer.from(transaction.serialize()).toString('base64');
      
      console.log('Transaction serialized successfully');
      console.log(`Serialized length: ${signedTransaction.length} characters`);
      
      // Execute via Jupiter's API
      const executeRequest = {
        requestId: orderResponse.requestId,
        signedTransaction: signedTransaction
      };
      
      console.log('Sending to Jupiter execute API...');
      console.log(`Request ID: ${orderResponse.requestId}`);
      const executeResponse = await executeTransaction(executeRequest);

      // Check final balance
      const finalSolBalance = await connection.getBalance(keypair.publicKey);
      console.log(`\nFinal SOL balance: ${finalSolBalance / 1e9} SOL`);
      
      // Calculate purchase price (SOL per token)
      const purchaseAmountInSol = parseFloat(orderResponse.inAmount) / 1e9;
      const purchasePrice = tokenAmount / purchaseAmountInSol; // Tokens per SOL
      
      // Calculate take profit price (lower tokens per SOL = higher token value)
      const takeProfitPrice = purchasePrice * (1.0 - config.takeProfitPercentage);
      
      // Calculate stop loss price (higher tokens per SOL = lower token value)
      const stopLossPrice = purchasePrice * (1.0 + config.stopLossPercentage);
      
      console.log('\n===== PURCHASE SUMMARY =====');
      console.log(`Bought: ${tokenAmount} tokens`);
      console.log(`Paid: ${purchaseAmountInSol} SOL`);
      console.log(`Purchase price: ${purchasePrice} tokens per SOL`);
      console.log(`Take profit target: ${takeProfitPrice} tokens per SOL (-${config.takeProfitPercentage * 100}%)`);
      console.log(`Stop loss set at: ${stopLossPrice} tokens per SOL (+${config.stopLossPercentage * 100}%)`);
      console.log('============================\n');
      
      // Return purchase info
      return new TokenPurchase(
        config.tokenMint,
        BigInt(orderResponse.outAmount),
        purchasePrice,
        purchasePrice,
        takeProfitPrice,
        stopLossPrice
      );
    } catch (error) {
      console.error(`Transaction signing error: ${error.message}`);
      throw error;
    }
  } catch (error) {
    console.error('Error buying token with SOL:', error.message);
    throw error;
  }
}

// Monitor price and sell when conditions are met
async function monitorPriceAndSell(connection, keypair, purchase, slippageBps) {
  try {
    // Check interval in milliseconds
    const checkInterval = 1000; // 1 second
    
    console.log('\n===== PRICE MONITORING STARTED =====');
    console.log(`Original purchase price: ${purchase.purchasePrice} tokens per SOL`);
    console.log(`Will TAKE PROFIT when price decreases below ${purchase.takeProfitPrice} tokens/SOL`);
    console.log(`OR will STOP LOSS when price increases above ${purchase.stopLossPrice} tokens per SOL`);
    console.log(`Using entire purchased amount (${purchase.purchaseAmount} tokens) for price monitoring`);
    console.log('=====================================\n');
    
    // Monitoring loop
    while (true) {
      // Create order request to check current price using entire purchased amount
      const orderRequest = {
        amount: purchase.purchaseAmount.toString(),
        inputMint: purchase.tokenMint.toString(),
        outputMint: NATIVE_MINT.toString(),
        slippageBps: slippageBps,
        taker: keypair.publicKey.toString()
      };
      
      try {
        // Get current price
        const orderResponse = await getOrder(orderRequest);
        
        // Extract total SOL amount and calculate price per token
        const solAmount = parseFloat(orderResponse.outAmount) / 1e9;
        const tokenAmount = Number(purchase.purchaseAmount);
        const currentPrice = tokenAmount / solAmount; // Tokens per SOL
        
        // Compare current total value to original purchase value
        const originalValue = tokenAmount / purchase.purchasePrice;
        const currentValue = solAmount;
        const priceDiffPct = ((currentValue / originalValue) - 1.0) * 100.0;
        
        const timestamp = new Date().toLocaleTimeString();
        console.log(`[${timestamp}] Current: ${currentPrice.toFixed(6)} tokens/SOL | Purchase: ${purchase.purchasePrice.toFixed(6)} tokens/SOL | Diff: ${priceDiffPct.toFixed(6)}%`);
        
        // Check if we should sell (take profit OR stop loss triggered)
        const shouldSell = currentPrice <= purchase.takeProfitPrice || currentPrice >= purchase.stopLossPrice;
        let sellReason = 'UNKNOWN';
        
        if (currentPrice <= purchase.takeProfitPrice) {
          sellReason = 'TAKE PROFIT TARGET REACHED';
        } else if (currentPrice >= purchase.stopLossPrice) {
          sellReason = 'STOP LOSS TRIGGERED';
        }
        
        if (shouldSell) {
          console.log(`\n===== SELL TRIGGERED: ${sellReason} =====`);
          console.log(`Current price: ${currentPrice.toFixed(6)} tokens per SOL`);
          console.log(`Original purchase price: ${purchase.purchasePrice.toFixed(6)} tokens per SOL`);
          console.log(`Price change: ${priceDiffPct.toFixed(6)}%`);
          console.log(`Selling all ${purchase.purchaseAmount} tokens`);
          console.log('=========================\n');
          
          // Get actual swap transaction
          const sellOrderRequest = {
            amount: purchase.purchaseAmount.toString(),
            inputMint: purchase.tokenMint.toString(),
            outputMint: NATIVE_MINT.toString(),
            slippageBps: slippageBps,
            taker: keypair.publicKey.toString()
          };
          
          const sellOrder = await getOrder(sellOrderRequest);
          
          // Decode and sign
          const txBuffer = Buffer.from(sellOrder.transaction, 'base64');
          console.log(`Sell transaction data length: ${txBuffer.length} bytes`);
          
          try {
            // Parse transaction
            console.log('Preparing sell transaction for signing...');
            const transaction = pkg.VersionedTransaction.deserialize(txBuffer);
            
            // Add our signature
            console.log('Signing sell transaction...');
            const signatureBuffer = Buffer.alloc(64);
            const txSignature = nacl.sign.detached(
              transaction.message.serialize(),
              keypair.secretKey
            );
            Buffer.from(txSignature).copy(signatureBuffer);
            transaction.signatures[0] = signatureBuffer;
            
            console.log(`Signed for public key: ${keypair.publicKey.toString()}`);
            console.log(`Transaction has ${transaction.signatures.length} signature(s)`);
            
            // Serialize back
            console.log('Serializing signed transaction...');
            const signedTransaction = Buffer.from(transaction.serialize()).toString('base64');
            
            console.log('Transaction serialized successfully');
            console.log(`Serialized length: ${signedTransaction.length} characters`);
            
            // Execute via Jupiter's API
            const executeRequest = {
              requestId: sellOrder.requestId,
              signedTransaction: signedTransaction
            };
            
            console.log('Sending sell transaction to Jupiter execute API...');
            const executeResponse = await executeTransaction(executeRequest);

            // Get the transaction signature from Jupiter's response
            const txHash = executeResponse.txId || executeResponse.signature || executeResponse.txSignature;
            if (!txHash) {
              throw new Error('Could not find transaction signature in response');
            }
            
            console.log('\n===== SELL COMPLETE =====');
            console.log(`Transaction signature: ${txHash}`);
            console.log(`View on Solscan: https://solscan.io/tx/${txHash}`);
            console.log(`Profit/Loss: ${priceDiffPct.toFixed(6)}%`);
            console.log('========================\n');
          } catch (error) {
            console.error(`Sell transaction error: ${error.message}`);
            throw error;
          }
          
          break;
        }
      } catch (error) {
        console.error(`Error during price check: ${error.message}`);
      }
      
      // Wait for the next check interval
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
  } catch (error) {
    console.error('Error monitoring price and selling:', error.message);
    throw error;
  }
}

// Main function
async function main() {
  try {
    // Load configuration from environment variables
    const config = loadConfigFromEnv();
    
    // Display config at startup
    console.log('\n===== TRADING CONFIGURATION =====');
    console.log(`Token Mint: ${config.tokenMint.toString()}`);
    console.log(`SOL Amount: ${config.solAmount / 1e9} SOL`);
    console.log(`Stop Loss: ${config.stopLossPercentage * 100}%`);
    console.log(`Take Profit: ${config.takeProfitPercentage * 100}%`);
    console.log(`Slippage: ${config.slippageBps / 100}%`);
    console.log('=================================\n');
    
    // Setup wallet from private key
    const privateKeyString = process.env.SOLANA_PRIVATE_KEY;
    if (!privateKeyString) {
      throw new Error('SOLANA_PRIVATE_KEY environment variable not set');
    }

    let keypair;
    try {
      console.log(`Private key length: ${privateKeyString.length}`);
      const secretKey = bs58.decode(privateKeyString);
      console.log(`Decoded secret key length: ${secretKey.length} bytes`);

      // Different handling based on the decoded length
      if (secretKey.length === 64) {
        keypair = Keypair.fromSecretKey(secretKey);
      } else if (secretKey.length === 32) {
        keypair = Keypair.fromSeed(secretKey);
        console.log("Created keypair from 32-byte seed");
      } else {
        throw new Error(`Invalid secret key length: ${secretKey.length}. Expected 64 or 32 bytes.`);
      }

      // Verify the keypair by checking if it can sign
      const testMessage = new Uint8Array([1, 2, 3, 4, 5]);
      try {
        const signature = nacl.sign.detached(testMessage, keypair.secretKey);
        console.log(`Test signature successful: ${Buffer.from(signature).toString('hex').slice(0, 10)}...`);
      } catch (signErr) {
        console.error(`Failed to sign test message: ${signErr.message}`);
        throw new Error("Keypair cannot sign - invalid format");
      }

      console.log(`Loaded wallet address: ${keypair.publicKey.toString()}`);
    } catch (err) {
      console.error('Failed to load keypair:', err.message);
      throw err;
    }

    // Initialize Solana connection
    const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    
    // Check SOL balance
    const solBalance = await connection.getBalance(keypair.publicKey);
    console.log(`Current SOL balance: ${solBalance / 1e9} SOL`);
    
    if (solBalance < 10_000_000) { // 0.01 SOL minimum for fees
      throw new Error('Insufficient SOL for transaction fees. Please ensure you have at least 0.01 SOL');
    }
    
    // Check if we have enough SOL for the trade
    if (solBalance < config.solAmount + 10_000_000) { // Adding 0.01 SOL for fees
      throw new Error(`Insufficient SOL for trade. Need ${(config.solAmount + 10_000_000) / 1e9} SOL but only have ${solBalance / 1e9} SOL`);
    }
    
    // Automatically buy and monitor
    console.log('Starting automated buy and sell process...');
    
    // Buy tokens using SOL
    const purchase = await buyTokenWithSol(connection, keypair, config);
    
    // Start monitoring for sell conditions
    await monitorPriceAndSell(connection, keypair, purchase, config.slippageBps);
    
  } catch (error) {
    console.error(chalk.red(`Error: ${error.message}`));
    process.exit(1);
  }
}

// Run the main function
main();
