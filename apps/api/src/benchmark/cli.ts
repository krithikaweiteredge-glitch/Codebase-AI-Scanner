/**
 * `npm run benchmark` - prints the detection report.
 *
 * Exits non-zero when a case that should be detected is missed, or when safe
 * code is reported, so CI notices a regression in either direction.
 */
import { formatReport, runBenchmark } from './run';

const report = runBenchmark();
// eslint-disable-next-line no-console
console.log(formatReport(report));

const regressed = report.totals.detected < report.totals.vulnerable || report.totals.falsePositives > 0;
process.exit(regressed ? 1 : 0);
