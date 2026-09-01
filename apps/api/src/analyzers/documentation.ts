import type { Prisma } from '@prisma/client';
import { aiEnabled } from '../ai/provider';
import { AIGenerationUnavailable, generateStructured } from '../ai/structured';
import { prisma } from '../db';
import { env } from '../env';
import { routeGroup } from '../indexer/apiRoutes';
import type { RunScript, StackProfile } from '../indexer/projectMap';
import {
  DOCUMENTATION_SECTIONS,
  DOCUMENTATION_SYSTEM_PROMPT,
  SECTION_BRIEFS,
  buildDocumentationPrompt,
  documentationSectionSchema,
  type DocumentationSectionKey,
} from '../prompts/documentation';
import { buildCodeContext, buildRepositoryOverview } from '../search/context';
import { hybridSearch, type RetrievedChunk } from '../search/hybrid';

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

  // Once the provider is exhausted (quota, no key, hard failure) every further
  // call fails the same way; keep writing the deterministic sections instead of
  // burning a request per section.
  let aiAvailable = aiEnabled();

  for (const [index, section] of sections.entries()) {
    const deterministic = deterministicSection(section, options.stack, options.repositoryName);
    let result: GeneratedSection = deterministic;

    if (aiAvailable) {
      try {
        const search = await hybridSearch({
          repositoryId: options.repositoryId,
          branchId: options.branchId,
          query: SECTION_QUERIES[section],
          limit: 10,
        });
        const pinned = await pinnedChunks(options.branchId, section, options.stack);
        const context = buildCodeContext(
          [...pinned, ...search.results.filter((r) => !pinned.some((p) => p.filePath === r.filePath))],
          Math.floor(env.CONTEXT_TOKEN_BUDGET * 0.7),
        );

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
        // The deterministic section is already the fallback; say why the richer
        // one is missing rather than silently shipping the stub.
        // Provider errors carry a whole JSON body; this lands in the rendered
        // documentation, so keep it to one readable line.
        const reason = truncate(error instanceof Error ? error.message : String(error), 200);
        result = {
          ...deterministic,
          contentMd: `${deterministic.contentMd}\n\n> The AI narrative for this section could not be generated: ${reason}`,
        };
        if (error instanceof AIGenerationUnavailable) aiAvailable = false;
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

      if (!stack.manifestFiles.length && !stack.packageManagers.length) {
        lines.push('No dependency manifest was detected in the indexed files, so no install command can be quoted.', '');
        break;
      }

      lines.push('### Prerequisites', '');
      if (stack.runtimes.length) {
        lines.push('| Runtime | Required version | Pinned in |', '| --- | --- | --- |');
        for (const runtime of stack.runtimes) {
          lines.push(`| ${runtime.name} | \`${runtime.version}\` | \`${runtime.file}\` |`);
          sources.add(runtime.file);
        }
      } else {
        lines.push('The manifests do not pin a runtime version.');
      }
      if (stack.packageManagers.length) {
        lines.push(
          '',
          `Package manager(s): ${stack.packageManagers.map((p) => `**${p.name}**`).join(', ')} — ${stack.packageManagers
            .map((p) => `\`${p.evidence[0]?.file ?? 'n/a'}\``)
            .join(', ')}`,
        );
        for (const manager of stack.packageManagers) {
          for (const evidence of manager.evidence) sources.add(evidence.file);
        }
      }
      if (stack.databases.length) {
        lines.push('', `Datastores the code connects to: ${stack.databases.map((d) => `**${d.name}**`).join(', ')}.`);
      }
      lines.push('');

      const install = installCommands(stack);
      if (install.length) {
        lines.push('### Install dependencies', '');
        lines.push('```bash');
        for (const command of install) lines.push(command);
        lines.push('```', '');
      }

      const envExample = stack.configFiles.find((f) => /(^|\/)\.env\.(example|sample|template)$/.test(f));
      if (envExample) {
        lines.push('### Configure the environment', '');
        lines.push(
          `The repository ships \`${envExample}\`. Copy it and fill in the values described under Environment Variables:`,
          '',
        );
        lines.push('```bash', `cp ${envExample} ${envExample.replace(/\.(example|sample|template)$/, '')}`, '```', '');
        sources.add(envExample);
      }

      const scripts = notableScripts(stack);
      if (scripts.length) {
        lines.push('### Declared commands', '');
        lines.push('| Command | Runs | Declared in |', '| --- | --- | --- |');
        for (const script of scripts) {
          lines.push(
            `| \`${script.runner} ${script.name}\` | ${script.command ? `\`${truncate(script.command, 90)}\`` : '—'} | \`${script.file}\` |`,
          );
          sources.add(script.file);
        }
        lines.push('');
      } else if (stack.manifestFiles.length) {
        lines.push('The manifests declare no build or run scripts.', '');
      }

      if (stack.hasDocker) {
        lines.push('### Docker', '');
        lines.push(
          `Docker configuration is present (${stack.dockerFiles.map((f) => `\`${f}\``).join(', ')}), so the stack can also be started with Docker.`,
          '',
        );
        const compose = stack.dockerFiles.find((f) => /docker-compose/i.test(f));
        if (compose) {
          lines.push('```bash', `docker compose -f ${compose} up --build`, '```', '');
        }
        for (const file of stack.dockerFiles) sources.add(file);
      }
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
        const key = routeGroup(route.path);
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
      lines.push(`- Monorepo layout: ${stack.monorepo ? 'yes' : 'no'}`, '');

      if (stack.dockerFiles.length) {
        lines.push('### Container images', '');
        for (const file of stack.dockerFiles) {
          lines.push(`- \`${file}\``);
          sources.add(file);
        }
        lines.push('');
      } else {
        lines.push('No Dockerfile or compose file was detected.', '');
      }

      if (stack.ciFiles.length) {
        lines.push('### CI pipelines', '');
        for (const file of stack.ciFiles) {
          lines.push(`- \`${file}\``);
          sources.add(file);
        }
        lines.push('');
      } else {
        lines.push('No CI pipeline configuration was detected.', '');
      }

      const buildScripts = stack.scripts.filter((s) => /^(build|compile|package|deploy|release|start)/i.test(s.name));
      if (buildScripts.length) {
        lines.push('### Build and release commands', '');
        lines.push('| Command | Runs | Declared in |', '| --- | --- | --- |');
        for (const script of buildScripts.slice(0, 20)) {
          lines.push(
            `| \`${script.runner} ${script.name}\` | ${script.command ? `\`${truncate(script.command, 90)}\`` : '—'} | \`${script.file}\` |`,
          );
          sources.add(script.file);
        }
        lines.push('');
      }
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

      const testScripts = stack.scripts.filter((s) => /(test|spec|e2e|coverage|lint|typecheck)/i.test(s.name));
      if (testScripts.length) {
        lines.push('', '### How to run the tests', '');
        lines.push('```bash');
        for (const script of testScripts.slice(0, 12)) lines.push(`${script.runner} ${script.name}`);
        lines.push('```');
        for (const script of testScripts) sources.add(script.file);
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

/**
 * Files a section cannot be written without. Embedding search ranks a JSON
 * manifest poorly against a prose query, so "installation" used to be written
 * without ever seeing package.json - the model had nothing to quote and fell
 * back to generic advice. These are force-fed into the context instead.
 */
function pinnedPaths(section: DocumentationSectionKey, stack: StackProfile): string[] {
  switch (section) {
    case 'overview':
      return stack.manifestFiles.slice(0, 6);
    case 'installation':
      return [...stack.manifestFiles, ...stack.dockerFiles].slice(0, 12);
    case 'deployment':
      return [...stack.dockerFiles, ...stack.ciFiles, ...stack.manifestFiles].slice(0, 12);
    case 'testing':
      return [...stack.manifestFiles, ...stack.configFiles.filter((f) => /(vitest|jest|playwright|cypress|pytest|karma)/i.test(f))].slice(0, 10);
    case 'configuration':
      return stack.configFiles.slice(0, 12);
    case 'environment-variables':
      return stack.configFiles.filter((f) => /(^|\/)\.env\./.test(f)).slice(0, 4);
    case 'database':
      return stack.databases.flatMap((d) => d.evidence.map((e) => e.file)).slice(0, 8);
    default:
      return [];
  }
}

/** Whole-file context for the paths a section is anchored to. */
async function pinnedChunks(
  branchId: string,
  section: DocumentationSectionKey,
  stack: StackProfile,
): Promise<RetrievedChunk[]> {
  const paths = [...new Set(pinnedPaths(section, stack))];
  const wantsReadme = section === 'overview' || section === 'installation';
  if (!paths.length && !wantsReadme) return [];

  const files = await prisma.repositoryFile.findMany({
    where: {
      branchId,
      OR: [...(paths.length ? [{ path: { in: paths } }] : []), ...(wantsReadme ? [{ path: { startsWith: 'README' } }] : [])],
    },
    select: { id: true, path: true, content: true, language: true, role: true },
    take: 16,
  });

  return files.map((file) => {
    const lines = (file.content ?? '').split('\n').slice(0, 200);
    return {
      id: `pinned:${file.id}`,
      fileId: file.id,
      filePath: file.path,
      language: file.language,
      role: file.role,
      symbolName: null,
      symbolType: 'file',
      startLine: 1,
      endLine: lines.length,
      content: lines.join('\n'),
      score: 1,
      fusedScore: 1,
      matchedBy: ['section-manifest'],
      ranks: {},
    } satisfies RetrievedChunk;
  });
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Install commands implied by the manifests that are actually present. Each one
 * is tied to a manifest in the repository - nothing is offered speculatively.
 */
function installCommands(stack: StackProfile): string[] {
  const out: string[] = [];
  const has = (name: string) => stack.manifestFiles.some((f) => f.toLowerCase().endsWith(name));
  const managers = new Set(stack.packageManagers.map((p) => p.name));

  if (has('package.json')) {
    if (managers.has('pnpm')) out.push('pnpm install');
    else if (managers.has('yarn')) out.push('yarn install');
    else if (managers.has('bun')) out.push('bun install');
    else out.push('npm install');
  }
  if (has('requirements.txt')) out.push('pip install -r requirements.txt');
  if (has('pyproject.toml')) out.push(managers.has('poetry') ? 'poetry install' : 'pip install -e .');
  if (has('pipfile')) out.push('pipenv install');
  if (has('go.mod')) out.push('go mod download');
  if (has('cargo.toml')) out.push('cargo build');
  if (has('gemfile')) out.push('bundle install');
  if (has('composer.json')) out.push('composer install');
  if (has('pom.xml')) out.push('mvn install');
  if (has('build.gradle') || has('build.gradle.kts')) out.push('./gradlew build');

  return [...new Set(out)];
}

/**
 * Scripts a newcomer needs first: setup, build, run and test, then whatever
 * else the manifests declare, capped so the table stays readable.
 */
function notableScripts(stack: StackProfile): RunScript[] {
  const priority = /^(postinstall|prepare|setup|bootstrap|migrate|db:[\w-]+|seed|build|start|serve|dev|test|lint|typecheck)/i;
  // In a monorepo the same script name exists in every workspace; the root
  // manifest is the one a newcomer can actually run from a fresh clone.
  const depth = (s: RunScript) => s.file.split('/').length;
  const ranked = [...stack.scripts].sort((a, b) => {
    const score = (s: RunScript) => (priority.test(s.name) ? 0 : 1);
    return score(a) - score(b) || depth(a) - depth(b);
  });
  return ranked.slice(0, 25);
}

/** Concatenate stored sections into a single downloadable markdown document. */
export async function exportDocumentationMarkdown(repositoryId: string, repositoryName: string): Promise<string> {
  const docs = await prisma.documentation.findMany({
    where: { repositoryId },
    orderBy: { position: 'asc' },
  });

  // An empty string is the caller's signal that there is nothing to download.
  // Emitting the header regardless made that check unreachable and shipped a
  // document with a title and no content.
  if (!docs.length) return '';

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
