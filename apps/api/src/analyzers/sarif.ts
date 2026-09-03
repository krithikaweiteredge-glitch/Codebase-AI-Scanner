/**
 * SARIF 2.1.0 output.
 *
 * Findings that live only in this product's own web UI are findings someone
 * has to remember to go and look at. SARIF is the format GitHub's Security
 * tab, VS Code, and every dashboard already read, so emitting it is what turns
 * a scan into something that shows up on a pull request next to the diff.
 *
 * Two details carry more weight than the rest of the document. `ruleId` groups
 * results so the same rule reads as one problem across a repository, and
 * `partialFingerprints` is how a consumer recognises a finding it has already
 * seen - which is exactly what this project's own fingerprints were built for,
 * so they are reused rather than invented again here.
 */

export interface SarifFinding {
  ruleId: string | null;
  type: string;
  title: string;
  description: string;
  severity: string;
  category: string;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  recommendation: string | null;
  cwe: string | null;
  confidence: number;
  fingerprint: string | null;
  source: string;
}

/**
 * SARIF has three levels and this product has five, so two pairs collapse.
 * Critical and high both stop a reviewer; low and info both do not.
 */
function levelFor(severity: string): 'error' | 'warning' | 'note' {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'note';
}

/** GitHub reads this to sort the Security tab, and it keeps all five levels. */
function securitySeverityFor(severity: string): string {
  switch (severity) {
    case 'critical':
      return '9.5';
    case 'high':
      return '7.5';
    case 'medium':
      return '5.0';
    case 'low':
      return '3.0';
    default:
      return '1.0';
  }
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  help: { text: string; markdown: string };
  defaultConfiguration: { level: 'error' | 'warning' | 'note' };
  properties: { tags: string[]; 'security-severity': string; precision: string };
}

/** SARIF wants a single line; a description may be several paragraphs. */
const oneLine = (text: string, limit = 300): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

/** Confidence maps to SARIF's precision vocabulary, which consumers rank on. */
function precisionFor(confidence: number): string {
  if (confidence >= 0.9) return 'very-high';
  if (confidence >= 0.75) return 'high';
  if (confidence >= 0.5) return 'medium';
  return 'low';
}

export interface SarifOptions {
  toolName?: string;
  version?: string;
  informationUri?: string;
  /** Commit the findings describe, so a consumer can tie them to a revision. */
  commitSha?: string | null;
  repositoryUri?: string | null;
}

/**
 * Builds a SARIF log.
 *
 * Every distinct rule appears once in `tool.driver.rules` and results point at
 * it by index, which is what lets a consumer show "3 instances of SQL
 * injection" rather than three unrelated rows.
 */
export function toSarif(findings: readonly SarifFinding[], options: SarifOptions = {}): Record<string, unknown> {
  const rules: SarifRule[] = [];
  const ruleIndex = new Map<string, number>();

  const results = findings.map((finding) => {
    const id = finding.ruleId ?? `${finding.category}.${finding.type}`;

    if (!ruleIndex.has(id)) {
      ruleIndex.set(id, rules.length);
      rules.push({
        id,
        name: finding.type,
        shortDescription: { text: oneLine(finding.title, 120) },
        fullDescription: { text: oneLine(finding.description) },
        help: {
          text: oneLine(finding.recommendation ?? finding.description),
          markdown: `**${finding.title}**\n\n${finding.description}${
            finding.recommendation ? `\n\n**Recommendation:** ${finding.recommendation}` : ''
          }`,
        },
        defaultConfiguration: { level: levelFor(finding.severity) },
        properties: {
          // The CWE tag is what makes a finding filterable next to other tools'
          // output, so it is emitted in the form GitHub expects.
          tags: ['security', finding.category, ...(finding.cwe ? [`external/cwe/${finding.cwe.toLowerCase()}`] : [])],
          'security-severity': securitySeverityFor(finding.severity),
          precision: precisionFor(finding.confidence),
        },
      });
    }

    const startLine = Math.max(1, finding.startLine ?? 1);
    return {
      ruleId: id,
      ruleIndex: ruleIndex.get(id),
      level: levelFor(finding.severity),
      message: { text: oneLine(finding.description, 800) },
      locations: [
        {
          physicalLocation: {
            // A finding with no file still belongs somewhere; the repository
            // root is honest about not knowing rather than inventing a path.
            artifactLocation: { uri: finding.filePath ?? '.', uriBaseId: '%SRCROOT%' },
            region: {
              startLine,
              endLine: Math.max(startLine, finding.endLine ?? startLine),
            },
          },
        },
      ],
      // Reuse of this project's own fingerprint, which is already built to
      // survive a line moving. Without it a consumer treats every run as a new
      // set of problems and any triage a person did is lost.
      ...(finding.fingerprint ? { partialFingerprints: { codebaseAiFingerprint: finding.fingerprint } } : {}),
      properties: { confidence: finding.confidence, detector: finding.source },
    };
  });

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: options.toolName ?? 'Codebase AI Scanner',
            version: options.version ?? '1.0.0',
            informationUri: options.informationUri ?? 'https://github.com/krithikaweiteredge-glitch/Codebase-AI-Scanner',
            rules,
          },
        },
        ...(options.commitSha || options.repositoryUri
          ? {
              versionControlProvenance: [
                {
                  ...(options.repositoryUri ? { repositoryUri: options.repositoryUri } : {}),
                  ...(options.commitSha ? { revisionId: options.commitSha } : {}),
                },
              ],
            }
          : {}),
        results,
      },
    ],
  };
}
