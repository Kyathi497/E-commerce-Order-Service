# events

Outbox, relay and inbox (plan §7, §8). Events go from producer to consumer over internal HTTP
(`POST /internal/events`), with no broker.

- **Publish** inside the same transaction as the change: `outbox.publish(tx, "product.updated", data)`.
  One `OutboxDelivery` row is written per consumer that subscribes to the event type.
- **Relay** (runs in every replica): claims due deliveries with `FOR UPDATE SKIP LOCKED` plus a lease, POSTs the
  envelope with a service token, and retries with backoff (default 10 s → 1 min → 10 min → 1 h, for about 24 h).
  After that the delivery is marked `failed` and logged at error level; an admin can replay it.
- **Inbox**: `POST /internal/events` records the event ID in `ProcessedEvent` in the same transaction as the
  handler, so a repeated delivery does nothing. Unknown event types are accepted and ignored.
- **Admin**: `GET <adminPath>/deliveries?status=failed` and `POST <adminPath>/:eventId/retry`.

Copy these models into `prisma/schema.prisma` (the inbox table only if the service consumes events):

```prisma
enum DeliveryStatus {
  pending
  delivered
  failed
}

// Transactional outbox (§8), written in the same transaction as the change it describes.
model OutboxEvent {
  id            String   @id @db.Char(36)
  type          String   @db.VarChar(64)
  version       Int
  payload       Json
  correlationId String?  @db.VarChar(128)
  createdAt     DateTime @default(now()) @db.DateTime(3)

  deliveries OutboxDelivery[]

  @@index([createdAt])
}

// One row per consumer, so a slow or broken consumer never holds up the others.
model OutboxDelivery {
  eventId       String         @db.Char(36)
  consumer      String         @db.VarChar(64)
  status        DeliveryStatus @default(pending)
  attempts      Int            @default(0)
  nextAttemptAt DateTime       @default(now()) @db.DateTime(3)
  lastError     String?        @db.VarChar(500)
  deliveredAt   DateTime?      @db.DateTime(3)

  event OutboxEvent @relation(fields: [eventId], references: [id], onDelete: Cascade)

  @@id([eventId, consumer])
  @@index([status, nextAttemptAt])
}

// Inbox: events this service has already handled.
model ProcessedEvent {
  eventId     String   @id @db.Char(36)
  type        String   @db.VarChar(64)
  processedAt DateTime @default(now()) @db.DateTime(3)
}
```

If you fix a bug here, make the same fix in every other service that has a copy.
