import { mad } from './money.js';

export interface ForexDifference {
  id: string;
  amount: number;
  currency: string;
}

export interface ForexInput {
  realized: Array<{ id: string; currency: string; foreignAmount: number; historicalRate: number; settlementRate: number }>;
  latent: Array<{ id: string; currency: string; foreignAmount: number; historicalRate: number; closingRate: number }>;
}

export interface ForexResult {
  realized: ForexDifference[];
  latent: ForexDifference[];
}

export function calculateForex(input: ForexInput): ForexResult {
  return {
    realized: input.realized.map((item) => ({
      id: item.id,
      amount: mad(Math.abs(item.foreignAmount * (item.settlementRate - item.historicalRate))),
      currency: item.currency,
    })),
    latent: input.latent.map((item) => ({
      id: item.id,
      amount: mad(Math.abs(item.foreignAmount * (item.closingRate - item.historicalRate))),
      currency: item.currency,
    })),
  };
}
