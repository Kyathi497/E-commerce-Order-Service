import { Injectable } from "@nestjs/common";
import { config } from "../config.js";
import type { Prisma } from "../generated/prisma/client.js";
import { AppError, decodeCursor, type RequestUser, toPage } from "../lib/common/index.js";
import { OutboxRelay } from "../lib/events/index.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { AdminCancelDto, AdminListQuery, AdminStatusDto, TrackDto } from "./dto.js";
import { checkOrderLinkToken, ORDER_NUMBER } from "./ids.js";
import { Lifecycle, lockOrder } from "./lifecycle.js";
import { ADMIN_CANCELLABLE, adminCanMove, CUSTOMER_CANCELLABLE, type Status } from "./states.js";
import { Upstream } from "./upstream.js";
import { adminSummaryView, adminView, customerView, summaryView } from "./views.js";

const notFound = () => new AppError(404, "NOT_FOUND", "We couldn't find that order.");
const withItems = { items: { orderBy: { position: "asc" as const } } } satisfies Prisma.OrderInclude;
const full = { ...withItems, history: true, notes: true } satisfies Prisma.OrderInclude;

// A shopper's own order, or a guest holding the signed link (§6.7, §10).
export interface Viewer {
  user?: RequestUser;
  token?: string;
}

const TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 };

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: Lifecycle,
    private readonly relay: OutboxRelay,
    private readonly upstream: Upstream,
  ) {}

  // --- customer ---

  // Checkouts that were never paid stay out of the list.
  async list(userId: string, limit = 20, cursor?: string) {
    const after = decodeCursor<{ id: string }>(cursor);
    const rows = await this.prisma.order.findMany({
      where: { userId, NOT: { status: "CANCELLED", confirmedAt: null } },
      include: withItems,
      orderBy: [{ placedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(after && { cursor: { id: after.id }, skip: 1 }),
    });
    const page = toPage(rows, limit, (o) => ({ id: o.id }));
    return { items: page.items.map(summaryView), nextCursor: page.nextCursor };
  }

  async get(number: string, viewer: Viewer) {
    const order = await this.findVisible(number, viewer);
    return { order: customerView(order) };
  }

  async cancel(number: string, viewer: Viewer, reason?: string, requestId?: string) {
    const visible = await this.findVisible(number, viewer);
    const order = await this.prisma.$transaction(async (tx) => {
      const current = await lockOrder(tx, { id: visible.id });
      if (!current) throw notFound();
      if (!CUSTOMER_CANCELLABLE.includes(current.status as Status)) {
        throw new AppError(409, "CANT_CANCEL", "This order has already been packed, so it can't be cancelled. Please contact us on WhatsApp.");
      }
      const cancelled = await this.lifecycle.cancel(tx, current, { actor: viewer.user ? "customer" : "guest", reason: "customer_request", requestId });
      if (reason) await this.lifecycle.note(tx, current.id, `Customer's reason: ${reason}`);
      return tx.order.findUniqueOrThrow({ where: { id: cancelled.id }, include: full });
    }, TX_OPTIONS);
    this.relay.kick();
    return { order: customerView(order) };
  }

  // Guests track an order with its number and the phone it was placed with.
  async track(dto: TrackDto) {
    const order = await this.prisma.order.findUnique({ where: { orderNumber: dto.orderNumber }, include: full });
    if (!order || order.contactPhone !== dto.phone) {
      throw new AppError(404, "NOT_FOUND", "We couldn't find an order with that number and phone. Check both and try again.");
    }
    const { contact: _contact, shippingAddress: _address, ...view } = customerView(order);
    return { order: view };
  }

  // Someone else's order answers 404, never 403, so numbers can't be probed.
  private async findVisible(number: string, viewer: Viewer) {
    if (!ORDER_NUMBER.test(number)) throw notFound();
    const order = await this.prisma.order.findUnique({ where: { orderNumber: number }, include: full });
    if (!order) throw notFound();
    const owner = viewer.user && order.userId === viewer.user.id;
    const linked = viewer.token && checkOrderLinkToken(config.ORDER_LINK_SECRET, number, viewer.token);
    if (!owner && !linked) throw notFound();
    return order;
  }

  // --- admin ---

  async adminList(query: AdminListQuery) {
    const limit = query.limit ?? 50;
    const after = decodeCursor<{ id: string }>(query.cursor);
    const rows = await this.prisma.order.findMany({
      where: this.adminWhere(query),
      include: withItems,
      orderBy: [{ placedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(after && { cursor: { id: after.id }, skip: 1 }),
    });
    const page = toPage(rows, limit, (o) => ({ id: o.id }));
    return { items: page.items.map(adminSummaryView), nextCursor: page.nextCursor };
  }

  async adminGet(number: string, requestId?: string) {
    const order = await this.prisma.order.findUnique({ where: { orderNumber: number }, include: full });
    if (!order) throw notFound();
    return { order: adminView(order, await this.upstream.paymentFor(order.id, requestId)) };
  }

  async adminSetStatus(admin: RequestUser, number: string, dto: AdminStatusDto, requestId?: string) {
    await this.prisma.$transaction(async (tx) => {
      const order = await lockOrder(tx, { orderNumber: number });
      if (!order) throw notFound();
      if (order.version !== dto.version) throw changed();
      if (!adminCanMove(order.status as Status, dto.status)) {
        throw new AppError(409, "ILLEGAL_TRANSITION", `An order that is ${order.status} can't be moved to ${dto.status} by hand.`);
      }
      await this.lifecycle.move(tx, order, dto.status, { actor: `admin:${admin.id}`, reason: dto.reason ?? null, requestId });
      await tx.auditLog.create({ data: { actorId: admin.id, action: "order.status", target: order.id, meta: { from: order.status, to: dto.status } } });
    }, TX_OPTIONS);
    this.relay.kick();
    return this.adminGet(number, requestId);
  }

  async adminCancel(admin: RequestUser, number: string, dto: AdminCancelDto, requestId?: string) {
    await this.prisma.$transaction(async (tx) => {
      const order = await lockOrder(tx, { orderNumber: number });
      if (!order) throw notFound();
      if (order.version !== dto.version) throw changed();
      if (!ADMIN_CANCELLABLE.includes(order.status as Status)) {
        throw new AppError(409, "CANT_CANCEL", "Only orders that haven't shipped can be cancelled. Use a return for this one.");
      }
      await this.lifecycle.cancel(tx, order, { actor: `admin:${admin.id}`, reason: "admin", requestId });
      await this.lifecycle.note(tx, order.id, `Cancelled by the store: ${dto.reason}`, admin.id, "internal");
      await tx.auditLog.create({ data: { actorId: admin.id, action: "order.cancel", target: order.id, meta: { reason: dto.reason } } });
    }, TX_OPTIONS);
    this.relay.kick();
    return this.adminGet(number, requestId);
  }

  async adminNote(admin: RequestUser, number: string, body: string) {
    const order = await this.prisma.order.findUnique({ where: { orderNumber: number } });
    if (!order) throw notFound();
    await this.prisma.$transaction(async (tx) => {
      await this.lifecycle.note(tx, order.id, body, admin.id, "internal");
      await tx.auditLog.create({ data: { actorId: admin.id, action: "order.note", target: order.id } });
    });
    return this.adminGet(number);
  }

  async exportCsv(query: AdminListQuery) {
    const rows = await this.prisma.order.findMany({
      where: this.adminWhere(query),
      include: withItems,
      orderBy: [{ placedAt: "desc" }, { id: "desc" }],
      take: 5000,
    });
    const header = ["order", "placed_at", "status", "payment", "name", "phone", "email", "city", "pincode", "items", "subtotal", "discount", "shipping", "gst", "total", "coupon"];
    const rupees = (p: number) => (p / 100).toFixed(2);
    const lines = rows.map((o) => {
      const a = o.shippingAddress as { city?: string; pincode?: string };
      return [
        o.orderNumber,
        o.placedAt.toISOString(),
        o.status,
        o.paymentMethod,
        o.contactName,
        o.contactPhone,
        o.contactEmail ?? "",
        a.city ?? "",
        a.pincode ?? "",
        o.items.map((i) => `${i.qty}x ${i.name} (${i.detail})`).join("; "),
        rupees(o.subtotalPaise),
        rupees(o.discountPaise),
        rupees(o.shippingPaise),
        rupees(o.taxPaise),
        rupees(o.totalPaise),
        o.couponCode ?? "",
      ];
    });
    return [header, ...lines].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }

  private adminWhere(q: AdminListQuery): Prisma.OrderWhereInput {
    const search = q.q?.trim();
    const digits = search?.replace(/\D/g, "");
    return {
      ...(q.status && { status: q.status }),
      ...(q.paymentMethod && { paymentMethod: q.paymentMethod }),
      ...(q.pincode && { shippingAddress: { path: "$.pincode", equals: q.pincode } }),
      ...((q.from || q.to) && { placedAt: { ...(q.from && { gte: new Date(q.from) }), ...(q.to && { lte: new Date(q.to) }) } }),
      ...(search && {
        OR: [
          { orderNumber: { startsWith: search.toUpperCase() } },
          { contactEmail: { contains: search.toLowerCase() } },
          { contactName: { contains: search } },
          ...(digits && digits.length >= 4 ? [{ contactPhone: { contains: digits } }] : []),
        ],
      }),
    };
  }
}

const changed = () => new AppError(409, "VERSION_CONFLICT", "This order was changed by someone else. Please refresh and try again.");

// Spreadsheet-safe: quotes, and no leading = + - @ that a spreadsheet would run as a formula.
function csvCell(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
