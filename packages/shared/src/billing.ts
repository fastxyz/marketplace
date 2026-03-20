import { decimalToRawString, rawToDecimalString } from "./amounts.js";
import type {
  CreateProviderEndpointDraftInput,
  FixedX402Billing,
  FreeBilling,
  MarketplaceRoute,
  PrepaidCreditBilling,
  RouteBilling,
  RouteBillingType,
  TopupX402VariableBilling
} from "./types.js";

function parseTopupRequestAmount(input: unknown): string {
  if (!input || typeof input !== "object") {
    throw new Error("Top-up routes require a JSON object body.");
  }

  const amount = (input as Record<string, unknown>).amount;
  if (typeof amount !== "string" || amount.trim().length === 0) {
    throw new Error('Top-up routes require an "amount" string in the request body.');
  }

  return amount.trim();
}

function quotedFixedPrice(billing: FixedX402Billing): string {
  return billing.price;
}

function quotedTopupPrice(billing: TopupX402VariableBilling, input: unknown): string {
  const amount = parseTopupRequestAmount(input);
  const rawAmount = decimalToRawString(amount, 6);
  const minimum = BigInt(decimalToRawString(billing.minAmount, 6));
  const maximum = BigInt(decimalToRawString(billing.maxAmount, 6));
  const nextAmount = BigInt(rawAmount);

  if (nextAmount < minimum) {
    throw new Error(`Top-up amount must be at least ${billing.minAmount}.`);
  }

  if (nextAmount > maximum) {
    throw new Error(`Top-up amount must be at most ${billing.maxAmount}.`);
  }

  return `$${rawToDecimalString(rawAmount, 6)}`;
}

export function isFixedX402Billing(route: MarketplaceRoute | { billing: { type: string } }): route is MarketplaceRoute & {
  billing: FixedX402Billing;
} {
  return route.billing.type === "fixed_x402";
}

export function isTopupX402Billing(route: MarketplaceRoute | { billing: { type: string } }): route is MarketplaceRoute & {
  billing: TopupX402VariableBilling;
} {
  return route.billing.type === "topup_x402_variable";
}

export function isPrepaidCreditBilling(route: MarketplaceRoute | { billing: { type: string } }): route is MarketplaceRoute & {
  billing: PrepaidCreditBilling;
} {
  return route.billing.type === "prepaid_credit";
}

export function isFreeBilling(route: MarketplaceRoute | { billing: { type: string } }): route is MarketplaceRoute & {
  billing: FreeBilling;
} {
  return route.billing.type === "free";
}

export function requiresWalletSession(route: MarketplaceRoute): boolean {
  return isPrepaidCreditBilling(route);
}

export function requiresX402Payment(route: MarketplaceRoute): boolean {
  return isFixedX402Billing(route) || isTopupX402Billing(route);
}

export function quotedPriceString(route: MarketplaceRoute, input?: unknown): string {
  if (isFixedX402Billing(route)) {
    return quotedFixedPrice(route.billing);
  }

  if (isTopupX402Billing(route)) {
    return quotedTopupPrice(route.billing, input);
  }

  throw new Error(`Route ${route.routeId} does not use x402 pricing.`);
}

export function quotedPriceRaw(route: MarketplaceRoute, input?: unknown): string {
  return decimalToRawString(quotedPriceString(route, input).replace(/^\$/, ""), 6);
}

export function routePriceLabel(route: MarketplaceRoute): string {
  if (route.price) {
    return route.price;
  }

  if (isFixedX402Billing(route)) {
    return route.billing.price;
  }

  if (isTopupX402Billing(route)) {
    return `$${route.billing.minAmount} - $${route.billing.maxAmount}`;
  }

  if (isFreeBilling(route)) {
    return "Free";
  }

  return "Prepaid credit";
}

export function topupAmountFromBody(route: MarketplaceRoute, input: unknown): string {
  if (!isTopupX402Billing(route)) {
    throw new Error(`Route ${route.routeId} is not a top-up route.`);
  }

  return rawToDecimalString(quotedPriceRaw(route, input), 6);
}

export function normalizeRouteBilling(price: string, billing?: RouteBilling | null): RouteBilling {
  return billing ?? {
    type: "fixed_x402",
    price
  };
}

export function buildRouteBilling(input: {
  billingType: RouteBillingType;
  price?: string | null;
  minAmount?: string | null;
  maxAmount?: string | null;
}): RouteBilling {
  if (input.billingType === "fixed_x402") {
    if (!input.price) {
      throw new Error("Fixed-price routes require a price.");
    }
    return {
      type: "fixed_x402",
      price: input.price
    };
  }

  if (input.billingType === "topup_x402_variable") {
    if (!input.minAmount || !input.maxAmount) {
      throw new Error("Variable top-up routes require minAmount and maxAmount.");
    }
    return {
      type: "topup_x402_variable",
      minAmount: input.minAmount,
      maxAmount: input.maxAmount
    };
  }

  if (input.billingType === "free") {
    return {
      type: "free"
    };
  }

  return {
    type: "prepaid_credit"
  };
}

export function priceLabelForBilling(billing: RouteBilling): string {
  if (billing.type === "fixed_x402") {
    return billing.price;
  }

  if (billing.type === "topup_x402_variable") {
    return `$${billing.minAmount} - $${billing.maxAmount}`;
  }

  if (billing.type === "free") {
    return "Free";
  }

  return "Prepaid credit";
}

export function createDraftRouteBilling(input: Pick<CreateProviderEndpointDraftInput, "billingType" | "price" | "minAmount" | "maxAmount">): {
  billing: RouteBilling;
  price: string;
} {
  const billing = buildRouteBilling(input);
  return {
    billing,
    price: priceLabelForBilling(billing)
  };
}
