import { Module } from "@nestjs/common";
import { config, SERVICE_NAME } from "./config.js";
import { CONSUMERS, ROUTES } from "./events.js";
import { AuthGuardModule } from "./lib/auth-guard/index.js";
import { HealthModule } from "./lib/common/index.js";
import { EventsModule, Outbox } from "./lib/events/index.js";
import { logger } from "./logger.js";
import { CheckoutService } from "./orders/checkout.service.js";
import { orderHandlers } from "./orders/handlers.js";
import { Lifecycle } from "./orders/lifecycle.js";
import { AdminOrdersController, CheckoutController, OrdersController } from "./orders/orders.controller.js";
import { OrdersService } from "./orders/orders.service.js";
import { OrderSweeper } from "./orders/sweeper.js";
import { Upstream } from "./orders/upstream.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { PrismaService } from "./prisma/prisma.service.js";

@Module({
  imports: [
    PrismaModule,
    AuthGuardModule.forRoot({
      jwksUrl: config.AUTH_JWKS_URL,
      service: { name: SERVICE_NAME, secret: config.SERVICE_TOKEN_SECRET },
    }),
    HealthModule.register({
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => ({ db: () => prisma.$queryRaw`SELECT 1` }),
    }),
    EventsModule.forRootAsync({
      adminPath: "admin/events/order",
      receive: true,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => {
        const options = {
          db: prisma,
          logger,
          source: SERVICE_NAME,
          consumers: CONSUMERS,
          routes: ROUTES,
          serviceTokenSecret: config.SERVICE_TOKEN_SECRET,
          retryDelaysSeconds: config.EVENT_RETRY_DELAYS.map(Number).filter((n) => n > 0),
        };
        // The handlers publish through the same outbox they run beside.
        return { ...options, handlers: orderHandlers(new Lifecycle(new Outbox(options)), new Upstream()) };
      },
    }),
  ],
  controllers: [CheckoutController, OrdersController, AdminOrdersController],
  providers: [Upstream, Lifecycle, CheckoutService, OrdersService, OrderSweeper],
})
export class AppModule {}
