const FR_MONTHS = "janvier,février,mars,avril,mai,juin,juillet,août,septembre,octobre,novembre,décembre".split(",");
export type FrLongDate = { day: number; month: number; year: number };
const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const cal = (d: number, m: number, y: number): FrLongDate | null => { const max = DIM[m - 1];
  return !max || d < 1 || (d > max && !(m === 2 && d === 29 && y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) ? null : { day: d, month: m, year: y }; };
export const frLongDate = (label: string): FrLongDate | null => {
  const fr = label.toLowerCase().match(/(\d{1,2})(?:er)?\s+([a-z\u00E9\u00FB\u00F4\u00E0\u00E8]+)\s+(\d{4})/), month = FR_MONTHS.indexOf(fr?.[2] as string) + 1;
  if (month) return cal(Number(fr![1]), month, Number(fr![3]));
  const dmy = label.match(/(\d{1,2})[/.\s-](\d{1,2})[/.\s-](\d{4})/);
  if (dmy) {
    let [d, mo] = [Number(dmy[1]), Number(dmy[2])];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return cal(d, mo, Number(dmy[3]));
  }
  const ymd = label.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  return ymd ? cal(Number(ymd[3]), Number(ymd[2]), Number(ymd[1])) : null;
};
