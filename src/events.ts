import { config } from "./config.js";
import type { EventType } from "./lib/contracts/index.js";

// Who receives order events (§8). Consumer names are also the service-token
// audience. Notification and shipping arrive in phase 5: until their URLs
// are set, their copies aren't recorded.
export const CONSUMERS = {
  "inventory-service": config.INVENTORY_EVENTS_URL,
  "promotion-service": config.PROMOTION_EVENTS_URL,
  "payment-service": config.PAYMENT_EVENTS_URL,
  "notification-service": config.NOTIFICATION_EVENTS_URL,
  "shipping-service": config.SHIPPING_EVENTS_URL,
};

export const ROUTES: Partial<Record<EventType, (keyof typeof CONSUMERS)[]>> = {
  "order.created": [],
  "order.confirmed": ["inventory-service", "promotion-service", "payment-service", "notification-service", "shipping-service"],
  "order.cancelled": ["inventory-service", "promotion-service", "payment-service", "notification-service"],
  "order.status_changed": ["notification-service", "shipping-service"],
};
