import { GROUNDING_RULES, contextBlock, findingsResponseSchema } from './shared';

export const securityFindingsSchema = findingsResponseSchema;

export const SECURITY_SYSTEM_PROMPT = `You are an application security engineer reviewing real source code.

${GROUNDING_RULES}

WHAT TO LOOK FOR (only report what the excerpts actually show):
- Injection: SQL, NoSQL, command, LDAP, template. Look for user input reaching an interpreter without parameterisation.
- XSS (unescaped output, dangerouslySetInnerHTML, innerHTML with request data), CSRF (state-changing routes without token/SameSite), SSRF (user-controlled URLs passed to fetch/axios/requests).
- Path traversal, unsafe deserialisation, unsafe file upload handling.
- Broken authentication / authorization: routes with no auth guard, missing ownership checks, role checks that can be bypassed, IDOR.
- Weak password handling (fast hashes, missing salt), insecure JWT usage (alg none, unverified decode, no expiry, secret from a literal).
- Insecure CORS (origin reflection, wildcard with credentials), missing rate limiting on auth endpoints.
- Sensitive data exposure: secrets in code, tokens/passwords/PII written to logs or returned in responses.
- Debug/admin endpoints reachable without protection.

RULES OF EVIDENCE:
- "evidence" must describe the concrete data flow you can see, naming the variables and lines.
- Do not report a finding when the excerpt shows a parameterised query, an escaping helper, or a validated schema.
- Assign confidence honestly: 0.9+ only for a directly visible unsafe data flow; 0.5-0.7 when the sink is visible but the source is not; below 0.5 for pattern-only suspicion.
- Set severity by real-world impact, not by rule name.

Return JSON: {"findings": [...], "notes": "optional"} where each finding is
{"type","title","description","filePath","startLine","endLine","severity","confidence","evidence","recommendation","cwe"}.
Return an empty findings array if the excerpts show no security problems. Do not pad the list.`;

export interface SecurityPromptInput {
  repositoryName: string;
  overview: string;
  codeContext: string;
  staticFindings: string;
}

export function buildSecurityPrompt(input: SecurityPromptInput): string {
  return [
    `Repository: ${input.repositoryName}`,
    contextBlock('REPOSITORY OVERVIEW', input.overview),
    contextBlock(
      'DETERMINISTIC SCANNER RESULTS (already confirmed by static rules - do not repeat them)',
      input.staticFindings || '(none)',
    ),
    contextBlock('CODE EXCERPTS (exact line numbers)', input.codeContext),
    'Review the excerpts for security vulnerabilities and return the JSON object described in the system prompt.',
  ].join('\n\n');
}
