import type { Rules } from './types.js';

export const DEFAULT_RULES: Rules = {
  qty: {
    coverMonthsHigh: 4,
    stockDaysMin: 30,
    coverMonthsLow: 0.5,
  },
  price: {
    highPct: 0.15,
    midPct: 0.05,
    minSamples: 3,
    staleMonths: 18,
  },
  time: {
    defaultWindowDays: 30,
  },
  stockStaleDays: 7,
};
