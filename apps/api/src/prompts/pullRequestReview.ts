import { z } from 'zod';
import { GROUNDING_RULES, SEVERITY, contextBlock } from './shared';

export const prReviewSchema = z.object({
  verdict: z.enum(['approve', 'comment', 'request_changes']),
  summary: z.string().min(20).max(4000),
  breakingChanges: z.array(z.string().max(400)).max(10),
  testGaps: z.array(z.string().max(400)).max(15),
  findings: z
    .array(
      z.object({
        category: z.enum(['security', 'bug', 'performance', 'quality', 'test']),
        type: z.string().min(1).max(80),
        title: z.string().min(3).max(160),
        description: z.string().min(10).max(2000),
        filePath: z.string().min(1),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive().optional(),
        severity: SEVERITY,
        confidence: z.number().min(0).max(1),
        evidence: z.string().min(3).max(1200),
        recommendation: z.string().min(3).max(1500),
      }),
    )
    .max(40),
});

export type PullRequestReviewPayload = z.infer<typeof prReviewSchema>;

export const PR_REVIEW_SYSTEM_PROMPT = `You are reviewing a pull request as an experienced maintainer of this repository.

${GROUNDING_RULES}

REVIEW SCOPE - judge the change, not the whole codebase:
- Correctness of the new/changed logic, including edge cases the diff introduces.
- Security impact of the change (new inputs, new sinks, new endpoints, changed auth).
- Performance impact (new queries in loops, new unbounded reads, new render work).
- Architecture fit: does the change respect the layering and conventions visible in the surrounding code?
- Tests: does the diff need tests it does not have? Name the specific untested behaviour.
- Breaking changes: changed signatures, response shapes, database columns, config contracts.

RULES:
- Every finding must point at a line that the diff actually touches (lines marked + in the patch) or at code the diff directly breaks.
- Do not restate what the PR does as a finding. Do not raise style nits.
- Only report a test gap you can justify from the changed behaviour.
- The verdict is "request_changes" only if there is at least one high/critical finding or a clear correctness break; "approve" only if there is nothing above low severity.

Return JSON: {"verdict","summary","breakingChanges":[],"testGaps":[],"findings":[...]}. The summary is markdown, at most ~200 words.`;

export interface PRReviewPromptInput {
  repositoryName: string;
  prNumber: number;
  title: string;
  body: string;
  overview: string;
  diff: string;
  relatedContext: string;
  existingTests: string;
}

export function buildPRReviewPrompt(input: PRReviewPromptInput): string {
  return [
    `Repository: ${input.repositoryName}`,
    `Pull request #${input.prNumber}: ${input.title}`,
    contextBlock('PR DESCRIPTION', input.body || '(no description provided)'),
    contextBlock('REPOSITORY OVERVIEW', input.overview),
    contextBlock('DIFF (unified patch; only + lines are new)', input.diff),
    contextBlock('RELATED CODE FROM THE INDEXED BRANCH (context around the change)', input.relatedContext || '(none retrieved)'),
    contextBlock('EXISTING TESTS TOUCHING THIS AREA', input.existingTests || '(none found)'),
    'Review this pull request and return the JSON object described in the system prompt.',
  ].join('\n\n');
}

/** Markdown rendered for the optional GitHub comment. */
export function renderReviewMarkdown(review: PullRequestReviewPayload, repoLabel: string): string {
  const bySeverity = (s: string) => review.findings.filter((f) => f.severity === s).length;
  const lines: string[] = [];

  lines.push('## AI code review');
  lines.push('');
  lines.push(
    `**Verdict:** ${review.verdict === 'request_changes' ? 'Changes requested' : review.verdict === 'approve' ? 'Looks good' : 'Comments'}`,
  );
  lines.push('');
  lines.push(
    `Critical ${bySeverity('critical')} · High ${bySeverity('high')} · Medium ${bySeverity('medium')} · Low ${bySeverity('low')}`,
  );
  lines.push('');
  lines.push(review.summary);

  if (review.findings.length) {
    lines.push('');
    lines.push('### Findings');
    for (const finding of review.findings) {
      lines.push('');
      lines.push(
        `**${finding.severity.toUpperCase()} · ${finding.category}** — ${finding.title}  \n` +
          `\`${finding.filePath}:${finding.startLine}${finding.endLine && finding.endLine !== finding.startLine ? `-${finding.endLine}` : ''}\` ` +
          `(confidence ${Math.round(finding.confidence * 100)}%)`,
      );
      lines.push('');
      lines.push(finding.description);
      lines.push('');
      lines.push(`_Evidence:_ ${finding.evidence}`);
      lines.push('');
      lines.push(`_Suggested fix:_ ${finding.recommendation}`);
    }
  }

  if (review.testGaps.length) {
    lines.push('');
    lines.push('### Test gaps');
    for (const gap of review.testGaps) lines.push(`- ${gap}`);
  }

  if (review.breakingChanges.length) {
    lines.push('');
    lines.push('### Possible breaking changes');
    for (const change of review.breakingChanges) lines.push(`- ${change}`);
  }

  lines.push('');
  lines.push('---');
  lines.push(
    `Generated by the internal Codebase Intelligence platform for ${repoLabel}. ` +
      'AI-generated findings are recommendations and should be verified by a developer.',
  );
  return lines.join('\n');
}
