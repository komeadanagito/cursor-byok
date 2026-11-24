const integerFormatter = new Intl.NumberFormat("en-US");

const compactUnits = [
  { value: 1_000_000_000_000, suffix: "T" },
  { value: 1_000_000_000, suffix: "B" },
  { value: 1_000_000, suffix: "M" },
  { value: 1_000, suffix: "K" },
] as const;

function normalizeInteger(value: number) {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function trimTrailingZeros(value: string) {
  return value.replace(/\.0$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

export function formatInteger(value: number) {
  return integerFormatter.format(normalizeInteger(value));
}

export function formatCompactInteger(value: number) {
  const number = normalizeInteger(value);
  const unit = compactUnits.find(({ value: threshold }) => Math.abs(number) >= threshold);
  if (!unit) return formatInteger(number);

  const scaled = number / unit.value;
  const fractionDigits = Math.abs(scaled) < 100 ? 1 : 0;
  return `${trimTrailingZeros(scaled.toFixed(fractionDigits))}${unit.suffix}`;
}

const moneyFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Sub-cent spend is common for cheap models; two decimals would show it as $0.00.
export function formatMoney(currency: string, amount: number) {
  const symbol = currency === "CNY" ? "¥" : "$";
  if (amount > 0 && amount < 0.01) {
    const digits = Math.min(8, 1 - Math.floor(Math.log10(amount)));
    return `${symbol}${amount.toFixed(digits).replace(/0+$/, "")}`;
  }
  return `${symbol}${moneyFormatter.format(amount)}`;
}
