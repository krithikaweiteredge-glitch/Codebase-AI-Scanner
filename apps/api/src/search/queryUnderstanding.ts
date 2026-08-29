import { splitIdentifier } from '../lib/text';

export type QueryIntent =
  | 'locate'
  | 'explain'
  | 'flow'
  | 'security'
  | 'bug'
  | 'performance'
  | 'test'
  | 'documentation'
  | 'general';

export interface UnderstoodQuery {
  raw: string;
  intent: QueryIntent;
  /** Terms used for lexical + symbol search, including expansions. */
  terms: string[];
  /** Terms taken verbatim from the question (higher weight). */
  literals: string[];
  /** Roles worth boosting for this question. */
  preferredRoles: string[];
}

const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','of','in','on','at','to','for','with','by','from',
  'and','or','not','do','does','did','how','what','where','when','why','which','who','whom','this','that','these',
  'those','it','its','as','if','then','than','so','can','could','should','would','may','might','will','shall',
  'me','my','our','we','you','your','i','show','find','tell','about','into','over','under','all','any','some',
  'code','codebase','repo','repository','project','file','files','please','happens','happen','using','used','use',
]);

/**
 * Domain expansions. These are deliberately conservative: they widen recall for
 * concepts that are named differently in code than in questions, without
 * inventing anything - retrieval results are still validated against the index.
 */
const EXPANSIONS: Record<string, string[]> = {
  authentication: ['auth', 'login', 'signin', 'session', 'jwt', 'token', 'credential', 'password', 'passport', 'oauth'],
  authenticated: ['auth', 'session', 'jwt', 'token'],
  auth: ['authenticate', 'login', 'jwt', 'token', 'session', 'middleware', 'guard'],
  authorization: ['authorize', 'permission', 'role', 'rbac', 'acl', 'guard', 'policy', 'scope'],
  login: ['signin', 'authenticate', 'session', 'credential', 'password'],
  logout: ['signout', 'session', 'revoke'],
  registration: ['register', 'signup', 'createuser', 'onboard'],
  register: ['signup', 'createuser'],
  jwt: ['token', 'sign', 'verify', 'jsonwebtoken', 'jose', 'claims'],
  password: ['bcrypt', 'argon2', 'hash', 'scrypt', 'credential'],
  database: ['db', 'connection', 'pool', 'client', 'prisma', 'sequelize', 'mongoose', 'sqlalchemy', 'repository'],
  connection: ['connect', 'pool', 'client', 'datasource'],
  payment: ['pay', 'charge', 'stripe', 'checkout', 'invoice', 'billing', 'transaction', 'refund'],
  order: ['orders', 'cart', 'checkout', 'purchase', 'fulfillment'],
  email: ['mail', 'smtp', 'sendgrid', 'nodemailer', 'notification', 'template'],
  otp: ['code', 'verification', 'twofactor', '2fa', 'mfa', 'sms'],
  upload: ['file', 'multipart', 'storage', 's3', 'bucket', 'attachment'],
  s3: ['bucket', 'aws', 'storage', 'putobject', 'getobject'],
  cache: ['redis', 'memo', 'ttl', 'invalidate'],
  queue: ['job', 'worker', 'bull', 'kafka', 'rabbit', 'consumer', 'producer'],
  endpoint: ['route', 'controller', 'handler', 'api', 'path'],
  endpoints: ['route', 'routes', 'controller', 'handler', 'api'],
  api: ['route', 'controller', 'endpoint', 'handler'],
  route: ['router', 'endpoint', 'controller', 'handler'],
  middleware: ['interceptor', 'guard', 'filter', 'handler'],
  validation: ['validate', 'schema', 'zod', 'joi', 'yup', 'sanitize'],
  logging: ['logger', 'log', 'winston', 'pino', 'trace'],
  configuration: ['config', 'env', 'settings', 'dotenv'],
  websocket: ['socket', 'ws', 'realtime', 'subscribe'],
  migration: ['migrate', 'schema', 'ddl'],
  test: ['spec', 'describe', 'expect', 'mock', 'fixture'],
  tests: ['spec', 'describe', 'expect', 'mock'],
  vulnerability: ['injection', 'xss', 'csrf', 'sanitize', 'escape', 'secret'],
  security: ['auth', 'sanitize', 'escape', 'secret', 'permission', 'injection'],
  performance: ['cache', 'query', 'loop', 'index', 'pagination', 'batch'],
};

