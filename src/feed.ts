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

/**
 * Auto-reconnecting market feed.
 *
 * A long run cannot trust a single WebSocket. Two distinct failure modes, both
 * observed in practice:
 *   1. the socket emits 'close' and stops           -> reconnect on the event
 *   2. the socket stays "open" but silently stops
 *      delivering messages                          -> only a staleness
 *                                                      watchdog catches this
 * An 8h recording died 29 minutes in because the close was logged and never
 * acted on, losing 94% of the run. Both paths now force a rebuild.
 */
export class MarketFeed {
  private provider!: ethers.providers.WebSocketProvider;
  private contract!: ethers.Contract;
  private orderCb?: (e: DecodedOrder) => void;
  private tradeCb?: (e: DecodedTrade) => void;
  private statusCb?: (s: string) => void;
  private lastEventAt = Date.now();
  private reconnects = 0;
  private closed = false;
  private watchdog?: NodeJS.Timeout;

  /** Force a reconnect if nothing arrives for this long. */
  private readonly stalenessMs = 5 * 60_000;

  constructor(
    private wsUrl: string,
    private marketAddress: string,
    private mp: MarketParams
  ) {
    this.connect();
    this.watchdog = setInterval(() => this.checkStale(), 60_000);
  }

  private connect() {
    this.provider = new ethers.providers.WebSocketProvider(this.wsUrl);
    this.contract = new ethers.Contract(
      this.marketAddress,
      (OrderBookAbi as any).abi,
      this.provider
    );
    this.attach();
    this.bindSocket();
  }

  /** Re-register whichever handlers the caller asked for. */
  private attach() {
    if (this.orderCb) this.bindOrder(this.orderCb);
    if (this.tradeCb) this.bindTrade(this.tradeCb);
  }

  private bindSocket() {
    const ws: any = (this.provider as any)._websocket;
    if (!ws) return;
    ws.on?.("close", () => this.recover("websocket closed"));
    ws.on?.("error", (e: any) =>
      this.recover("websocket error: " + (e?.message || e))
    );
  }

  private checkStale() {
    if (this.closed) return;
    const idle = Date.now() - this.lastEventAt;
    if (idle > this.stalenessMs) {
      this.recover(`no events for ${(idle / 60000).toFixed(1)}m (silent stall)`);
    }
  }

  private async recover(reason: string) {
    if (this.closed) return;
    this.reconnects++;
    const wait = Math.min(1000 * 2 ** Math.min(this.reconnects, 5), 30_000);
    this.statusCb?.(`${reason} -> reconnecting in ${wait / 1000}s (#${this.reconnects})`);

    try {
      this.contract?.removeAllListeners();
      await this.provider?.destroy();
    } catch {
      /* already gone */
    }

    setTimeout(() => {
      if (this.closed) return;
      try {
        this.connect();
        this.lastEventAt = Date.now(); // grace period after rebuild
        this.statusCb?.(`reconnected (#${this.reconnects})`);
      } catch (e: any) {
        this.recover("reconnect failed: " + (e?.message || e));
      }
    }, wait);
  }

  get reconnectCount() {
    return this.reconnects;
  }

  /**
   * Args are read by NAME off the event object, never by position.
   * The SDK's own MarketListener destructures Trade positionally with 6 params
   * while the ABI emits 8, which silently shifts every field. Named access is
   * immune to that and to future ABI reordering.
   */
  onOrder(cb: (e: DecodedOrder) => void) {
    this.orderCb = cb;
    this.bindOrder(cb);
  }

  private bindOrder(cb: (e: DecodedOrder) => void) {
    this.contract.on("OrderCreated", (...args: any[]) => {
      this.lastEventAt = Date.now();
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
    this.tradeCb = cb;
    this.bindTrade(cb);
  }

  private bindTrade(cb: (e: DecodedTrade) => void) {
    this.contract.on("Trade", (...args: any[]) => {
      this.lastEventAt = Date.now();
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
    this.statusCb = cb;
  }

  async close() {
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    try {
      this.contract?.removeAllListeners();
      await this.provider?.destroy();
    } catch {
      /* already gone */
    }
  }
}
