// ₹1,234.50 from 123450 paise, Indian digit grouping.
export function formatINR(paise: number) {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}
