import { envList, loadConfig, nodeEnv } from "./lib/common/index.js";
import { z } from "zod";

// Dev-only defaults so services agree out of the box; production must set its own.
const DEV_SERVICE_TOKEN_SECRET = "dev-only-service-token-secret-change-me-in-production";
const DEV_ORDER_LINK_SECRET = "dev-only-order-link-secret-change-me-in-production";

const schema = z
  .object({
    NODE_ENV: nodeEnv,
    PORT: z.coerce.number().int().default(4006),

    DB_HOST: z.string().default("localhost"),
    DB_PORT: z.coerce.number().int().default(3306),
    MYSQL_USER: z.string().min(1),
    MYSQL_PASSWORD: z.string().min(1),
    MYSQL_DATABASE: z.string().min(1),

    // auth-service's public keys, for knowing which shopper is signed in.
    AUTH_JWKS_URL: z.url().default("http://localhost:4001/internal/.well-known/jwks.json"),
    // Shared by every service for service-to-service tokens (§7). At least 32 characters.
    SERVICE_TOKEN_SECRET: z.string().min(32).default(DEV_SERVICE_TOKEN_SECRET),
    // Signs the links that let a guest see their own order (§6.7). At least 32 characters.
    ORDER_LINK_SECRET: z.string().min(32).default(DEV_ORDER_LINK_SECRET),
    ORDER_LINK_DAYS: z.coerce.number().int().positive().default(30),

    // The checkout saga's dependencies (§6.7).
    AUTH_URL: z.url().default("http://localhost:4001"),
    CART_URL: z.url().default("http://localhost:4004"),
    CATALOG_URL: z.url().default("http://localhost:4002"),
    INVENTORY_URL: z.url().default("http://localhost:4003"),
    PROMOTION_URL: z.url().default("http://localhost:4005"),
    SHIPPING_URL: z.url().default("http://localhost:4008"),
    PAYMENT_URL: z.url().default("http://localhost:4007"),
    // Shipping charged when shipping-service can't be reached (§7). Today's flat ₹70.
    FALLBACK_SHIPPING_PAISE: z.coerce.number().int().min(0).default(7000),

    // Cash on delivery (§17 question 1): order limit and open COD orders per phone.
    COD_ENABLED: z.enum(["true", "false"]).default("true"),
    COD_MAX_PAISE: z.coerce.number().int().min(0).default(200_000),
    COD_MAX_OPEN_PER_PHONE: z.coerce.number().int().min(1).default(1),

    // GSTIN 37BJEPK2125A1ZU is registered in Andhra Pradesh (§6.7).
    STORE_STATE_CODE: z.string().regex(/^\d{2}$/).default("37"),

    // Orders still waiting for payment this long after checkout are cancelled,
    // in case inventory's reservation.expired never arrives (§6.7).
    PENDING_TIMEOUT_MINUTES: z.coerce.number().int().min(16).default(60),
    SWEEP_SECONDS: z.coerce.number().int().positive().default(10),

    // Who receives order events (§8). Empty = that consumer isn't running yet.
    INVENTORY_EVENTS_URL: z.url().optional(),
    PROMOTION_EVENTS_URL: z.url().optional(),
    PAYMENT_EVENTS_URL: z.url().optional(),
    NOTIFICATION_EVENTS_URL: z.url().optional(),
    SHIPPING_EVENTS_URL: z.url().optional(),
    // Seconds between delivery attempts, e.g. "2,5,10" in development.
    EVENT_RETRY_DELAYS: envList([]),
  })
  .refine((c) => c.NODE_ENV !== "production" || c.SERVICE_TOKEN_SECRET !== DEV_SERVICE_TOKEN_SECRET, {
    message: "SERVICE_TOKEN_SECRET must be set in production",
    path: ["SERVICE_TOKEN_SECRET"],
  })
  .refine((c) => c.NODE_ENV !== "production" || c.ORDER_LINK_SECRET !== DEV_ORDER_LINK_SECRET, {
    message: "ORDER_LINK_SECRET must be set in production",
    path: ["ORDER_LINK_SECRET"],
  });

export const config = loadConfig(schema);
export type Config = typeof config;

export const SERVICE_NAME = "order-service";
export const codEnabled = config.COD_ENABLED === "true";
