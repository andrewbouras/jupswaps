use jupiter_swap_api_client::{
    JupiterSwapApiClient,
};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::{
    pubkey,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::VersionedTransaction,
};
use std::env;
use bs58;
use dotenv::dotenv;
use base64::{decode as base64_decode, encode as base64_encode};
use chrono;
use serde::{Deserialize, Serialize};
use reqwest::Client;
use std::str::FromStr;
use bincode;

// Common token definitions
const USDC_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

// Configuration struct for dynamic parameters
struct TradingConfig {
    token_mint: Pubkey,          // SPL token to trade
    sol_amount: u64,             // Amount of SOL to use for purchase (in lamports)
    stop_loss_percentage: f64,   // Stop loss as a percentage (e.g., 0.2 = 20% loss)
    take_profit_percentage: f64, // Take profit as a percentage (e.g., 0.2 = 20% gain)
    slippage_bps: u16,           // Slippage in basis points (e.g., 100 = 1%)
}

// New struct to track purchases
struct TokenPurchase {
    token_mint: Pubkey,
    purchase_amount: u64,
    purchase_price: f64,
    target_price: f64,
    take_profit_price: f64,
    stop_loss_price: f64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OrderRequest {
    pub amount: String,
    pub input_mint: String,
    pub output_mint: String, 
    #[serde(skip_serializing_if = "Option::is_none")]
    pub taker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slippage_bps: Option<u16>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OrderResponse {
    pub input_mint: String,
    pub output_mint: String,
    pub in_amount: String,
    pub out_amount: String,
    pub price_impact_pct: String,
    pub transaction: Option<String>,
    pub request_id: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteRequest {
    pub request_id: String,
    pub signed_transaction: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResponse {
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load .env file if it exists
    dotenv().ok();

    // Load configuration from environment variables or use defaults
    let config = load_config_from_env()?;
    
    // Display config at startup
    println!("\n===== TRADING CONFIGURATION =====");
    println!("Token Mint: {}", config.token_mint);
    println!("SOL Amount: {} SOL", config.sol_amount as f64 / 1e9);
    println!("Stop Loss: {}%", config.stop_loss_percentage * 100.0);
    println!("Take Profit: {}%", config.take_profit_percentage * 100.0);
    println!("Slippage: {}%", config.slippage_bps as f64 / 100.0);
    println!("=================================\n");

    // Setup wallet from private key
    let private_key = env::var("SOLANA_PRIVATE_KEY")
        .expect("SOLANA_PRIVATE_KEY environment variable not set");
    
    let decoded = bs58::decode(&private_key)
        .into_vec()
        .expect("Failed to decode private key");
    
    let keypair = Keypair::from_bytes(&decoded)
        .expect("Failed to create keypair from bytes");
    
    // Verify the loaded wallet address
    let loaded_pubkey = keypair.pubkey().to_string();
    println!("Loaded wallet address: {}", loaded_pubkey);
    
    // Initialize clients
    let jupiter_client = JupiterSwapApiClient::new("https://quote-api.jup.ag/v6".to_string());
    let rpc_client = RpcClient::new("https://api.mainnet-beta.solana.com".to_string());
    
    // Check SOL balance
    let sol_balance = rpc_client.get_balance(&keypair.pubkey()).await?;
    println!("Current SOL balance: {} SOL", sol_balance as f64 / 1e9);

    if sol_balance < 10_000_000 { // 0.01 SOL minimum for fees
        return Err("Insufficient SOL for transaction fees. Please ensure you have at least 0.01 SOL".into());
    }

    // Check if we have enough SOL for the trade
    if sol_balance < config.sol_amount + 10_000_000 { // Adding 0.01 SOL for fees
        return Err(format!(
            "Insufficient SOL for trade. Need {} SOL but only have {} SOL", 
            (config.sol_amount + 10_000_000) as f64 / 1e9, 
            sol_balance as f64 / 1e9
        ).into());
    }

    // Automatically buy and monitor
    println!("Starting automated buy and sell process...");
    
    // Buy tokens using SOL
    let purchase = buy_token_with_sol(&jupiter_client, &rpc_client, &keypair, &config).await?;
    
    // Start monitoring for sell conditions
    monitor_price_and_sell(&jupiter_client, &rpc_client, &keypair, purchase, config.slippage_bps).await?;
    
    Ok(())
}

// Load configuration from environment variables
fn load_config_from_env() -> Result<TradingConfig, Box<dyn std::error::Error>> {
    // Get token mint from env or use a default
    let token_mint_str = env::var("TOKEN_MINT")
        .unwrap_or_else(|_| "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string()); // Default to USDC
    
    let token_mint = Pubkey::from_str(&token_mint_str)
        .map_err(|_| format!("Invalid token mint address: {}", token_mint_str))?;
    
    // Get SOL amount in SOL units, then convert to lamports
    let sol_amount_str = env::var("SOL_AMOUNT").unwrap_or_else(|_| "0.1".to_string()); // Default to 0.1 SOL
    let sol_amount_float: f64 = sol_amount_str.parse()
        .map_err(|_| format!("Invalid SOL amount: {}", sol_amount_str))?;
    let sol_amount = (sol_amount_float * 1e9) as u64; // Convert SOL to lamports
    
    // Get stop loss percentage (e.g., 0.2 = 20%)
    let stop_loss_str = env::var("STOP_LOSS_PERCENTAGE").unwrap_or_else(|_| "0.2".to_string()); // Default to 20%
    let stop_loss_percentage: f64 = stop_loss_str.parse()
        .map_err(|_| format!("Invalid stop loss percentage: {}", stop_loss_str))?;
    
    // Get take profit percentage (e.g., 0.2 = 20%)
    let take_profit_str = env::var("TAKE_PROFIT_PERCENTAGE").unwrap_or_else(|_| "0.2".to_string()); // Default to 20%
    let take_profit_percentage: f64 = take_profit_str.parse()
        .map_err(|_| format!("Invalid take profit percentage: {}", take_profit_str))?;
    
    // Get slippage in basis points (100 = 1%)
    let slippage_str = env::var("SLIPPAGE_BPS").unwrap_or_else(|_| "100".to_string()); // Default to 1%
    let slippage_bps: u16 = slippage_str.parse()
        .map_err(|_| format!("Invalid slippage basis points: {}", slippage_str))?;
    
    Ok(TradingConfig {
        token_mint,
        sol_amount,
        stop_loss_percentage,
        take_profit_percentage,
        slippage_bps,
    })
}

// Modified buy function that uses the configuration
async fn buy_token_with_sol(
    jupiter_client: &JupiterSwapApiClient,
    rpc_client: &RpcClient,
    keypair: &Keypair,
    config: &TradingConfig,
) -> Result<TokenPurchase, Box<dyn std::error::Error>> {
    // Create order for SOL → Token using Ultra API
    let order_request = OrderRequest {
        amount: config.sol_amount.to_string(),
        input_mint: NATIVE_MINT.to_string(),
        output_mint: config.token_mint.to_string(),
        slippage_bps: Some(config.slippage_bps),
        taker: Some(keypair.pubkey().to_string()),
    };
    
    println!("\nGetting quote for {} SOL to token...", config.sol_amount as f64 / 1e9);
    let order_response = order(jupiter_client, &order_request).await?;
    
    println!("\nQuote Details:");
    println!("Input: {} SOL", order_response.in_amount.parse::<f64>().unwrap() / 1e9);
    let token_amount = order_response.out_amount.parse::<f64>().unwrap();
    println!("Output: {} tokens", token_amount);
    println!("Price Impact: {}%", order_response.price_impact_pct);

    println!("\nExecuting swap...");
    
    // Decode and sign the transaction
    let tx_bytes = base64_decode(&order_response.transaction.clone().unwrap())?;
    let transaction: VersionedTransaction = bincode::deserialize(&tx_bytes)?;
    
    let signed_transaction = VersionedTransaction::try_new(
        transaction.message,
        &[keypair]
    )?;
    
    // Execute the transaction using Jupiter Ultra API
    let execute_request = ExecuteRequest {
        request_id: order_response.request_id.clone(),
        signed_transaction: base64::encode(bincode::serialize(&signed_transaction)?),
    };
    
    let execute_response = execute(jupiter_client, &execute_request).await?;
    
    // Extract the transaction signature
    let signature = execute_response.get("txId")
        .or_else(|| execute_response.get("signature"))
        .or_else(|| execute_response.get("txSignature"))
        .expect("Could not find transaction signature in response")
        .as_str()
        .expect("Transaction signature is not a string");
    
    println!("\nSwap successful!");
    println!("Transaction signature: {}", signature);
    println!("View on Solscan: https://solscan.io/tx/{}", signature);

    // Check final balances
    let final_sol_balance = rpc_client.get_balance(&keypair.pubkey()).await?;
    println!("\nFinal SOL balance: {} SOL", final_sol_balance as f64 / 1e9);
    
    // Calculate purchase price (SOL per token)
    let purchase_amount_in_sol = order_response.in_amount.parse::<f64>().unwrap() / 1e9;
    let purchase_price = token_amount / purchase_amount_in_sol; // Tokens per SOL
    
    // Calculate take profit price (lower tokens per SOL = higher token value)
    let take_profit_price = purchase_price * (1.0 - config.take_profit_percentage);
    
    // Calculate stop loss price (higher tokens per SOL = lower token value)
    let stop_loss_price = purchase_price * (1.0 + config.stop_loss_percentage);

    println!("\n===== PURCHASE SUMMARY =====");
    println!("Bought: {} tokens", token_amount);
    println!("Paid: {} SOL", purchase_amount_in_sol);
    println!("Purchase price: {} tokens per SOL", purchase_price);
    println!("Take profit target: {} tokens per SOL (-{}%)", 
             take_profit_price, config.take_profit_percentage * 100.0);
    println!("Stop loss set at: {} tokens per SOL (+{}%)", 
             stop_loss_price, config.stop_loss_percentage * 100.0);
    println!("============================\n");

    // Return purchase info
    Ok(TokenPurchase {
        token_mint: config.token_mint,
        purchase_amount: order_response.out_amount.parse::<u64>().unwrap(),
        purchase_price,
        target_price: purchase_price,
        take_profit_price,
        stop_loss_price,
    })
}

// Modified function to monitor price and sell with configurable slippage
async fn monitor_price_and_sell(
    jupiter_client: &JupiterSwapApiClient,
    _rpc_client: &RpcClient,
    keypair: &Keypair, 
    purchase: TokenPurchase,
    slippage_bps: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    // Use a shorter interval, e.g., 1 second
    let check_interval = tokio::time::Duration::from_secs(1);
    
    println!("\n===== PRICE MONITORING STARTED =====");
    println!("Original purchase price: {} tokens per SOL", purchase.purchase_price);
    println!("Will TAKE PROFIT when price decreases below {} tokens/SOL", purchase.take_profit_price);
    println!("OR will STOP LOSS when price increases above {} tokens per SOL", purchase.stop_loss_price);
    println!("Using entire purchased amount ({} tokens) for price monitoring", purchase.purchase_amount);
    println!("=====================================\n");
    
    loop {
        // Create order request to check current price using entire purchased amount
        let order_request = OrderRequest {
            amount: purchase.purchase_amount.to_string(),
            input_mint: purchase.token_mint.to_string(),
            output_mint: NATIVE_MINT.to_string(),
            slippage_bps: Some(slippage_bps),
            taker: None,
        };
        
        // Get current price using Ultra API
        let order_response = match order(jupiter_client, &order_request).await {
            Ok(response) => response,
            Err(e) => {
                println!("Error getting price: {}", e);
                tokio::time::sleep(check_interval).await;
                continue;
            }
        };
        
        // Extract total SOL amount and calculate price per token
        let sol_amount = order_response.out_amount.parse::<f64>().unwrap() / 1e9;
        let token_amount = purchase.purchase_amount as f64;
        let current_price = token_amount / sol_amount;  // Tokens per SOL
        
        // Compare current total value to original purchase value
        let original_value = token_amount / purchase.purchase_price;
        let current_value = sol_amount;
        let price_diff_pct = ((current_value / original_value) - 1.0) * 100.0;
        
        let timestamp = chrono::Local::now().format("%H:%M:%S").to_string();
        println!("[{}] Current: {} tokens/SOL | Purchase: {} tokens/SOL | Diff: {:+.6}%", 
            timestamp, current_price, purchase.purchase_price, price_diff_pct);
        
        // Check if we should sell (take profit OR stop loss triggered)
        let should_sell = current_price <= purchase.take_profit_price || current_price >= purchase.stop_loss_price;
        let sell_reason = if current_price <= purchase.take_profit_price {
            "TAKE PROFIT TARGET REACHED"
        } else if current_price >= purchase.stop_loss_price {
            "STOP LOSS TRIGGERED"
        } else {
            "UNKNOWN"
        };
        
        if should_sell {
            println!("\n===== SELL TRIGGERED: {} =====", sell_reason);
            println!("Current price: {} tokens per SOL", current_price);
            println!("Original purchase price: {} tokens per SOL", purchase.purchase_price);
            println!("Price change: {:+.6}%", price_diff_pct);
            println!("Selling all {} tokens", purchase.purchase_amount);
            println!("=========================\n");
            
            // Get actual swap transaction using Ultra API
            let sell_order_request = OrderRequest {
                amount: purchase.purchase_amount.to_string(),
                input_mint: purchase.token_mint.to_string(),
                output_mint: NATIVE_MINT.to_string(),
                slippage_bps: Some(slippage_bps),
                taker: Some(keypair.pubkey().to_string()),
            };
            
            let sell_order = order(jupiter_client, &sell_order_request).await?;
            
            // Sign and execute
            let tx_bytes = base64_decode(&sell_order.transaction.unwrap())?;
            let transaction: VersionedTransaction = bincode::deserialize(&tx_bytes)?;
            
            // Sign transaction
            let signed_transaction = VersionedTransaction::try_new(
                transaction.message,
                &[keypair]
            )?;
            
            // For transaction execution, we need the request_id:
            let execute_request = ExecuteRequest {
                request_id: sell_order.request_id,
                signed_transaction: base64::encode(bincode::serialize(&signed_transaction)?),
            };
            
            let execute_response = execute(jupiter_client, &execute_request).await?;
            
            // Using serde_json::Value directly
            let signature = execute_response.get("txId")
                .or_else(|| execute_response.get("signature"))
                .or_else(|| execute_response.get("txSignature"))
                .expect("Could not find transaction signature in response")
                .as_str()
                .expect("Transaction signature is not a string");

            println!("\n===== SELL COMPLETE =====");
            println!("Transaction signature: {}", signature);
            println!("View on Solscan: https://solscan.io/tx/{}", signature);
            println!("Profit/Loss: {:+.6}%", price_diff_pct);
            println!("========================\n");
            break;
        }
        
        tokio::time::sleep(check_interval).await;
    }
    
    Ok(())
}

// Keep the existing API client methods
async fn order(_client: &JupiterSwapApiClient, request: &OrderRequest) -> Result<OrderResponse, Box<dyn std::error::Error>> {
    let client = Client::new();
    let response = client
        .get("https://api.jup.ag/ultra/v1/order")
        .query(request)
        .send()
        .await?;
    
    if !response.status().is_success() {
        return Err(format!("Request failed with status: {}", response.status()).into());
    }
    
    let order_response = response.json::<OrderResponse>().await?;
    Ok(order_response)
}

async fn execute(_client: &JupiterSwapApiClient, request: &ExecuteRequest) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let client = Client::new();
    let response = client
        .post("https://api.jup.ag/ultra/v1/execute")
        .json(request)
        .send()
        .await?;
    
    if !response.status().is_success() {
        return Err(format!("Request failed with status: {}", response.status()).into());
    }
    
    // Return the raw JSON first to inspect the structure
    let json_response = response.json::<serde_json::Value>().await?;
    println!("Execute response: {:?}", json_response);
    Ok(json_response)
}
