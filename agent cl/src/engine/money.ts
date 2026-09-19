export const cents = (value: number): number => Math.round(value * 100);
export const mad = (value: number): number => cents(value) / 100;

export function sum(values: number[]): number {
  return mad(values.reduce((total, value) => total + cents(value), 0) / 100);
}
