-- CreateTable
CREATE TABLE `Order` (
    `id` CHAR(36) NOT NULL,
    `orderNumber` VARCHAR(20) NOT NULL,
    `userId` VARCHAR(64) NULL,
    `contactName` VARCHAR(80) NOT NULL,
    `contactEmail` VARCHAR(254) NULL,
    `contactPhone` VARCHAR(15) NOT NULL,
    `status` ENUM('PENDING_PAYMENT', 'CONFIRMED', 'PREPARING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'REFUND_PENDING', 'REFUNDED', 'RETURN_REQUESTED', 'RETURNED', 'RTO') NOT NULL DEFAULT 'PENDING_PAYMENT',
    `paymentMethod` ENUM('prepaid', 'cod') NOT NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'INR',
    `subtotalPaise` INTEGER NOT NULL,
    `discountPaise` INTEGER NOT NULL,
    `shippingPaise` INTEGER NOT NULL,
    `shippingDiscountPaise` INTEGER NOT NULL DEFAULT 0,
    `taxPaise` INTEGER NOT NULL,
    `totalPaise` INTEGER NOT NULL,
    `taxBreakup` JSON NOT NULL,
    `placeOfSupply` CHAR(2) NOT NULL,
    `couponCode` VARCHAR(40) NULL,
    `shippingAddress` JSON NOT NULL,
    `billingAddress` JSON NOT NULL,
    `reservationKey` VARCHAR(64) NOT NULL,
    `idempotencyKey` CHAR(64) NOT NULL,
    `cartId` VARCHAR(64) NULL,
    `cartCleared` BOOLEAN NOT NULL DEFAULT false,
    `paymentId` CHAR(36) NULL,
    `customerNote` VARCHAR(300) NULL,
    `placedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `confirmedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelReason` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    UNIQUE INDEX `Order_orderNumber_key`(`orderNumber`),
    UNIQUE INDEX `Order_reservationKey_key`(`reservationKey`),
    UNIQUE INDEX `Order_idempotencyKey_key`(`idempotencyKey`),
    INDEX `Order_userId_placedAt_idx`(`userId`, `placedAt`),
    INDEX `Order_status_placedAt_idx`(`status`, `placedAt`),
    INDEX `Order_placedAt_idx`(`placedAt`),
    INDEX `Order_contactPhone_paymentMethod_status_idx`(`contactPhone`, `paymentMethod`, `status`),
    INDEX `Order_contactEmail_idx`(`contactEmail`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderItem` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` CHAR(36) NOT NULL,
    `kind` ENUM('sku', 'bundle') NOT NULL,
    `ref` VARCHAR(80) NOT NULL,
    `refId` VARCHAR(64) NULL,
    `name` VARCHAR(160) NOT NULL,
    `detail` VARCHAR(80) NOT NULL,
    `hsnCode` VARCHAR(8) NULL,
    `gstRateBp` INTEGER NOT NULL,
    `unitPaise` INTEGER NOT NULL,
    `mrpPaise` INTEGER NOT NULL,
    `qty` INTEGER NOT NULL,
    `discountPaise` INTEGER NOT NULL,
    `lineTotalPaise` INTEGER NOT NULL,
    `taxPaise` INTEGER NOT NULL,
    `components` JSON NOT NULL,
    `position` INTEGER NOT NULL,

    INDEX `OrderItem_orderId_idx`(`orderId`),
    INDEX `OrderItem_refId_idx`(`refId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderStatusHistory` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` CHAR(36) NOT NULL,
    `fromStatus` ENUM('PENDING_PAYMENT', 'CONFIRMED', 'PREPARING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'REFUND_PENDING', 'REFUNDED', 'RETURN_REQUESTED', 'RETURNED', 'RTO') NULL,
    `toStatus` ENUM('PENDING_PAYMENT', 'CONFIRMED', 'PREPARING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'REFUND_PENDING', 'REFUNDED', 'RETURN_REQUESTED', 'RETURNED', 'RTO') NOT NULL,
    `actor` VARCHAR(80) NOT NULL,
    `reason` VARCHAR(300) NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OrderStatusHistory_orderId_at_idx`(`orderId`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderNote` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` CHAR(36) NOT NULL,
    `kind` ENUM('internal', 'system') NOT NULL,
    `actorId` VARCHAR(64) NULL,
    `body` VARCHAR(1000) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OrderNote_orderId_at_idx`(`orderId`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderCounter` (
    `year` INTEGER NOT NULL,
    `last` INTEGER NOT NULL,

    PRIMARY KEY (`year`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditLog` (
    `id` VARCHAR(191) NOT NULL,
    `actorId` VARCHAR(191) NULL,
    `action` VARCHAR(64) NOT NULL,
    `target` VARCHAR(191) NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `meta` JSON NULL,

    INDEX `AuditLog_target_idx`(`target`),
    INDEX `AuditLog_at_idx`(`at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OutboxEvent` (
    `id` CHAR(36) NOT NULL,
    `type` VARCHAR(64) NOT NULL,
    `version` INTEGER NOT NULL,
    `payload` JSON NOT NULL,
    `correlationId` VARCHAR(128) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OutboxEvent_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OutboxDelivery` (
    `eventId` CHAR(36) NOT NULL,
    `consumer` VARCHAR(64) NOT NULL,
    `status` ENUM('pending', 'delivered', 'failed') NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastError` VARCHAR(500) NULL,
    `deliveredAt` DATETIME(3) NULL,

    INDEX `OutboxDelivery_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    PRIMARY KEY (`eventId`, `consumer`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProcessedEvent` (
    `eventId` CHAR(36) NOT NULL,
    `type` VARCHAR(64) NOT NULL,
    `processedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`eventId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `OrderItem` ADD CONSTRAINT `OrderItem_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderStatusHistory` ADD CONSTRAINT `OrderStatusHistory_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderNote` ADD CONSTRAINT `OrderNote_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OutboxDelivery` ADD CONSTRAINT `OutboxDelivery_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `OutboxEvent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
