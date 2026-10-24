const FR_MONTHS = "janvier,février,mars,avril,mai,juin,juillet,août,septembre,octobre,novembre,décembre".split(",");
export type FrLongDate = { day: number; month: number; year: number };
const cal = (d: number, m: number, y: number): FrLongDate | null => (d >= 1 && d <= 31 && m >= 1 && m <= 12 ? { day: d, month: m, year: y } : null);
export const frLongDate = (label: string): FrLongDate | null => {
  const m = label.toLowerCase().match(/(\d{1,2})\s+([a-z\u00E9\u00FB\u00F4\u00E0\u00E8]+)\s+(\d{4})/);
  const month = m ? FR_MONTHS.indexOf(m[2] ?? "") + 1 : 0;
  if (m && month) return { day: Number(m[1]), month, year: Number(m[3]) };
  const dmy = label.match(/(\d{1,2})[/.\s-](\d{1,2})[/.\s-](\d{4})/);
  if (dmy) {
    let [d, mo] = [Number(dmy[1]), Number(dmy[2])];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return cal(d, mo, Number(dmy[3]));
  }
  const ymd = label.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  return ymd ? cal(Number(ymd[3]), Number(ymd[2]), Number(ymd[1])) : null;
};
