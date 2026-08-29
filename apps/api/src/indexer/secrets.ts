export interface SecretMatch {
  ruleId: string;
  label: string;
  line: number;
  /** Never the secret itself - only a short, non-reversible preview. */
  preview: string;
  severity: 'critical' | 'high' | 'medium';
  confidence: number;
}

interface SecretRule {
  id: string;
  label: string;
  pattern: RegExp;
  severity: 'critical' | 'high' | 'medium';
  confidence: number;
  /** Capture group holding the secret value (defaults to the whole match). */
  group?: number;
  requireEntropy?: number;
}

const RULES: SecretRule[] = [
  {
    id: 'secret.aws_access_key_id',
    label: 'AWS access key ID',
    pattern: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g,
    severity: 'critical',
    confidence: 0.95,
    group: 1,
  },
  {
    id: 'secret.aws_secret_access_key',
    label: 'AWS secret access key',
    pattern: /\baws_?secret_?access_?key\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
    severity: 'critical',
    confidence: 0.9,
    group: 1,
  },
  {
    id: 'secret.github_token',
    label: 'GitHub token',
    pattern: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g,
    severity: 'critical',
    confidence: 0.97,
    group: 1,
  },
  {
    id: 'secret.private_key',
    label: 'Private key block',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    severity: 'critical',
    confidence: 0.99,
  },
  {
    id: 'secret.stripe_key',
    label: 'Stripe secret key',
    pattern: /\b((?:sk|rk)_live_[A-Za-z0-9]{16,})\b/g,
    severity: 'critical',
    confidence: 0.96,
    group: 1,
  },
  {
    id: 'secret.slack_token',
    label: 'Slack token',
    pattern: /\b(xox[abposr]-[A-Za-z0-9-]{10,})\b/g,
    severity: 'high',
    confidence: 0.93,
    group: 1,
  },
  {
    id: 'secret.google_api_key',
    label: 'Google API key',
    pattern: /\b(AIza[0-9A-Za-z_\-]{35})\b/g,
    severity: 'high',
    confidence: 0.92,
    group: 1,
  },
  {
    id: 'secret.openai_key',
    label: 'OpenAI/Anthropic API key',
    pattern: /\b((?:sk-proj-|sk-ant-|sk-)[A-Za-z0-9_\-]{20,})\b/g,
    severity: 'critical',
    confidence: 0.9,
    group: 1,
  },
  {
    id: 'secret.jwt',
    label: 'Hardcoded JWT',
    pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
    severity: 'high',
    confidence: 0.85,
    group: 1,
  },
  {
    id: 'secret.connection_string',
    label: 'Database connection string with credentials',
    pattern: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:'"@]+:[^\s:'"@]+@[^\s'"]+)/g,
    severity: 'critical',
    confidence: 0.9,
    group: 1,
  },
  {
    id: 'secret.generic_assignment',
    label: 'Hardcoded credential assignment',
    pattern:
      /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|encryption[_-]?key)\s*[:=]\s*['"]([^'"\s]{8,})['"]/gi,
    severity: 'high',
    confidence: 0.6,
    group: 1,
    requireEntropy: 2.6,
  },
];

/** Values that look like secrets but are obviously placeholders. */
const PLACEHOLDER = /^(?:\$\{|\{\{|<|process\.env|os\.environ|env\.|your[_-]|xxx|placeholder|changeme|change-me|example|sample|dummy|test|todo|redacted|\*+$)/i;
const PLACEHOLDER_EXACT = new Set([
  'password',
  'secret',
  'changeme',
  'change-me',
  'your-secret',
  'undefined',
  'null',
  'true',
  'false',
]);

export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (PLACEHOLDER_EXACT.has(v.toLowerCase())) return true;
  if (PLACEHOLDER.test(v)) return true;
  if (/^[a-z]+(_[a-z]+)*$/.test(v) && v.length < 24) return true; // snake_case words
  return false;
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

function preview(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}${'*'.repeat(Math.max(0, value.length - 2))}`;
  return `${value.slice(0, 4)}${'*'.repeat(8)}${value.slice(-2)}`;
}

/** Scan a file for credentials. Returns metadata only - never the raw secret. */
export function detectSecrets(content: string): SecretMatch[] {
  const found: SecretMatch[] = [];
  const seen = new Set<string>();

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(content)) !== null) {
      const value = (rule.group ? match[rule.group] : match[0]) ?? '';
      if (!value) continue;
      if (isPlaceholder(value)) continue;
      if (rule.requireEntropy && shannonEntropy(value) < rule.requireEntropy) continue;

      const line = lineAt(content, match.index);
      const key = `${rule.id}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);

      found.push({
        ruleId: rule.id,
        label: rule.label,
        line,
        preview: preview(value),
        severity: rule.severity,
        confidence: rule.confidence,
      });
      if (found.length >= 50) return found;
    }
  }
  return found;
}

/**
 * Replace detected secret values with a marker.
 *
 * Every path that sends repository content to an AI provider passes through
 * this function first (see src/search/context.ts).
 */
export function redactSecrets(content: string): { content: string; redactions: number } {
  let redactions = 0;
  let output = content;

  for (const rule of RULES) {
    output = output.replace(new RegExp(rule.pattern.source, rule.pattern.flags), (full, ...groups) => {
      const captured = rule.group ? (groups[rule.group - 1] as string | undefined) : full;
      if (!captured) return full;
      if (isPlaceholder(captured)) return full;
      if (rule.requireEntropy && shannonEntropy(captured) < rule.requireEntropy) return full;
      redactions++;
      return full.replace(captured, '[REDACTED_SECRET]');
    });
  }

  // Belt and braces: any line that assigns to an obviously sensitive env key.
  output = output.replace(
    /^(\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|PRIVATE_KEY|API_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*)(.+)$/gm,
    (full, prefix: string, value: string) => {
      const trimmed = value.trim();
      if (!trimmed || isPlaceholder(trimmed) || trimmed.length < 8) return full;
      redactions++;
      return `${prefix}[REDACTED_SECRET]`;
    },
  );

  return { content: output, redactions };
}
