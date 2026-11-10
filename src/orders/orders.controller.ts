import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { CurrentUser, Public, readCookie, Roles, unauthenticated } from "../lib/auth-guard/index.js";
import type { RequestUser } from "../lib/common/index.js";
import { CheckoutService, type Who } from "./checkout.service.js";
import { AdminCancelDto, AdminListQuery, AdminNoteDto, AdminStatusDto, CancelDto, CheckoutDto, ListOrdersQuery, TrackDto, ViewQuery } from "./dto.js";
import { OrdersService } from "./orders.service.js";

// cart-service's guest cart cookie (Path=/, so it reaches this service too).
const CART_COOKIE = "tej_cart";

// The 15-minute access cookie can expire in the browser while the store
// still believes the shopper is signed in. It marks such calls; answering
// 401 makes it renew the session and retry, instead of checking out a guest.
function who(req: Request): Who {
  if (!req.user && req.header("x-signed-in") === "1") throw unauthenticated();
  const token = readCookie(req.headers.cookie, CART_COOKIE);
  return { user: req.user, cartToken: token && /^[A-Za-z0-9_-]{22}$/.test(token) ? token : undefined };
}

@Public()
@Controller("checkout")
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  // POST /checkout with an Idempotency-Key header (§6.7, §9).
  @Post()
  @Header("Cache-Control", "private, no-store")
  place(@Req() req: Request, @Body() dto: CheckoutDto) {
    return this.checkout.checkout(who(req), req.header("idempotency-key"), dto, req.requestId);
  }
}

@Controller("orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  list(@CurrentUser() user: RequestUser, @Query() query: ListOrdersQuery) {
    return this.orders.list(user.id, query.limit, query.cursor);
  }

  // Guests track with the order number and phone; rate-limited at the gateway.
  @Public()
  @Post("track")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  track(@Body() dto: TrackDto) {
    return this.orders.track(dto);
  }

  // The owner, or a guest with the signed link from checkout (?t=…).
  @Public()
  @Get(":number")
  @Header("Cache-Control", "private, no-store")
  get(@Req() req: Request, @Param("number") number: string, @Query() query: ViewQuery) {
    return this.orders.get(number, { user: req.user, token: query.t });
  }

  @Public()
  @Post(":number/cancel")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  cancel(@Req() req: Request, @Param("number") number: string, @Query() query: ViewQuery, @Body() dto: CancelDto) {
    return this.orders.cancel(number, { user: req.user, token: query.t }, dto.reason, req.requestId);
  }
}

// Checked here as well as at the gateway (§10).
@Roles("admin")
@Controller("admin/orders")
export class AdminOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@Query() query: AdminListQuery) {
    return this.orders.adminList(query);
  }

  @Get("export.csv")
  async export(@Query() query: AdminListQuery, @Res() res: Response) {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="tej-orders-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(await this.orders.exportCsv(query));
  }

  @Get(":number")
  get(@Req() req: Request, @Param("number") number: string) {
    return this.orders.adminGet(number, req.requestId);
  }

  @Post(":number/status")
  @HttpCode(200)
  setStatus(@CurrentUser() user: RequestUser, @Req() req: Request, @Param("number") number: string, @Body() dto: AdminStatusDto) {
    return this.orders.adminSetStatus(user, number, dto, req.requestId);
  }

  @Post(":number/cancel")
  @HttpCode(200)
  cancel(@CurrentUser() user: RequestUser, @Req() req: Request, @Param("number") number: string, @Body() dto: AdminCancelDto) {
    return this.orders.adminCancel(user, number, dto, req.requestId);
  }

  @Post(":number/notes")
  note(@CurrentUser() user: RequestUser, @Param("number") number: string, @Body() dto: AdminNoteDto) {
    return this.orders.adminNote(user, number, dto.body);
  }
}
