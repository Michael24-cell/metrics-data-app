/**
 * Series summary — Peak / Average / Most recent for one athlete's metric
 * series within a selected window. Shared by any preview that needs these
 * three numbers so they're computed once, consistently, rather than
 * re-derived ad hoc in React.
 *
 * Contract:
 *  - Peak = highest valid value in the series (the series already reflects
 *    the selected metric + time window; nothing is filtered again here).
 *  - Average = arithmetic mean of the valid values.
 *  - Most recent = the last point BY DATE. Callers must pass points in
 *    chronological (ascending) order — sessionBestSeries() already does.
 */

export interface SeriesPoint {
  date: string;
  value: number;
}

export interface SeriesSummary {
  n: number;
  peak: number | null;
  average: number | null;
  mostRecent: number | null;
  mostRecentDate: string | null;
}

export function summarizeSeries(points: SeriesPoint[]): SeriesSummary {
  if (points.length === 0) {
    return { n: 0, peak: null, average: null, mostRecent: null, mostRecentDate: null };
  }
  const values = points.map((p) => p.value);
  const last = points[points.length - 1];
  return {
    n: points.length,
    peak: Math.max(...values),
    average: values.reduce((a, b) => a + b, 0) / values.length,
    mostRecent: last.value,
    mostRecentDate: last.date,
  };
}
