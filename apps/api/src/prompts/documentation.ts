import { z } from 'zod';
import { GROUNDING_RULES, contextBlock } from './shared';

export const documentationSectionSchema = z.object({
  title: z.string().min(3).max(160),
  contentMd: z.string().min(20).max(20_000),
  sources: z.array(z.string().max(240)).max(40),
});

export type DocumentationSection = z.infer<typeof documentationSectionSchema>;

export const DOCUMENTATION_SECTIONS = [
  'overview',
  'architecture',
  'folder-structure',
  'installation',
  'environment-variables',
  'configuration',
  'authentication',
  'authorization',
  'api',
  'database',
  'workflows',
  'external-services',
  'deployment',
  'testing',
  'troubleshooting',
] as const;

export type DocumentationSectionKey = (typeof DOCUMENTATION_SECTIONS)[number];

export const SECTION_BRIEFS: Record<DocumentationSectionKey, string> = {
  overview: 'What the project is, what it does, who uses it, and its main capabilities - inferred only from real code, manifests and README content.',
  architecture: 'The runtime shape: layers, main modules, how a request flows through them, and where state lives.',
  'folder-structure': 'A tree of the significant directories with one line each explaining what belongs there.',
  installation: 'Exact prerequisites and commands taken from the manifests and scripts that exist in the repository.',
  'environment-variables': 'A table of every environment variable the code reads, where it is read, and what it appears to control.',
  configuration: 'Configuration files, what each one configures, and the notable settings.',
  authentication: 'How a caller proves identity: the mechanism, the code path, token issuance and validation.',
  authorization: 'How access decisions are made after authentication: roles, guards, ownership checks, and unprotected surface.',
  api: 'Every detected endpoint: method, path, purpose, request and response shape where visible, auth requirement, and implementing files.',
  database: 'Datastores in use, how connections are created, the schema/models, and migration mechanics.',
  workflows: 'The three to six most important end-to-end workflows, each as an ordered chain of real functions.',
  'external-services': 'Third-party services the code talks to, where the integration lives, and what it is used for.',
  deployment: 'How the project is built, containerised and shipped, from Dockerfiles/CI/scripts that exist.',
  testing: 'The test framework, how tests are structured and run, and where coverage is visibly thin.',
  troubleshooting: 'Failure modes that the code itself reveals: thrown errors, retries, timeouts, and what they mean.',
};

export const DOCUMENTATION_SYSTEM_PROMPT = `You write precise technical documentation for a repository from its index.

${GROUNDING_RULES}

Rules:
- Documentation is reference material: every statement must be checkable against the code you were shown.
- Cite implementing files inline, e.g. "implemented in \`src/auth/AuthService.ts:34-89\`".
- Use markdown: headings, tables for structured data (env vars, endpoints), fenced code blocks for commands taken from real scripts.
- Never write aspirational or placeholder content. If a section has no supporting evidence in the repository, write one sentence saying the repository contains no evidence for it.
- "sources" lists the file paths you relied on.

Return JSON: {"title","contentMd","sources"}.`;

export interface DocumentationPromptInput {
  repositoryName: string;
  section: DocumentationSectionKey;
  brief: string;
  overview: string;
  codeContext: string;
  extraFacts?: string;
}

export function buildDocumentationPrompt(input: DocumentationPromptInput): string {
  const parts = [
    `Repository: ${input.repositoryName}`,
    `Section to write: "${input.section}" - ${input.brief}`,
    contextBlock('REPOSITORY INDEX FACTS', input.overview),
  ];
  if (input.extraFacts) parts.push(contextBlock('STRUCTURED FACTS FOR THIS SECTION', input.extraFacts));
  parts.push(contextBlock('CODE EXCERPTS', input.codeContext || '(no excerpts matched this section)'));
  parts.push('Write this documentation section and return the JSON object described in the system prompt.');
  return parts.join('\n\n');
}
