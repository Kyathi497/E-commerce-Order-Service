import { createHash } from "node:crypto";
import { HttpException, Injectable } from "@nestjs/common";
import { codEnabled, config } from "../config.js";
import type { Order, OrderItem, Prisma } from "../generated/prisma/client.js";
import { AppError, type RequestUser } from "../lib/common/index.js";
import { Outbox, OutboxRelay } from "../lib/events/index.js";
import { logger } from "../logger.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { CheckoutDto } from "./dto.js";
import { findState } from "./gst.js";
import { formatOrderNumber, idempotencyHash, orderIdFrom, orderLinkToken } from "./ids.js";
import { Lifecycle } from "./lifecycle.js";
import { formatINR } from "./money.js";
import { lineKey, type OkLine, parcel, type Priced, priceOrder, stockNeeded } from "./pricing.js";
import { OPEN, PLACED } from "./states.js";
import { type Address, type EvalRequest, StockShortError, Upstream } from "./upstream.js";
import { customerView } from "./views.js";

// Who is checking out: the signed-in shopper and/or the guest cart cookie.
export interface Who {
  user?: RequestUser;
  cartToken?: string;
}

const IDEMPOTENCY_KEY = /^[\w-]{8,128}$/;

// Many checkouts can queue on the order counter at once; give them room.
const TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 };

