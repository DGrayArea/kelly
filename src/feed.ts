/**
 * Push-based event feed for a Kuru market.
 *
 * The SDK ships a MarketListener, but it wraps a JsonRpcProvider, so ethers v5
 * degrades contract.on() to ~4s HTTP polling. We bind the same OrderBook ABI to
 * a WebSocketProvider instead to get true push events.
 */
import { ethers, BigNumber } from "ethers";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import type { MarketParams } from "@kuru-labs/kuru-sdk/dist/types/types";

export interface DecodedOrder {
  kind: "order";
  ts: number;
  orderId: string;
  owner: string;
  price: number;
  size: number;
  isBuy: boolean;
}

export interface DecodedTrade {
  kind: "trade";
  ts: number;
  orderId: string;
  price: number;
  filledSize: number;
  updatedSize: number;
  taker: string;
  maker: string;
  isBuy: boolean;
}

export type MarketEvent = DecodedOrder | DecodedTrade;

/** Raw on-chain ints are scaled by the market's precision factors. */
function toNum(v: BigNumber, precision: BigNumber): number {
  if (!v) return NaN;
  const p = precision.toString();
  return Number(ethers.utils.formatUnits(v, p.length - 1));
}

/**
 * The two events do NOT share a price scale, which is easy to miss:
 *   OrderCreated.price is uint32, scaled by marketParams.pricePrecision (1e8)
 *   Trade.price        is uint256, scaled by 1e18 (WAD)
 * Verified against the live L2 mid. Decoding Trade with pricePrecision yields a
 * price ~1e10 too large and silently poisons every downstream signal.
 */
const TRADE_PRICE_DECIMALS = 18;

function tradePriceToNum(v: BigNumber): number {
  if (!v) return NaN;
  return Number(ethers.utils.formatUnits(v, TRADE_PRICE_DECIMALS));
}

export class MarketFeed {
  private provider: ethers.providers.WebSocketProvider;
  private contract: ethers.Contract;

  constructor(
    wsUrl: string,
    private marketAddress: string,
    private mp: MarketParams
  ) {
    this.provider = new ethers.providers.WebSocketProvider(wsUrl);
    this.contract = new ethers.Contract(
      marketAddress,
      (OrderBookAbi as any).abi,
      this.provider
    );
  }

  /**
   * Args are read by NAME off the event object, never by position.
   * The SDK's own MarketListener destructures Trade positionally with 6 params
   * while the ABI emits 8, which silently shifts every field. Named access is
   * immune to that and to future ABI reordering.
   */
  onOrder(cb: (e: DecodedOrder) => void) {
    this.contract.on("OrderCreated", (...args: any[]) => {
      const a = args[args.length - 1]?.args;
      if (!a) return;
      cb({
        kind: "order",
        ts: Date.now(),
        orderId: a.orderId.toString(),
        owner: a.owner,
        price: toNum(a.price, this.mp.pricePrecision),
        size: toNum(a.size, this.mp.sizePrecision),
        isBuy: a.isBuy,
      });
    });
  }

  onTrade(cb: (e: DecodedTrade) => void) {
    this.contract.on("Trade", (...args: any[]) => {
      const a = args[args.length - 1]?.args;
      if (!a) return;
      cb({
        kind: "trade",
        ts: Date.now(),
        orderId: a.orderId.toString(),
        isBuy: a.isBuy,
        price: tradePriceToNum(a.price),
        updatedSize: toNum(a.updatedSize, this.mp.sizePrecision),
        filledSize: toNum(a.filledSize, this.mp.sizePrecision),
        taker: a.takerAddress,
        maker: a.makerAddress,
      });
    });
  }

  onStatus(cb: (s: string) => void) {
    const ws: any = (this.provider as any)._websocket;
    if (!ws) return;
    ws.on?.("close", () => cb("websocket closed"));
    ws.on?.("error", (e: any) => cb("websocket error: " + (e?.message || e)));
  }

  async close() {
    this.contract.removeAllListeners();
    await this.provider.destroy();
  }
}
