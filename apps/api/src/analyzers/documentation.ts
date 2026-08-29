import type { Prisma } from '@prisma/client';
import { aiEnabled } from '../ai/provider';
import { AIGenerationUnavailable, generateStructured } from '../ai/structured';
import { prisma } from '../db';
import { env } from '../env';
import type { StackProfile } from '../indexer/projectMap';
import {
  DOCUMENTATION_SECTIONS,
  DOCUMENTATION_SYSTEM_PROMPT,
  SECTION_BRIEFS,
  buildDocumentationPrompt,
  documentationSectionSchema,
  type DocumentationSectionKey,
} from '../prompts/documentation';
import { buildCodeContext, buildRepositoryOverview } from '../search/context';
import { hybridSearch } from '../search/hybrid';

const SECTION_QUERIES: Record<DocumentationSectionKey, string> = {
  overview: 'main entry point application bootstrap what this service does',
  architecture: 'application layers modules services controllers repositories wiring',
  'folder-structure': 'directory layout module organisation index files',
  installation: 'package manifest scripts install build start commands',
  'environment-variables': 'process.env configuration environment variables config loading',
  configuration: 'configuration files settings options defaults',
  authentication: 'authentication login token session credential verify password',
  authorization: 'authorization permission role guard access control middleware',
  api: 'route controller endpoint handler request response',
  database: 'database connection schema model migration query repository',
  workflows: 'main business workflow service orchestration process',
  'external-services': 'third party api client sdk integration webhook',
  deployment: 'dockerfile docker compose ci workflow deploy build pipeline',
  testing: 'test spec describe expect mock fixture setup',
  troubleshooting: 'error handling exception retry timeout logging failure',
};

export interface GeneratedSection {
  section: DocumentationSectionKey;
  title: string;
  contentMd: string;
  sources: string[];
  generatedBy: 'ai' | 'deterministic';
}

export interface DocumentationOptions {
  repositoryId: string;
  branchId: string;
  repositoryName: string;
  stack: StackProfile;
  runId?: string | null;
  sections?: DocumentationSectionKey[];
}

export async function generateDocumentation(options: DocumentationOptions): Promise<GeneratedSection[]> {
  const sections = options.sections ?? [...DOCUMENTATION_SECTIONS];
  const overview = buildRepositoryOverview(options.stack, { maxRoutes: 60, maxDirectories: 40 });
  const out: GeneratedSection[] = [];

  for (const [index, section] of sections.entries()) {
    const deterministic = deterministicSection(section, options.stack, options.repositoryName);
    let result: GeneratedSection = deterministic;

    if (aiEnabled()) {
      try {
        const search = await hybridSearch({
          repositoryId: options.repositoryId,
          branchId: options.branchId,
          query: SECTION_QUERIES[section],
          limit: 10,
        });
        const context = buildCodeContext(search.results, Math.floor(env.CONTEXT_TOKEN_BUDGET * 0.7));

        const { data } = await generateStructured({
          system: DOCUMENTATION_SYSTEM_PROMPT,
          user: buildDocumentationPrompt({
            repositoryName: options.repositoryName,
            section,
            brief: SECTION_BRIEFS[section],
            overview,
            codeContext: context.text,
            extraFacts: deterministic.contentMd,
          }),
          schema: documentationSectionSchema,
          task: `documentation-${section}`,
          maxTokens: env.AI_MAX_OUTPUT_TOKENS,
        });

        result = {
          section,
          title: data.title,
          contentMd: data.contentMd,
          sources: data.sources,
          generatedBy: 'ai',
        };
      } catch (error) {
        if (error instanceof AIGenerationUnavailable) {
          // fall through to the deterministic version for every remaining section
        }
      }
    }

    await prisma.documentation.upsert({
      where: { repositoryId_section: { repositoryId: options.repositoryId, section } },
      create: {
        repositoryId: options.repositoryId,
        runId: options.runId ?? null,
        section,
        title: result.title,
        contentMd: result.contentMd,
        position: index,
        sources: result.sources as unknown as Prisma.InputJsonValue,
      },
      update: {
        runId: options.runId ?? null,
        title: result.title,
        contentMd: result.contentMd,
        position: index,
        sources: result.sources as unknown as Prisma.InputJsonValue,
      },
    });

    out.push(result);
  }

  return out;
}

const TITLES: Record<DocumentationSectionKey, string> = {
  overview: 'Project Overview',
  architecture: 'Architecture',
  'folder-structure': 'Folder Structure',
  installation: 'Installation',
  'environment-variables': 'Environment Variables',
  configuration: 'Configuration',
  authentication: 'Authentication',
  authorization: 'Authorization',
  api: 'API Documentation',
  database: 'Database',
  workflows: 'Important Workflows',
  'external-services': 'External Services',
  deployment: 'Deployment',
  testing: 'Testing',
  troubleshooting: 'Troubleshooting',
};

