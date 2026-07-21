import * as dotenv from "dotenv";
dotenv.config();

export type NetworkName = "mainnet" | "testnet";

export const NETWORKS = {
  mainnet: {
    rpcUrl: process.env.MONAD_RPC_URL || "https://rpc.monad.xyz",
    wsUrl: process.env.MONAD_WS_URL || "wss://rpc.monad.xyz",
    router: "0xd651346d7c789536ebf06dc72aE3C8502cd695CC",
    marginAccount: "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5",
    markets: {
      "MON-USDC": "0x065C9d28E428A0db40191a54d33d5b7c71a9C394",
      "MON-AUSD": "0x131a2e70a5b31a517a74b8c567149bc294470da9",
    },
  },
  testnet: {
    rpcUrl: process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz",
    wsUrl: process.env.MONAD_TESTNET_WS_URL || "wss://testnet-rpc.monad.xyz",
    router: "0x7EFbE105Ca7415dE98F96622173458ac1c054630",
    marginAccount: "0xd029C2D98ff85D8F64799017fE00a59B1159CE02",
    markets: {
      "MON-USDC": "0xa241896A7Dbe8a550D2E5fF7A914bB1989ceD2D9",
    },
  },
} as const;

export const NETWORK: NetworkName =
  (process.env.NETWORK as NetworkName) || "mainnet";

export const MARKET = process.env.MARKET || "MON-USDC";

/**
 * Hard safety gate. Signing is only possible when DRY_RUN is the literal string
 * "false". Anything else (unset, empty, typo) keeps the agent dry.
 */
export const DRY_RUN = process.env.DRY_RUN !== "false";

export const BANKROLL_USD = Number(process.env.BANKROLL_USD || 25);

export function activeNetwork() {
  return NETWORKS[NETWORK];
}

export function marketAddress(): string {
  const net = activeNetwork();
  const addr = (net.markets as Record<string, string>)[MARKET];
  if (!addr) {
    throw new Error(
      `Unknown market "${MARKET}" on ${NETWORK}. Available: ${Object.keys(net.markets).join(", ")}`
    );
  }
  return addr;
}
