import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { config } from "../config.js";
import { OutboxRelay } from "../lib/events/index.js";
import { logger } from "../logger.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { Lifecycle, lockOrder } from "./lifecycle.js";
import { PLACED } from "./states.js";
import { Upstream } from "./upstream.js";

// Two safety nets, run in every replica (each order is changed under its row
// lock, so two replicas never act on the same one):
// - an order still unpaid long after its stock hold ran out is cancelled, in
//   case inventory's reservation.expired never arrived;
// - once an order is confirmed, what was bought leaves the shopper's cart,
//   even if they closed the tab before the store could clear it.
@Injectable()
export class OrderSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: Lifecycle,
    private readonly relay: OutboxRelay,
    private readonly upstream: Upstream,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      this.running = Promise.all([
        this.cancelStale().catch((err) => logger.error({ err }, "stale order sweep failed")),
        this.clearCarts().catch((err) => logger.error({ err }, "cart clean-up sweep failed")),
      ]);
    }, config.SWEEP_SECONDS * 1000);
    this.timer.unref();
  }

  async onApplicationShutdown() {
    clearInterval(this.timer);
    await this.running;
  }

  async cancelStale(limit = 20) {
    const before = new Date(Date.now() - config.PENDING_TIMEOUT_MINUTES * 60_000);
    const stale = await this.prisma.order.findMany({
      where: { status: "PENDING_PAYMENT", placedAt: { lt: before } },
      select: { id: true },
      take: limit,
    });
    for (const { id } of stale) {
      await this.prisma.$transaction(async (tx) => {
        const order = await lockOrder(tx, { id });
        if (order?.status !== "PENDING_PAYMENT") return;
        await this.lifecycle.cancel(tx, order, { actor: "system", reason: "payment_timeout" });
      });
    }
    if (stale.length) {
      this.relay.kick();
      logger.warn({ cancelled: stale.length }, "cancelled unpaid orders that inventory never expired");
    }
  }

  async clearCarts(limit = 20) {
    const due = await this.prisma.order.findMany({
      where: { cartCleared: false, cartId: { not: null }, status: { in: PLACED } },
      include: { items: true },
      take: limit,
    });
    for (const order of due) {
      try {
        await this.upstream.removeOrdered(order.cartId!, {
          placedAt: order.placedAt.toISOString(),
          couponCode: order.couponCode,
          lines: order.items.map((i) => ({ kind: i.kind === "sku" ? "product" : "combo", ref: i.ref, qty: i.qty })),
        });
        await this.prisma.order.update({ where: { id: order.id }, data: { cartCleared: true } });
      } catch (err) {
        logger.warn({ err, orderId: order.id }, "couldn't clear the ordered items from the cart; will retry");
      }
    }
  }
}