/**
 * Documentation built only from indexed facts. This is what ships when no AI
 * provider is configured, and it is also fed to the model as ground truth.
 */
export function deterministicSection(
  section: DocumentationSectionKey,
  stack: StackProfile,
  repositoryName: string,
): GeneratedSection {
  const lines: string[] = [];
  const sources = new Set<string>();
  const note = '_Generated from the repository index._';

  switch (section) {
    case 'overview': {
      lines.push(`# ${repositoryName}`, '');
      lines.push(`**Detected project type:** ${stack.projectTypes.join(', ')}`, '');
      lines.push('| Language | Share | Files | Lines |', '| --- | --- | --- | --- |');
      for (const language of stack.languages.slice(0, 10)) {
        lines.push(`| ${language.language} | ${language.percent}% | ${language.files} | ${language.lines} |`);
      }
      if (stack.frameworks.length) {
        lines.push('', '**Frameworks detected**', '');
        for (const framework of stack.frameworks) {
          const evidence = framework.evidence[0];
          lines.push(`- ${framework.name} — evidence: \`${evidence?.file ?? 'n/a'}\`${evidence?.detail ? ` (${evidence.detail})` : ''}`);
          if (evidence?.file) sources.add(evidence.file);
        }
      }
      if (stack.entryPoints.length) {
        lines.push('', '**Entry points**', '');
        for (const entry of stack.entryPoints) {
          lines.push(`- \`${entry.file}${entry.line ? `:${entry.line}` : ''}\` — ${entry.detail ?? ''}`);
          sources.add(entry.file);
        }
      }
      break;
    }

    case 'architecture': {
      lines.push('## Architecture', '');
      lines.push(`The index contains ${stack.directories.length} directories. Roles below are inferred from path conventions and file contents.`, '');
      lines.push('| Directory | Files | Dominant role | Lines |', '| --- | --- | --- | --- |');
      for (const dir of stack.directories.slice(0, 30)) {
        lines.push(`| \`${dir.path}\` | ${dir.fileCount} | ${dir.dominantRole} | ${dir.totalLines} |`);
      }
      break;
    }

    case 'folder-structure': {
      lines.push('## Folder Structure', '');
      lines.push('```');
      for (const dir of stack.directories.slice(0, 60).sort((a, b) => a.path.localeCompare(b.path))) {
        const depth = dir.path === '/' ? 0 : dir.path.split('/').length;
        lines.push(`${'  '.repeat(Math.min(depth, 6))}${dir.path.split('/').pop() || '/'}/  (${dir.fileCount} files, ${dir.dominantRole})`);
      }
      lines.push('```');
      lines.push('', '### Notable files', '');
      for (const dir of stack.directories.slice(0, 15)) {
        if (!dir.importantFiles.length) continue;
        lines.push(`- \`${dir.path}\`: ${dir.importantFiles.slice(0, 4).map((f) => `\`${f}\``).join(', ')}`);
      }
      break;
    }

    case 'installation': {
      lines.push('## Installation', '');
      if (stack.packageManagers.length) {
        lines.push(`Package manager(s) detected: ${stack.packageManagers.map((p) => `**${p.name}**`).join(', ')}`, '');
        for (const manager of stack.packageManagers) {
          for (const evidence of manager.evidence) sources.add(evidence.file);
        }
      } else {
        lines.push('No package manifest was detected in the indexed files.', '');
      }
      if (stack.hasDocker) lines.push('A Docker configuration is present, so the stack can also be started with Docker Compose.', '');
      break;
    }

    case 'environment-variables': {
      lines.push('## Environment Variables', '');
      if (!stack.envVars.length) {
        lines.push('No environment variable reads were detected in the indexed code.');
        break;
      }
      lines.push('| Variable | Read in |', '| --- | --- |');
      for (const variable of stack.envVars) {
        lines.push(`| \`${variable.name}\` | ${variable.files.slice(0, 3).map((f) => `\`${f}\``).join(', ')} |`);
        for (const file of variable.files) sources.add(file);
      }
      break;
    }

    case 'configuration': {
      lines.push('## Configuration', '');
      if (!stack.configFiles.length) {
        lines.push('No configuration files were detected.');
        break;
      }
      for (const file of stack.configFiles.slice(0, 40)) {
        lines.push(`- \`${file}\``);
        sources.add(file);
      }
      break;
    }

    case 'authentication':
    case 'authorization': {
      lines.push(`## ${TITLES[section]}`, '');
      if (!stack.authMechanisms.length) {
        lines.push('No authentication or authorization mechanism was detected in the indexed code.');
        break;
      }
      for (const mechanism of stack.authMechanisms) {
        lines.push(`### ${mechanism.name}`, '');
        for (const evidence of mechanism.evidence) {
          lines.push(`- \`${evidence.file}${evidence.line ? `:${evidence.line}` : ''}\` — ${evidence.detail ?? ''}`);
          sources.add(evidence.file);
        }
        lines.push('');
      }
      if (section === 'authorization') {
        const unprotected = stack.routes.filter((r) => !r.protectedHint);
        lines.push(
          `${stack.routes.length - unprotected.length} of ${stack.routes.length} detected endpoints have an auth guard visible near the declaration.`,
        );
      }
      break;
    }

    case 'api': {
      lines.push('## API Documentation', '');
      if (!stack.routes.length) {
        lines.push('No HTTP endpoints were detected in the indexed code.');
        break;
      }
      lines.push('| Method | Path | Implementation | Handler | Auth guard nearby |', '| --- | --- | --- | --- | --- |');
      for (const route of stack.routes.slice(0, 200)) {
        lines.push(
          `| ${route.method} | \`${route.path}\` | \`${route.file}:${route.line}\` | ${route.handler ? `\`${route.handler}\`` : '—'} | ${route.protectedHint ? 'yes' : 'not detected'} |`,
        );
        sources.add(route.file);
      }
      break;
    }

    case 'database': {
      lines.push('## Database', '');
      if (!stack.databases.length) {
        lines.push('No datastore or ORM was detected in the indexed code.');
        break;
      }
      for (const database of stack.databases) {
        lines.push(`### ${database.name}`, '');
        for (const evidence of database.evidence) {
          lines.push(`- \`${evidence.file}\`${evidence.detail ? ` — ${evidence.detail}` : ''}`);
          sources.add(evidence.file);
        }
        lines.push('');
      }
      break;
    }

    case 'workflows': {
      lines.push('## Important Workflows', '');
      const grouped = new Map<string, typeof stack.routes>();
      for (const route of stack.routes) {
        const key = route.path.split('/').filter(Boolean)[0] ?? 'root';
        const list = grouped.get(key) ?? [];
        list.push(route);
        grouped.set(key, list);
      }
      if (!grouped.size) {
        lines.push('No request workflows could be derived: no endpoints were detected.');
        break;
      }
      for (const [group, routes] of [...grouped.entries()].slice(0, 10)) {
        lines.push(`### \`/${group}\``, '');
        for (const route of routes.slice(0, 12)) {
          lines.push(`- ${route.method} \`${route.path}\` → \`${route.file}:${route.line}\``);
          sources.add(route.file);
        }
        lines.push('');
      }
      break;
    }

    case 'external-services': {
      lines.push('## External Services', '');
      if (!stack.externalServices.length) {
        lines.push('No third-party service integrations were detected.');
        break;
      }
      for (const service of stack.externalServices) {
        lines.push(`- **${service.name}** — ${service.evidence.map((e) => `\`${e.file}\``).join(', ')}`);
        for (const evidence of service.evidence) sources.add(evidence.file);
      }
      break;
    }

    case 'deployment': {
      lines.push('## Deployment', '');
      lines.push(`- Docker configuration present: ${stack.hasDocker ? 'yes' : 'no'}`);
      lines.push(`- CI configuration present: ${stack.hasCI ? 'yes' : 'no'}`);
      lines.push(`- Monorepo layout: ${stack.monorepo ? 'yes' : 'no'}`);
      break;
    }

    case 'testing': {
      lines.push('## Testing', '');
      if (stack.testFrameworks.length) {
        for (const framework of stack.testFrameworks) {
          lines.push(`- **${framework.name}** — ${framework.evidence.map((e) => `\`${e.file}\``).join(', ')}`);
          for (const evidence of framework.evidence) sources.add(evidence.file);
        }
      } else {
        lines.push('No test framework was detected in the indexed files.');
      }
      break;
    }

    case 'troubleshooting': {
      lines.push('## Troubleshooting', '');
      lines.push(
        'This section is generated from the code only when an AI provider is configured. ' +
          'Without one, review the error handling in the modules listed under Architecture.',
      );
      break;
    }
  }

  lines.push('', note);

  return {
    section,
    title: TITLES[section],
    contentMd: lines.join('\n'),
    sources: [...sources].slice(0, 40),
    generatedBy: 'deterministic',
  };
}

/** Concatenate stored sections into a single downloadable markdown document. */
export async function exportDocumentationMarkdown(repositoryId: string, repositoryName: string): Promise<string> {
  const docs = await prisma.documentation.findMany({
    where: { repositoryId },
    orderBy: { position: 'asc' },
  });

  const parts = [`# ${repositoryName} — Technical Documentation`, '', `_Generated ${new Date().toISOString()}_`, ''];
  parts.push('## Contents', '');
  for (const doc of docs) parts.push(`- [${doc.title}](#${doc.section})`);
  parts.push('');

  for (const doc of docs) {
    parts.push(`<a id="${doc.section}"></a>`, '');
    parts.push(doc.contentMd, '', '---', '');
  }

  return parts.join('\n');
}
