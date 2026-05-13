// 'rc://*/ta/man/translate/figs-explicit' -> 'figs-explicit'
// Falls back to the input when no path segment is present.
export function shortSupport(s: string): string {
  const m = s.match(/\/([^/]+)$/);
  return m ? m[1] : s;
}