// The year as it is in India, for the order number.
const istYear = () => Number(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", year: "numeric" }).format(new Date()));

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// The checkout saga (§6.7): price the cart, hold the coupon and the stock,
// save the order, then start the payment. Any step that fails undoes the
// ones before it. Replaying the same Idempotency-Key gives the same answer
// and never a second order.
@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly upstream: Upstream,
    private readonly lifecycle: Lifecycle,
    private readonly outbox: Outbox,
    private readonly relay: OutboxRelay,
  ) {}

  async checkout(who: Who, key: string | undefined, dto: CheckoutDto, requestId?: string) {
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Invalid request.");
    }
    const identity = who.user ? `user:${who.user.id}` : who.cartToken ? `guest:${sha256(who.cartToken)}` : null;
    if (!identity) throw cartEmpty();
    const keyHash = idempotencyHash(identity, key);
    const orderId = orderIdFrom(keyHash);

    const existing = await this.prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (existing) return this.answer(existing, requestId);

    // 1. What is being bought, by whom, and where it goes.
    const cart = await this.upstream.findCart(who.user ? { userId: who.user.id } : { cartToken: who.cartToken }, requestId);
    if (!cart || cart.lines.length === 0) throw cartEmpty();
    const account = who.user ? await this.upstream.user(who.user.id, requestId) : null;
    if (dto.addressId && !who.user) throw new AppError(401, "UNAUTHENTICATED", "Please log in to use a saved address.");
    const address: Address = dto.addressId ? await this.upstream.address(who.user!.id, dto.addressId, requestId) : dto.address!;
    const state = findState(address.state);
    if (!state) throw invalid("address.state", "Choose your state from the list.");
    const email = account?.email ?? dto.email?.toLowerCase() ?? null;
    if (!email) throw invalid("email", "Enter your email for the order confirmation.");

    // 2. Price it: catalog, shipping, offers and coupon, GST (§6.7).
    const catalog = await this.upstream.price(cart.lines, requestId);
    if (catalog.some((c) => c.status !== "ok")) {
      throw new AppError(409, "CANT_CHECK_OUT", "Some items in your cart are no longer sold. Remove them to continue.");
    }
    const ok = catalog as OkLine[];
    const gross = ok.reduce((s, c) => s + c.lineTotalPaise, 0);
    const { grams, units } = parcel(cart.lines, ok);
    const quoteFor = (subtotalPaise: number) =>
      this.upstream.quote({ pincode: address.pincode, subtotalPaise, weightGrams: grams, units }, requestId);

    let quote = await quoteFor(gross);
    if (quote?.serviceability?.serviceable === false) {
      throw new HttpException({ error: quote.serviceability.message, code: "NOT_DELIVERABLE", fields: { "address.pincode": quote.serviceability.message } }, 409);
    }
    const evalRequest: EvalRequest = {
      lines: cart.lines.map((l, i) => ({
        key: lineKey(l),
        productId: ok[i]!.productId,
        categoryId: ok[i]!.categoryId,
        bundleId: ok[i]!.bundleId,
        qty: l.qty,
        lineTotalPaise: ok[i]!.lineTotalPaise,
      })),
      shippingPaise: quote?.shippingPaise ?? config.FALLBACK_SHIPPING_PAISE,
      ...(cart.couponCode && { couponCode: cart.couponCode }),
      ...(who.user && { userId: who.user.id }),
      email,
      previousOrders: await this.previousOrders(who.user?.id, email),
    };
    let evaluation = await this.upstream.evaluate(evalRequest, requestId);
    if (!evaluation && cart.couponCode) {
      throw new AppError(503, "PROMOTIONS_UNAVAILABLE", "We couldn't check your coupon just now. Remove it to check out without it, or try again in a minute.");
    }
    // Shipping rules look at the total after discounts (as the cart does).
    if (evaluation && evaluation.discountPaise > 0 && quote) {
      const net = await quoteFor(gross - evaluation.discountPaise);
      if (net && net.shippingPaise !== quote.shippingPaise) {
        evalRequest.shippingPaise = net.shippingPaise;
        evaluation = (await this.upstream.evaluate(evalRequest, requestId)) ?? evaluation;
      }
      quote = net ?? quote;
    }
    if (evaluation?.coupon && !evaluation.coupon.applied) {
      const message = evaluation.coupon.message;
      throw new HttpException({ error: message, code: "COUPON_NOT_APPLICABLE", fields: { coupon: message } }, 422);
    }
    const shippingPaise = quote?.shippingPaise ?? config.FALLBACK_SHIPPING_PAISE;
    const priced = priceOrder({ lines: cart.lines, catalog: ok, evaluation, shippingPaise, placeOfSupply: state.code, storeState: config.STORE_STATE_CODE });

    if (dto.expectedTotalPaise !== priced.totalPaise) {
      throw new HttpException(
        {
          error: `Your total is now ${formatINR(priced.totalPaise)}. Please check the order summary and try again.`,
          code: "TOTAL_CHANGED",
          totalPaise: priced.totalPaise,
        },
        409,
      );
    }
    if (dto.paymentMethod === "cod") await this.checkCod(priced.totalPaise, quote?.serviceability?.codAvailable ?? null, address.phone);

    // 3. Hold the coupon use and the stock while the customer pays.
    const couponCode = evaluation?.coupon?.applied ? evaluation.coupon.code : null;
    const held = { coupon: false, stock: false };
    try {
      if (couponCode) {
        const hold = await this.upstream.reserveCoupon({ ...evalRequest, orderId, couponCode, phone: address.phone }, requestId);
        held.coupon = true;
        if (hold.evaluation && hold.evaluation.discountPaise !== priced.discountPaise) {
          throw new AppError(409, "TOTAL_CHANGED", "Your coupon's discount just changed. Please check the order summary and try again.");
        }
      }
      await this.upstream.reserveStock(orderId, stockNeeded(cart.lines, ok), requestId);
      held.stock = true;

      // 4. Save the order with everything copied onto it.
      const order = await this.insert({
        orderId,
        keyHash,
        who,
        cartId: cart.id,
        email,
        address,
        placeOfSupply: state.code,
        stateName: state.name,
        paymentMethod: dto.paymentMethod,
        couponCode,
        priced,
        note: dto.note ?? null,
        requestId,
      });
      this.relay.kick();
      logger.info({ orderId, orderNumber: order.orderNumber, paymentMethod: order.paymentMethod, totalPaise: order.totalPaise }, "order placed");
      // 5. Start the payment (prepaid) and answer.
      return this.answer(order, requestId);
    } catch (err) {
      // A retry of this same checkout got there first: it owns the holds.
      if ((err as { code?: string }).code === "P2002") {
        const winner = await this.prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
        if (winner) return this.answer(winner, requestId);
      }
      await this.compensate(orderId, held, requestId);
      if (err instanceof StockShortError) throw stockShort(err);
      throw err;
    }
  }

  // The checkout answer: the order, a link token for guests, and for an
  // unpaid prepaid order what the browser needs to open Razorpay Checkout.
  async answer(order: Order & { items: OrderItem[] }, requestId?: string) {
    const answer = {
      order: customerView(order),
      viewToken: orderLinkToken(config.ORDER_LINK_SECRET, order.orderNumber, config.ORDER_LINK_DAYS),
      payment: null as null | {
        mode: "live" | "test";
        keyId: string | null;
        razorpayOrderId: string;
        amountPaise: number;
        currency: string;
        prefill: { name: string; email: string | null; contact: string };
      },
    };
    if (order.paymentMethod === "prepaid" && order.status === "PENDING_PAYMENT") {
      const created = await this.upstream.createPayment(
        {
          orderId: order.id,
          orderNumber: order.orderNumber,
          amountPaise: order.totalPaise,
          customer: { name: order.contactName, email: order.contactEmail, phone: order.contactPhone },
        },
        requestId,
      );
      if (!created.checkout) throw new AppError(503, "PAYMENT_UNAVAILABLE", "We couldn't start the payment just now. Please try again in a minute.");
      answer.payment = {
        ...created.checkout,
        amountPaise: created.payment.amountPaise,
        currency: created.payment.currency,
        prefill: { name: order.contactName, email: order.contactEmail, contact: order.contactPhone },
      };
    }
    return answer;
  }

  private async insert(input: {
    orderId: string;
    keyHash: string;
    who: Who;
    cartId: string;
    email: string;
    address: Address;
    placeOfSupply: string;
    stateName: string;
    paymentMethod: "prepaid" | "cod";
    couponCode: string | null;
    priced: Priced;
    note: string | null;
    requestId?: string;
  }) {
    const { priced, address } = input;
    const snapshot = {
      name: address.name,
      phone: address.phone,
      line1: address.line1,
      line2: address.line2 ?? null,
      landmark: address.landmark ?? null,
      city: address.city,
      state: input.stateName,
      stateCode: input.placeOfSupply,
      pincode: address.pincode,
    } satisfies Prisma.InputJsonObject;
    const actor = input.who.user ? "customer" : "guest";

    return this.prisma.$transaction(async (tx) => {
      const year = istYear();
      await tx.$executeRaw`
        INSERT INTO OrderCounter (year, last) VALUES (${year}, LAST_INSERT_ID(1))
        ON DUPLICATE KEY UPDATE last = LAST_INSERT_ID(last + 1)`;
      const [row] = await tx.$queryRaw<{ n: bigint | number }[]>`SELECT LAST_INSERT_ID() AS n`;
      const orderNumber = formatOrderNumber(year, Number(row!.n));

      let order = await tx.order.create({
        data: {
          id: input.orderId,
          orderNumber,
          userId: input.who.user?.id ?? null,
          contactName: address.name,
          contactEmail: input.email,
          contactPhone: address.phone,
          paymentMethod: input.paymentMethod,
          subtotalPaise: priced.subtotalPaise,
          discountPaise: priced.discountPaise,
          shippingPaise: priced.shippingPaise,
          shippingDiscountPaise: priced.shippingDiscountPaise,
          taxPaise: priced.taxPaise,
          totalPaise: priced.totalPaise,
          taxBreakup: {
            cgstPaise: priced.tax.cgstPaise,
            sgstPaise: priced.tax.sgstPaise,
            igstPaise: priced.tax.igstPaise,
            intraState: priced.tax.intraState,
            shippingTaxPaise: priced.tax.shippingTaxPaise,
            rates: priced.tax.rates,
          },
          placeOfSupply: input.placeOfSupply,
          couponCode: input.couponCode,
          shippingAddress: snapshot,
          billingAddress: snapshot,
          reservationKey: input.orderId,
          idempotencyKey: input.keyHash,
          cartId: input.cartId,
          customerNote: input.note,
          items: { create: priced.items.map((i) => ({ ...i, components: i.components })) },
          history: { create: { fromStatus: null, toStatus: "PENDING_PAYMENT", actor, reason: "Order placed" } },
        },
      });
      await this.outbox.publish(
        tx,
        "order.created",
        { orderId: order.id, orderNumber, paymentMethod: order.paymentMethod, totalPaise: order.totalPaise, userId: order.userId },
        { correlationId: input.requestId },
      );
      // Cash on delivery skips the payment step (§6.7).
      if (input.paymentMethod === "cod") {
        order = await this.lifecycle.confirm(tx, order, { actor: "system", reason: "Cash on delivery", requestId: input.requestId });
      }
      return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: { orderBy: { position: "asc" } } } });
    }, TX_OPTIONS);
  }

  // COD rules (§17 question 1): an order limit, a PIN code that supports it,
  // and one open COD order per phone number.
  private async checkCod(totalPaise: number, codAvailable: boolean | null, phone: string) {
    const refuse = (message: string) => {
      throw new HttpException({ error: message, code: "COD_UNAVAILABLE", fields: { paymentMethod: message } }, 422);
    };
    if (!codEnabled) refuse("Cash on delivery isn't available right now. Please pay online.");
    if (totalPaise > config.COD_MAX_PAISE) refuse(`Cash on delivery is available on orders up to ${formatINR(config.COD_MAX_PAISE)}. Please pay online.`);
    if (codAvailable !== true) refuse("Cash on delivery isn't available for this PIN code. Please pay online.");
    const open = await this.prisma.order.count({ where: { contactPhone: phone, paymentMethod: "cod", status: { in: OPEN } } });
    if (open >= config.COD_MAX_OPEN_PER_PHONE) {
      refuse("You already have a cash-on-delivery order on its way. Please pay online for this one.");
    }
  }

  // Orders this customer placed before, for first-order offers (§6.6).
  private previousOrders(userId: string | undefined, email: string) {
    return this.prisma.order.count({
      where: { status: { in: PLACED }, OR: [...(userId ? [{ userId }] : []), { contactEmail: email }] },
    });
  }

  // Undo the holds of a checkout that didn't finish. If a release fails the
  // hold still runs out on its own after 15 minutes.
  private async compensate(orderId: string, held: { coupon: boolean; stock: boolean }, requestId?: string) {
    if (held.stock) {
      await this.upstream.releaseStock(orderId, requestId).catch((err) => logger.error({ err, orderId }, "stock release after a failed checkout failed"));
    }
    if (held.coupon) {
      await this.upstream.releaseCoupon(orderId, requestId).catch((err) => logger.error({ err, orderId }, "coupon release after a failed checkout failed"));
    }
  }
}

const cartEmpty = () => new AppError(422, "CART_EMPTY", "Your cart is empty. Please add something and try again.");

const invalid = (field: string, message: string) => new AppError(422, "VALIDATION_FAILED", "Please check the highlighted fields.", { [field]: message });

function stockShort(err: StockShortError) {
  const names = [...new Set(err.short.map((s) => s.name).filter(Boolean))];
  const what = names.length ? names.join(", ") : "Some items";
  return new HttpException(
    {
      error: `${what} just ran out. Please reduce the quantity or remove ${names.length > 1 ? "them" : "it"} from your cart.`,
      code: "STOCK_SHORT",
      short: err.short,
    },
    409,
  );
}
