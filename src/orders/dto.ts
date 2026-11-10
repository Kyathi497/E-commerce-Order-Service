import { Transform, Type } from "class-transformer";
import {
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { STATUSES, type Status } from "./states.js";

const trim = () => Transform(({ value }) => (typeof value === "string" ? value.trim() : value));
// "+91 98765-43210" → "9876543210"
const phone = () =>
  Transform(({ value }) => (typeof value === "string" ? value.replace(/[\s-]/g, "").replace(/^(\+?91)(?=\d{10}$)/, "") : value));
const PHONE = /^[6-9]\d{9}$/;
const PHONE_MESSAGE = "Enter a 10-digit Indian mobile number.";
const PINCODE = /^[1-9]\d{5}$/;

export class AddressDto {
  @trim() @IsString() @Length(2, 80, { message: "Enter your full name." }) name: string;
  @phone() @Matches(PHONE, { message: PHONE_MESSAGE }) phone: string;
  @trim() @IsString() @Length(8, 200, { message: "Enter house number, street and area." }) line1: string;
  @IsOptional() @trim() @IsString() @MaxLength(120) line2?: string;
  @IsOptional() @trim() @IsString() @MaxLength(80) landmark?: string;
  @trim() @IsString() @Length(2, 60, { message: "Enter your city or town." }) city: string;
  @trim() @IsString() @Length(2, 60, { message: "Choose your state." }) state: string;
  @trim() @Matches(PINCODE, { message: "Enter a 6-digit PIN code." }) pincode: string;
}

// POST /checkout (§6.7). The cart comes from cart-service, never from here:
// the browser only says where to deliver, how to pay, and the total it showed.
export class CheckoutDto {
  // A saved address (signed-in shoppers) or a typed one.
  @ValidateIf((o) => o.address === undefined) @IsUUID("all", { message: "Choose a delivery address." }) addressId?: string;
  @ValidateIf((o) => o.addressId === undefined) @ValidateNested() @Type(() => AddressDto) address?: AddressDto;
  // Guests must give one, for the confirmation and invoice (§17 question 2).
  @IsOptional() @trim() @IsEmail({}, { message: "Check the email address." }) @MaxLength(254) email?: string;
  @IsIn(["prepaid", "cod"], { message: "Choose how you'd like to pay." }) paymentMethod: "prepaid" | "cod";
  // The total on the shopper's screen; anything else and checkout stops (§10).
  @IsInt() @Min(0) expectedTotalPaise: number;
  @IsOptional() @trim() @IsString() @MaxLength(300) note?: string;
}

export class TrackDto {
  @trim() @Transform(({ value }) => (typeof value === "string" ? value.toUpperCase() : value))
  @Matches(/^TEJ-\d{2}-\d{6,}$/, { message: "Enter the order number from your confirmation, e.g. TEJ-26-000123." })
  orderNumber: string;
  @phone() @Matches(PHONE, { message: PHONE_MESSAGE }) phone: string;
}

export class CancelDto {
  @IsOptional() @trim() @IsString() @MaxLength(300) reason?: string;
}

export class ListOrdersQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
  @IsOptional() @IsString() @MaxLength(200) cursor?: string;
}

export class ViewQuery {
  // Guest link token (see ids.ts).
  @IsOptional() @IsString() @MaxLength(80) t?: string;
}

export class AdminListQuery {
  @IsOptional() @IsIn(STATUSES) status?: Status;
  @IsOptional() @IsIn(["prepaid", "cod"]) paymentMethod?: "prepaid" | "cod";
  // Order number, email, phone or name.
  @IsOptional() @trim() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Matches(PINCODE, { message: "Enter a 6-digit PIN code." }) pincode?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(200) cursor?: string;
}

export class AdminStatusDto {
  @IsIn(STATUSES) status: Status;
  @IsOptional() @trim() @IsString() @MaxLength(300) reason?: string;
  // Optimistic concurrency (§9): the version the admin was looking at.
  @IsInt() @Min(1) version: number;
}

export class AdminCancelDto {
  @trim() @IsString() @Length(3, 300, { message: "Say why, in a few words." }) reason: string;
  @IsInt() @Min(1) version: number;
}

export class AdminNoteDto {
  @trim() @IsString() @Length(1, 1000) body: string;
}