const INTENT_RULES: { intent: QueryIntent; pattern: RegExp; roles: string[] }[] = [
  { intent: 'security', pattern: /\b(security|vulnerab|injection|xss|csrf|ssrf|exploit|insecure|secret|leak|sanitiz)\w*/i, roles: ['route', 'controller', 'middleware', 'repository', 'auth', 'config'] },
  { intent: 'bug', pattern: /\b(bug|broken|error|crash|exception|null|undefined|race condition|edge case|fails?)\b/i, roles: ['service', 'controller', 'repository', 'util'] },
  { intent: 'performance', pattern: /\b(performance|slow|n\+1|latency|optimi[sz]|memory|bottleneck|cache|scalab)\w*/i, roles: ['service', 'repository', 'component'] },
  { intent: 'test', pattern: /\b(test|tests|testing|coverage|unit test|spec|should i test)\b/i, roles: ['service', 'util', 'controller', 'test'] },
  { intent: 'flow', pattern: /\b(flow|what happens|end to end|lifecycle|sequence|pipeline|when a user|walk me through)\b/i, roles: ['route', 'controller', 'service', 'repository'] },
  { intent: 'locate', pattern: /\b(where|which file|find|locate|show me|list all)\b/i, roles: [] },
  { intent: 'documentation', pattern: /\b(document|readme|how do i (?:run|install|setup)|architecture overview)\b/i, roles: ['config', 'entrypoint'] },
  { intent: 'explain', pattern: /\b(explain|how does|what does|why does|describe|understand)\b/i, roles: [] },
];

const ROLE_HINTS: { pattern: RegExp; roles: string[] }[] = [
  { pattern: /\bauth|login|jwt|token|session|permission|role\b/i, roles: ['auth', 'middleware', 'service', 'route', 'controller'] },
  { pattern: /\bendpoint|route|api|controller\b/i, roles: ['route', 'controller'] },
  { pattern: /\bdatabase|query|schema|model|migration\b/i, roles: ['repository', 'model', 'migration'] },
  { pattern: /\bcomponent|render|ui|page|screen\b/i, roles: ['component', 'hook'] },
  { pattern: /\bjob|worker|queue|cron|schedule\b/i, roles: ['worker'] },
  { pattern: /\bconfig|environment|env var|setting\b/i, roles: ['config', 'entrypoint'] },
];

export function understandQuery(raw: string): UnderstoodQuery {
  const trimmed = raw.trim();

  const literals: string[] = [];
  for (const token of trimmed.split(/[^A-Za-z0-9_$.]+/)) {
    if (!token) continue;
    const lower = token.toLowerCase();
    if (STOPWORDS.has(lower) || lower.length < 2) continue;
    literals.push(token);
  }

  // Anything quoted or written in code style is a strong literal signal.
  for (const m of trimmed.matchAll(/[`"']([^`"']{2,60})[`"']/g)) {
    if (m[1]) literals.push(m[1]);
  }

  const terms = new Set<string>();
  for (const literal of literals) {
    const lower = literal.toLowerCase();
    terms.add(lower);
    for (const part of splitIdentifier(literal)) if (!STOPWORDS.has(part) && part.length > 2) terms.add(part);
    for (const expansion of EXPANSIONS[lower] ?? []) terms.add(expansion);
  }

  let intent: QueryIntent = 'general';
  let preferredRoles: string[] = [];
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(trimmed)) {
      intent = rule.intent;
      preferredRoles = rule.roles;
      break;
    }
  }
  for (const hint of ROLE_HINTS) {
    if (hint.pattern.test(trimmed)) preferredRoles = [...new Set([...preferredRoles, ...hint.roles])];
  }

  return {
    raw: trimmed,
    intent,
    terms: [...terms].slice(0, 40),
    literals: [...new Set(literals)].slice(0, 20),
    preferredRoles,
  };
}
