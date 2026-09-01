import ignore from 'ignore';

/** Directories and files that never carry useful signal for code intelligence. */
export const DEFAULT_IGNORE_PATTERNS = [
  'node_modules/',
  '.git/',
  '.svn/',
  '.hg/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.cache/',
  '__pycache__/',
  '.venv/',
  'venv/',
  'vendor/',
  'target/',
  'bin/',
  'obj/',
  '.gradle/',
  '.idea/',
  '.vscode/',
  'Pods/',
  '.terraform/',
  // secrets - never indexed, never sent anywhere
  '.env',
  '.env.*',
  // ...except the committed templates, which hold names and no values. They are
  // the repository's own statement of its configuration contract, and the
  // Environment Variables docs section is written from them.
  '!.env.example',
  '!.env.sample',
  '!.env.template',
  '!*.env.example',
  '!*.env.sample',
  '!*.env.template',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  // lockfiles / generated
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
  'Cargo.lock',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.generated.*',
  '*_pb2.py',
  '*.pb.go',
  // binary / media / archives
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.bmp',
  '*.ico',
  '*.webp',
  '*.svg',
  '*.mp4',
  '*.mov',
  '*.avi',
  '*.mp3',
  '*.wav',
  '*.pdf',
  '*.zip',
  '*.tar',
  '*.gz',
  '*.bz2',
  '*.7z',
  '*.rar',
  '*.jar',
  '*.war',
  '*.dll',
  '*.so',
  '*.dylib',
  '*.exe',
  '*.class',
  '*.pyc',
  '*.wasm',
  '*.ttf',
  '*.otf',
  '*.woff',
  '*.woff2',
  '*.eot',
  '*.db',
  '*.sqlite',
  '*.sqlite3',
  '*.parquet',
  '*.avro',
];

export interface IgnoreMatcher {
  ignores(path: string): boolean;
  patterns: string[];
}

/** Builds a gitignore-syntax matcher from defaults plus per-repository overrides. */
export function buildIgnoreMatcher(extraPatterns: readonly string[] = []): IgnoreMatcher {
  const patterns = [...DEFAULT_IGNORE_PATTERNS, ...extraPatterns.filter(Boolean)];
  const matcher = ignore().add(patterns);
  return {
    patterns,
    ignores(path: string) {
      const normalised = path.replace(/^\.\//, '').replace(/^\//, '');
      if (!normalised) return true;
      return matcher.ignores(normalised);
    },
  };
}
