import { z } from "zod";
import type { Plugin, WalletClient, Chain } from "@goat-sdk/core";

async function fetchTokensOnBase() {
    try {
        // Using Base token list API
        const response = await fetch('https://raw.githubusercontent.com/ethereum-lists/tokens/master/tokens/base/tokens-base.json');
        if (!response.ok) {
            throw new Error('Failed to fetch Base tokens');
        }

        const tokens = await response.json();
        
        // Transform the data into our required format
        return tokens.map((token: any) => ({
            symbol: token.symbol,
            address: token.address,
            decimals: token.decimals,
            name: token.name
        }));
    } catch (error) {
        console.error('Error fetching Base tokens:', error);
        // Return some default tokens in case of API failure
        return [
            {
                symbol: "USDC",
                address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                decimals: 6,
                name: "USD Coin"
            },
            {
                symbol: "WETH",
                address: "0x4200000000000000000000000000000000000006",
                decimals: 18,
                name: "Wrapped Ether"
            },
            {
                symbol: "BTC",
                address: "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b",
                decimals: 8,
                name: "Bitcoin"
            },
            {
                symbol: "SOL",
                address: "0x1C6aE197fF4BF7BA96726FB6633cc0A8B0d169C8",
                decimals: 9,
                name: "Solana"
            }
        ];
    }
}

function calculateVolatility(historicalPrices: number[]): number {
    if (!historicalPrices || historicalPrices.length < 2) return 0;

    // Calculate daily returns
    const returns = [];
    for (let i = 1; i < historicalPrices.length; i++) {
        const dailyReturn = (historicalPrices[i] - historicalPrices[i - 1]) / historicalPrices[i - 1];
        returns.push(dailyReturn);
    }

    // Calculate mean of returns
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;

    // Calculate variance
    const variance = returns.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / returns.length;

    // Return standard deviation (volatility)
    return Math.sqrt(variance);
}

async function analyzeTokens(tokens) {
    async function getTokenMetrics(token) {
        try {
            // Fetch additional historical data for volatility calculation
            const response = await fetch(`https://mainnet.base.org/v1/tokens/${token.address}/metrics`);
            const metrics = await response.json();
            
            // Calculate volatility from historical price data (assuming API provides this)
            const volatility = calculateVolatility(metrics.historicalPrices || []);
            
            return {
                price: metrics.price || 0,
                volume24h: metrics.volume24h || 0,
                priceChange24h: metrics.priceChange24h || 0,
                liquidityUSD: metrics.liquidityUSD || 0,
                volatility,
                volumeToLiquidity: metrics.volume24h / metrics.liquidityUSD || 0
            };
        } catch (error) {
            console.error(`Error fetching metrics for ${token.symbol}:`, error);
            return null;
        }
    }

    const analyzedTokens = await Promise.all(
        tokens.map(async (token) => {
            const metrics = await getTokenMetrics(token);
            if (!metrics) return null;

            // Determine token characteristics based on metrics
            const isHighVolatility = metrics.volatility > 0.1; // 10% daily volatility
            const isHighTurnover = metrics.volumeToLiquidity > 0.5; // 50% daily volume/liquidity ratio

            // Adjust criteria based on volatility profile
            const isProfitable = isHighVolatility && isHighTurnover
                ? // High volatility token criteria
                  metrics.liquidityUSD >= 25000 &&    // Lower liquidity requirement
                  metrics.volume24h >= 15000 &&       // Moderate volume requirement
                  metrics.priceChange24h < -3         // Look for bigger dips
                : // Standard token criteria
                  metrics.liquidityUSD >= 100000 &&
                  metrics.volume24h >= 50000 &&
                  metrics.priceChange24h < 0;

            return isProfitable ? {
                ...token,
                riskProfile: isHighVolatility ? 'high' : 'standard',
                metrics
            } : null;
        })
    );

    return analyzedTokens.filter(token => token !== null);
}

async function executeTrade(walletClient: WalletClient, token: any, amount: number) {
    try {
        // Standard WETH address on Base
        const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
        
        // Base router address
        const routerAddress = "0xaa8d210f7c34a056Bb573f15962673C5c24fbd10";
        const routerABI = [
            "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts)",
            "function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external payable returns (uint256[] memory amounts)"
        ];
        const router = await walletClient.getContract(routerAddress, routerABI);

        // Calculate deadline (30 minutes from now)
        const deadline = Math.floor(Date.now() / 1000) + 1800;

        // Define the trading path
        const path = [WETH_ADDRESS, token.address];

        // Get quote for the swap to calculate minimum output
        const quoteResponse = await fetch(`https://mainnet.base.org/v1/quote?fromToken=${WETH_ADDRESS}&toToken=${token.address}&amount=${amount}`);
        const quote = await quoteResponse.json();
        
        // Calculate minimum amount out with 0.5% slippage tolerance
        const slippageTolerance = 0.005; // 0.5%
        const minimumAmountOut = Math.floor(quote.expectedOutput * (1 - slippageTolerance));

        // Execute the swap with slippage protection
        const tx = await router.swapExactETHForTokens(
            minimumAmountOut,
            path,
            await walletClient.getAddress(),
            deadline,
            { value: amount }
        );
        const receipt = await tx.wait();

        console.log(`Trade executed: Bought ${token.symbol} with ${amount} ETH`);
        return {
            success: true,
            hash: receipt.hash,
            amount: amount,
            token: token.symbol
        };
    } catch (error) {
        console.error(`Trade execution failed for ${token.symbol}:`, error);
        throw new Error(`Failed to execute trade: ${error.message}`);
    }
}

export function dynamicBaseTrading(): Plugin {
    return {
        name: "Dynamic Base Trading",
        supportsChain: (chain: Chain) => chain.id === 8453, // Base chain ID
        supportsSmartWallets: () => true,
        getTools: async (walletClient: WalletClient) => {
            return [
                {
                    name: "find_and_trade_base_tokens",
                    description: "This {{tool}} finds profitable tokens on Base and executes trades",
                    parameters: z.object({
                        amount: z.number().optional(),
                    }),
                    method: async (parameters) => {
                        const { amount = 1 } = parameters;
                        
                        const availableTokens = await fetchTokensOnBase();
                        const profitableTokens = await analyzeTokens(availableTokens);
                        
                        let results = [];
                        for (let token of profitableTokens) {
                            const result = await executeTrade(walletClient, token, amount);
                            results.push(result);
                        }
                        
                        return `Trades executed: ${results.join(', ')}`;
                    },
                },
            ];
        },
    };
}