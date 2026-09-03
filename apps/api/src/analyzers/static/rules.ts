import type { AnalysisFindingDraft, AnalyzableFile, FindingCategory, Severity } from '../types';

export interface StaticRule {
  id: string;
  category: FindingCategory;
  type: string;
  title: string;
  severity: Severity;
  /** Deterministic detectors are high-confidence by construction. */
  confidence: number;
  languages: string[] | '*';
  pattern: RegExp;
  description: string;
  recommendation: string;
  cwe?: string;
  /** Skip the match when this also matches the same line (guards against safe usage). */
  unless?: RegExp;
  /** Skip in test files (many patterns are legitimate in tests). */
  skipTests?: boolean;
}

const JS = ['typescript', 'tsx', 'javascript', 'jsx', 'vue', 'svelte'];

export const STATIC_RULES: StaticRule[] = [
  // ------------------------------------------------------------------ security
  {
    id: 'sec.sql-injection.template',
    category: 'security',
    type: 'sql-injection',
    title: 'SQL query built with string interpolation',
    severity: 'critical',
    confidence: 0.85,
    languages: JS,
    pattern: /\.(?:query|execute|raw|unsafe|executeQuery|\$queryRawUnsafe|\$executeRawUnsafe)\s*\(\s*[`'"][^`'"]*(?:\$\{|['"]\s*\+)/,
    description:
      'A SQL statement is assembled with template interpolation or concatenation. If any interpolated value derives from a request, an attacker controls the query.',
    recommendation: 'Use parameterised queries / prepared statements and pass values as bind parameters.',
    cwe: 'CWE-89',
  },
  {
    id: 'sec.sql-injection.concat',
    category: 'security',
    type: 'sql-injection',
    title: 'SQL string concatenated with a request value',
    severity: 'critical',
    confidence: 0.9,
    languages: '*',
    // The SQL body must be allowed to contain quotes. `"... WHERE n = '" + req.x`
    // is the most common shape of this bug, and excluding quote characters
    // meant the rule could never match it. `;` and newline still bound the
    // match to a single statement.
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE)\s[^;\n]{0,200}['"`]\s*\+\s*(?:req\.|request\.|params\.|query\.|body\.|input|userId|name)/i,
    description: 'A request-derived value is concatenated directly into a SQL statement.',
    recommendation: 'Bind the value as a query parameter instead of concatenating it.',
    cwe: 'CWE-89',
  },
  {
    id: 'sec.sql-injection.python',
    category: 'security',
    type: 'sql-injection',
    title: 'SQL built with Python string formatting',
    severity: 'critical',
    confidence: 0.85,
    languages: ['python'],
    pattern: /(?:execute|executemany)\s*\(\s*(?:f["']|["'][^"']*["']\s*%|["'][^"']*["']\s*\.format\()/,
    description: 'The SQL statement is formatted with f-strings/%/format instead of parameter binding.',
    recommendation: 'Pass parameters as the second argument to execute(): cursor.execute(sql, (value,)).',
    cwe: 'CWE-89',
  },
  {
    id: 'sec.command-injection',
    category: 'security',
    type: 'command-injection',
    title: 'Shell command built from dynamic input',
    severity: 'critical',
    confidence: 0.85,
    languages: JS,
    pattern: /(?:exec|execSync|spawnSync)\s*\(\s*[`'"][^`'"]*(?:\$\{|['"]\s*\+)/,
    description: 'A shell command string is built by interpolation; injected metacharacters would execute arbitrary commands.',
    recommendation: 'Use execFile/spawn with an argument array, and validate inputs against an allowlist.',
    cwe: 'CWE-78',
  },
  {
    id: 'sec.command-injection.python',
    category: 'security',
    type: 'command-injection',
    title: 'Subprocess invoked with shell=True',
    severity: 'high',
    confidence: 0.8,
    languages: ['python'],
    pattern: /(?:subprocess\.(?:run|call|Popen|check_output)\s*\([^)]*shell\s*=\s*True|os\.system\s*\()/,
    description: 'Running a command through the shell makes any interpolated value a command-injection vector.',
    recommendation: 'Call subprocess with an argument list and shell=False.',
    cwe: 'CWE-78',
  },
  {
    id: 'sec.eval',
    category: 'security',
    type: 'code-injection',
    title: 'Dynamic code execution',
    severity: 'high',
    confidence: 0.8,
    languages: '*',
    pattern: /\b(?:eval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"`])/,
    description: 'Evaluating strings as code turns any attacker-controlled input into remote code execution.',
    recommendation: 'Replace dynamic evaluation with an explicit dispatch table or a safe parser.',
    cwe: 'CWE-95',
    skipTests: true,
  },
  {
    id: 'sec.xss.dangerously-set-html',
    category: 'security',
    type: 'xss',
    title: 'Raw HTML injected into the DOM',
    severity: 'high',
    confidence: 0.75,
    languages: JS,
    pattern: /dangerouslySetInnerHTML|\.innerHTML\s*=|document\.write\s*\(|v-html\s*=/,
    description: 'Unescaped HTML is written into the document; request- or user-derived content here yields stored/reflected XSS.',
    recommendation: 'Render text nodes, or sanitise with a vetted sanitiser (DOMPurify) before injecting HTML.',
    cwe: 'CWE-79',
    unless: /DOMPurify|sanitize|sanitise/i,
  },
  {
    id: 'sec.path-traversal',
    category: 'security',
    type: 'path-traversal',
    title: 'Filesystem path built from request input',
    severity: 'high',
    confidence: 0.8,
    languages: JS,
    pattern: /(?:readFile|readFileSync|createReadStream|sendFile|unlink|writeFile)\s*\([^)]*(?:req\.(?:params|query|body)|request\.(?:params|query|body))/,
    description: 'A request value flows into a filesystem path, allowing ../ traversal outside the intended directory.',
    recommendation: 'Resolve the path and verify it stays inside the allowed root, or map inputs to an allowlist of files.',
    cwe: 'CWE-22',
  },
  {
    id: 'sec.ssrf',
    category: 'security',
    type: 'ssrf',
    title: 'Outbound request to a user-controlled URL',
    severity: 'high',
    confidence: 0.75,
    languages: JS,
    pattern: /(?:fetch|axios(?:\.(?:get|post|put|delete))?|request|got|http\.get)\s*\(\s*(?:req\.(?:body|query|params)|`[^`]*\$\{\s*(?:req|url|target)\b)/,
    description: 'The destination of an outbound HTTP request comes from the caller, enabling SSRF against internal services.',
    recommendation: 'Validate the URL against an allowlist of hosts and block link-local/private ranges.',
    cwe: 'CWE-918',
  },
  {
    id: 'sec.jwt.decode-without-verify',
    category: 'security',
    type: 'broken-authentication',
    title: 'JWT decoded without signature verification',
    severity: 'critical',
    confidence: 0.9,
    languages: '*',
    pattern: /jwt\.decode\s*\(|jwt_decode\s*\(|decode\s*\([^)]*verify\s*=\s*False/,
    description: 'jwt.decode does not check the signature. Any attacker can forge the payload.',
    recommendation: 'Use jwt.verify (or decode with verification enabled) and pin the expected algorithm.',
    cwe: 'CWE-347',
    skipTests: true,
  },
  {
    id: 'sec.jwt.alg-none',
    category: 'security',
    type: 'broken-authentication',
    title: 'JWT "none" algorithm accepted',
    severity: 'critical',
    confidence: 0.95,
    languages: '*',
    pattern: /algorithms?\s*[:=]\s*\[?\s*['"]none['"]/i,
    description: 'Accepting the "none" algorithm lets anyone mint valid tokens.',
    recommendation: 'Pin an explicit algorithm such as HS256 or RS256 and reject everything else.',
    cwe: 'CWE-347',
  },
  {
    id: 'sec.weak-hash',
    category: 'security',
    type: 'weak-cryptography',
    title: 'Weak hash used for credentials',
    severity: 'high',
    confidence: 0.7,
    languages: '*',
    pattern: /createHash\s*\(\s*['"](?:md5|sha1)['"]\)|hashlib\.(?:md5|sha1)\s*\(|MD5\.Create\(/i,
    description: 'MD5/SHA-1 are fast and broken; using them for passwords or signatures is unsafe.',
    recommendation: 'Use bcrypt, scrypt or Argon2 for passwords, and SHA-256+ for integrity.',
    cwe: 'CWE-327',
  },
  {
    id: 'sec.insecure-random',
    category: 'security',
    type: 'weak-cryptography',
    title: 'Non-cryptographic randomness used for a security value',
    severity: 'high',
    confidence: 0.75,
    languages: '*',
    // `[^;]` rather than `[^;\n]`: the security-relevant name is often the
    // enclosing function rather than the assignment target, so the match has to
    // reach across the line. A semicolon still ends it, which keeps the match
    // inside one statement and stops an unrelated later Math.random matching.
    pattern:
      /(?:token|secret|password|otp|nonce|salt|key|session)\w*\s*[=:(][^;]{0,150}?(?:Math\.random\s*\(|random\.random\s*\(|rand\.Int\b)/i,
    description: 'Math.random and friends are predictable and must not generate secrets.',
    recommendation: 'Use crypto.randomBytes / secrets.token_urlsafe / crypto.rand.Read.',
    cwe: 'CWE-338',
  },
  {
    id: 'sec.insecure-random.id-idiom',
    category: 'security',
    type: 'weak-cryptography',
    title: 'Identifier generated from Math.random',
    severity: 'high',
    confidence: 0.8,
    languages: JS,
    // `Math.random().toString(36)` has essentially one use: generating a
    // random id or token string. Worth flagging on the idiom alone, whatever
    // the surrounding names are.
    pattern: /Math\.random\s*\(\s*\)\s*\.toString\s*\(\s*(?:36|16|32)\s*\)/,
    description:
      'This is the standard idiom for generating a random identifier, and Math.random is predictable. ' +
      'An attacker who observes a few values can predict the rest.',
    recommendation: 'Use crypto.randomUUID() or crypto.randomBytes(n).toString("hex").',
    cwe: 'CWE-338',
  },
  {
    id: 'sec.cors.wildcard',
    category: 'security',
    type: 'insecure-cors',
    title: 'CORS allows any origin',
    severity: 'medium',
    confidence: 0.8,
    languages: '*',
    pattern: /(?:Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]\*|origin\s*:\s*['"]\*['"]|origin\s*:\s*true)/,
    description: 'A wildcard/reflected origin exposes authenticated endpoints to any site.',
    recommendation: 'Set an explicit allowlist of origins, especially when credentials are enabled.',
    cwe: 'CWE-942',
  },
  {
    id: 'sec.cors.reflect',
    category: 'security',
    type: 'insecure-cors',
    title: 'CORS origin reflected from the request',
    severity: 'high',
    confidence: 0.85,
    languages: '*',
    pattern: /Access-Control-Allow-Origin['"]?\s*,\s*(?:req\.headers\.origin|request\.headers\[?['"]origin)/i,
    description: 'Reflecting the Origin header disables the same-origin policy for every site.',
    recommendation: 'Compare the origin against an allowlist before echoing it.',
    cwe: 'CWE-942',
  },
  {
    id: 'sec.tls-disabled',
    category: 'security',
    type: 'insecure-transport',
    title: 'TLS certificate validation disabled',
    severity: 'high',
    confidence: 0.9,
    languages: '*',
    pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true/,
    description: 'Disabling certificate verification makes the connection trivially interceptable.',
    recommendation: 'Keep verification on and install the correct CA bundle instead.',
    cwe: 'CWE-295',
  },
  {
    id: 'sec.sensitive-logging',
    category: 'security',
    type: 'sensitive-data-exposure',
    title: 'Sensitive value written to logs',
    severity: 'medium',
    confidence: 0.7,
    languages: '*',
    pattern: /(?:console\.(?:log|info|debug|error)|logger?\.(?:info|debug|warn|error)|print|System\.out\.println)\s*\([^)]*\b(?:password|passwd|secret|api[_-]?key|token|authorization|credit_?card|ssn)\b/i,
    description: 'Credentials or tokens reach the logs, where they persist and spread to log aggregators.',
    recommendation: 'Redact the field before logging, or log an identifier instead of the value.',
    cwe: 'CWE-532',
  },
  {
    id: 'sec.unsafe-deserialization',
    category: 'security',
    type: 'unsafe-deserialization',
    title: 'Unsafe deserialisation',
    severity: 'high',
    confidence: 0.85,
    languages: '*',
    pattern: /pickle\.loads?\s*\(|yaml\.load\s*\((?![^)]*Loader\s*=\s*yaml\.SafeLoader)|unserialize\s*\(|ObjectInputStream\s*\(/,
    description: 'Deserialising untrusted data with these APIs can execute attacker-supplied code.',
    recommendation: 'Use a safe loader (yaml.safe_load, JSON) or validate the payload before deserialising.',
    cwe: 'CWE-502',
  },
  {
    id: 'sec.mass-assignment',
    category: 'security',
    type: 'mass-assignment',
    title: 'Request body spread directly into a persistence call',
    severity: 'high',
    confidence: 0.75,
    languages: JS,
    pattern: /(?:create|update|updateOne|findOneAndUpdate|save|insert)\s*\(\s*\{?\s*(?:\.\.\.\s*req\.body|data\s*:\s*req\.body|req\.body\s*\))/,
    description: 'Writing the whole request body lets a caller set fields they should not control (roles, ownership, balances).',
    recommendation: 'Pick the allowed fields explicitly, or validate the body against a schema first.',
    cwe: 'CWE-915',
  },
  {
    id: 'sec.debug-endpoint',
    category: 'security',
    type: 'debug-endpoint',
    title: 'Debug or introspection endpoint exposed',
    severity: 'medium',
    confidence: 0.7,
    languages: '*',
    pattern: /['"]\/(?:debug|__debug|test|internal|admin\/exec|phpinfo|env|dump)[^'"]*['"]\s*,/,
    description: 'Debug endpoints commonly leak configuration or allow privileged operations.',
    recommendation: 'Remove the route or gate it behind authentication and a non-production environment check.',
    cwe: 'CWE-489',
    skipTests: true,
  },

  // ---------------------------------------------------------------------- bugs
  {
    // A credential lookup that puts the password in the query can only work if
    // the stored value is the password itself. Nothing else in the rule set
    // catches the absence of hashing - sec.weak-hash only fires when a weak
    // hash is used, so a codebase that hashes nothing at all scored clean.
    id: 'sec.password.plaintext-lookup',
    category: 'security',
    type: 'plaintext-password',
    title: 'Password compared in a database query',
    severity: 'critical',
    confidence: 0.8,
    languages: JS,
    pattern: /(?:findOne|findFirst|find|findAll|query)\s*\(\s*\{[^}]{0,160}\bpassword\b\s*[,:}]/,
    unless: /bcrypt|argon2|scrypt|pbkdf2|\bhash(?:ed|Sync|Password)?\b/i,
    description:
      'Matching on the password column means the password is stored as written. Anyone who reads the database - a backup, a log, an injection - reads every password, and users reuse them elsewhere.',
    recommendation:
      'Store a bcrypt, scrypt or Argon2 hash, look the user up by identifier alone, and compare with the algorithm-s verify function.',
    cwe: 'CWE-256',
    skipTests: true,
  },
  {
    // The sibling rule matches create/update/save/insert calls. A Mongoose or
    // Sequelize model is just as often constructed directly, which that pattern
    // never saw.
    id: 'sec.mass-assignment.constructor',
    category: 'security',
    type: 'mass-assignment',
    title: 'Request body passed straight into a model constructor',
    severity: 'high',
    confidence: 0.75,
    languages: JS,
    pattern: /new\s+[A-Z]\w*\s*\(\s*\{?\s*(?:\.\.\.\s*)?req\.body\s*[,)}]/,
    description:
      'Constructing a model from the whole request body lets a caller set any field the schema has, including roles, ownership and verification flags.',
    recommendation: 'Pick the permitted fields explicitly, or validate the body against a schema before constructing the model.',
    cwe: 'CWE-915',
    skipTests: true,
  },
  {
    // sec.cors.wildcard looks for an explicit '*'. The middleware's default is
    // already '*', so the most permissive configuration is the one with no
    // configuration at all - and it was the one that read as safe.
    id: 'sec.cors.default-open',
    category: 'security',
    type: 'insecure-cors',
    title: 'CORS middleware enabled with no options',
    severity: 'medium',
    confidence: 0.7,
    languages: JS,
    pattern: /\bcors\s*\(\s*\)/,
    description:
      'Called with no options the cors middleware answers every origin, so any site a user visits can call these endpoints with their session.',
    recommendation: 'Pass an explicit origin allowlist, and set credentials only for the origins that need it.',
    cwe: 'CWE-942',
    skipTests: true,
  },
  {
    // Found in OWASP NodeGoat: a $where clause built by interpolation. Mongo
    // evaluates that string as JavaScript, so it is remote code execution
    // against the database, and no SQL rule looks at it.
    id: 'sec.nosql-injection.where',
    category: 'security',
    type: 'nosql-injection',
    title: 'Mongo $where built from interpolated input',
    severity: 'critical',
    confidence: 0.85,
    languages: JS,
    pattern: /[$]where\s*[:=]\s*(?:`[^`]*[$]{|['"][^'"]*['"]\s*[+]|[^,}]*[+])/,
    description:
      'A $where clause is evaluated as JavaScript by the database. Anything a caller can influence in that string runs server-side with the query-s privileges.',
    recommendation: 'Express the condition with query operators ($eq, $gt, $expr) instead of $where, and never build the clause from input.',
    cwe: 'CWE-943',
    skipTests: true,
  },
  {
    // Found in appsecco/dvna: `secret: 'keyboard cat'`. The entropy scanner
    // looks for provider-shaped tokens (AKIA..., ghp_...), so a short
    // application secret in source scored clean while being just as usable.
    id: 'sec.secret.hardcoded-literal',
    category: 'security',
    type: 'hardcoded-secret',
    title: 'Signing secret written into the source',
    severity: 'high',
    confidence: 0.75,
    languages: '*',
    pattern:
      /\b(?:secret|jwt_?secret|session_?secret|token_?secret|signing_?key|api_?secret|client_?secret)\s*[:=]\s*['"`][^'"`\n]{4,}['"`]/i,
    unless:
      /process\.env|import\.meta\.env|os\.environ|getenv|config\.get|vault|secretsmanager|<[^>]+>|your[-_ ]?secret|change[-_ ]?me|placeholder|example|xxxx/i,
    description:
      'A secret in source is a secret in every clone, every fork and every build log. Sessions signed with it can be forged by anyone who reads the repository.',
    recommendation: 'Read it from the environment or a secret manager, and rotate the value that was committed - history keeps it.',
    cwe: 'CWE-798',
    skipTests: true,
  },
  {
    // Also from dvna: `cookie: { secure: false }`. Nothing looked at cookie
    // flags at all, so a session cookie sent in clear text read as fine.
    id: 'sec.cookie.insecure-flags',
    category: 'security',
    type: 'insecure-cookie',
    title: 'Session cookie sent without Secure or HttpOnly',
    severity: 'medium',
    confidence: 0.75,
    languages: JS,
    // Line-scoped on purpose. With `[^;]` the context could span lines, so the
    // match started at the word "Session" in the comment above the call and the
    // runner discarded the finding as commented out.
    pattern: /(?:cookie|session)[^;\n]{0,160}\b(?:secure|httpOnly)\s*:\s*false|\bhttpOnly\s*:\s*false/i,
    description:
      'Secure:false lets the cookie travel over plain HTTP, where anyone on the path can read the session. HttpOnly:false lets any script on the page read it.',
    recommendation: 'Set secure and httpOnly on session cookies, and sameSite unless a cross-site flow needs otherwise.',
    cwe: 'CWE-614',
    skipTests: true,
  },
  {
    id: 'bug.empty-catch',
    category: 'bug',
    type: 'swallowed-exception',
    title: 'Exception swallowed by an empty catch block',
    severity: 'medium',
    confidence: 0.9,
    languages: '*',
    pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*\}|except[^:]*:\s*\n\s*pass\b/,
    description: 'The failure is discarded, so the caller proceeds as if the operation succeeded and the cause is invisible in production.',
    recommendation: 'Log the error with context, or rethrow a domain error the caller can handle.',
    skipTests: true,
  },
  {
    id: 'bug.async-foreach',
    category: 'bug',
    type: 'async-misuse',
    title: 'Async callback passed to forEach',
    severity: 'high',
    confidence: 0.9,
    languages: JS,
    pattern: /\.forEach\s*\(\s*async\b/,
    description: 'forEach ignores the returned promises: the surrounding code continues before the work finishes and rejections go unhandled.',
    recommendation: 'Use `for...of` with await, or `await Promise.all(items.map(async ...))`.',
  },
  {
    id: 'bug.assignment-in-condition',
    category: 'bug',
    type: 'incorrect-condition',
    title: 'Assignment inside a condition',
    severity: 'high',
    confidence: 0.85,
    languages: '*',
    pattern: /\bif\s*\(\s*[A-Za-z_$][\w$.]*\s*=\s*(?!=)[^=)]/,
    description: 'The condition assigns instead of comparing, so it is almost always truthy and the branch behaves unexpectedly.',
    recommendation: 'Use === (or ==) for the comparison, or move the assignment out of the condition.',
  },
  {
    id: 'bug.parseint-no-radix',
    category: 'bug',
    type: 'type-mismatch',
    title: 'parseInt called without a radix',
    severity: 'low',
    confidence: 0.85,
    languages: JS,
    pattern: /\bparseInt\s*\(\s*[^,)]+\)/,
    description: 'Without an explicit radix, inputs such as "08" or "0x10" parse inconsistently across engines and inputs.',
    recommendation: 'Pass the radix explicitly: parseInt(value, 10).',
  },
  {
    id: 'bug.bare-except',
    category: 'bug',
    type: 'error-handling',
    title: 'Bare except catches everything',
    severity: 'medium',
    confidence: 0.9,
    languages: ['python'],
    pattern: /^\s*except\s*:/m,
    description: 'A bare except also catches KeyboardInterrupt and SystemExit, masking control-flow and real defects.',
    recommendation: 'Catch the specific exception types the block can handle.',
  },
  {
    id: 'bug.mutable-default-arg',
    category: 'bug',
    type: 'incorrect-state',
    title: 'Mutable default argument',
    severity: 'high',
    confidence: 0.95,
    languages: ['python'],
    pattern: /def\s+\w+\s*\([^)]*=\s*(?:\[\]|\{\})/,
    description: 'The default object is created once and shared by every call, so state leaks between invocations.',
    recommendation: 'Default to None and create the container inside the function body.',
  },
  {
    id: 'bug.go-ignored-error',
    category: 'bug',
    type: 'error-handling',
    title: 'Error explicitly discarded',
    severity: 'medium',
    confidence: 0.85,
    languages: ['go'],
    pattern: /^\s*_\s*[,)]?\s*=\s*[\w.]+\(/m,
    description: 'The returned error is assigned to _, so failures continue silently.',
    recommendation: 'Handle or propagate the error.',
    skipTests: true,
  },
  {
    id: 'bug.non-null-assertion',
    category: 'bug',
    type: 'null-dereference',
    title: 'Non-null assertion on a possibly-missing value',
    severity: 'medium',
    confidence: 0.6,
    languages: ['typescript', 'tsx'],
    pattern: /\)\s*!\.|\]\s*!\.|\bfind\([^)]*\)\s*!/,
    description: 'The `!` operator suppresses the compiler check; if the value is undefined at runtime this throws.',
    recommendation: 'Handle the undefined case explicitly instead of asserting.',
    skipTests: true,
  },
  {
    id: 'bug.floating-promise',
    category: 'bug',
    type: 'async-misuse',
    title: 'Promise result discarded',
    severity: 'medium',
    confidence: 0.6,
    languages: JS,
    pattern: /^\s*(?!await|return|void|const|let|var|export|import|\/\/|\*)[\w$.]+\.(?:then|catch|finally)\s*\(/m,
    description: 'The promise chain is not awaited or returned, so errors surface as unhandled rejections and ordering is not guaranteed.',
    recommendation: 'Await the promise, return it, or attach an explicit rejection handler.',
    skipTests: true,
  },

  // --------------------------------------------------------------- performance
  {
    id: 'perf.await-in-loop',
    category: 'performance',
    type: 'sequential-await',
    title: 'Await inside a loop',
    severity: 'medium',
    confidence: 0.8,
    languages: JS,
    pattern: /for\s*\((?:[^)]*)\)\s*\{[^}]{0,400}?\bawait\b/s,
    description: 'Each iteration waits for the previous one, so latency scales linearly with the collection size.',
    recommendation: 'Batch the work (Promise.all / a single bulk query) when the iterations are independent.',
  },
  {
    id: 'perf.select-star',
    category: 'performance',
    type: 'unbounded-query',
    title: 'SELECT * without a limit',
    severity: 'medium',
    confidence: 0.7,
    languages: '*',
    pattern: /SELECT\s+\*\s+FROM\s+[\w."`]+(?![\s\S]{0,120}\b(?:LIMIT|TOP|FETCH FIRST)\b)/i,
    description: 'The query reads every column of every row; result size grows without bound as the table grows.',
    recommendation: 'Select the needed columns and add pagination (LIMIT/OFFSET or keyset).',
  },
  {
    id: 'perf.findmany-unbounded',
    category: 'performance',
    type: 'unbounded-query',
    title: 'Collection query with no pagination',
    severity: 'medium',
    confidence: 0.6,
    languages: JS,
    pattern: /\.(?:findMany|findAll|find)\s*\(\s*(?:\{\s*\}|\)|\{\s*where[^}]*\}\s*\))/,
    description: 'No take/limit is applied, so the result set grows with the table and can exhaust memory.',
    recommendation: 'Add a take/limit with pagination, and cap the maximum page size.',
    skipTests: true,
  },
  {
    id: 'perf.sync-fs-in-handler',
    category: 'performance',
    type: 'blocking-io',
    title: 'Synchronous filesystem call',
    severity: 'medium',
    confidence: 0.75,
    languages: JS,
    pattern: /\b(?:readFileSync|writeFileSync|readdirSync|existsSync)\s*\(/,
    description: 'Synchronous I/O blocks the event loop for every concurrent request while the disk responds.',
    recommendation: 'Use the promise-based API, or read once at startup and cache the result.',
    skipTests: true,
    unless: /(?:^|\/)(?:config|env|bootstrap|setup|scripts?)/i,
  },
  {
    id: 'perf.json-deep-clone',
    category: 'performance',
    type: 'inefficient-algorithm',
    title: 'Deep clone via JSON round-trip',
    severity: 'low',
    confidence: 0.85,
    languages: JS,
    pattern: /JSON\.parse\s*\(\s*JSON\.stringify\s*\(/,
    description: 'Serialising to JSON and back is slow, drops non-JSON values (Date, Map, undefined) and allocates twice.',
    recommendation: 'Use structuredClone() or an explicit copy of the fields you need.',
  },
  {
    id: 'perf.barrel-import',
    category: 'performance',
    type: 'bundle-size',
    title: 'Whole-library import',
    severity: 'low',
    confidence: 0.8,
    languages: JS,
    pattern: /import\s+(?:\*\s+as\s+)?_\s+from\s+['"]lodash['"]|import\s+\{[^}]+\}\s+from\s+['"]lodash['"]|require\s*\(\s*['"]lodash['"]\s*\)/,
    description: 'Importing the entire library pulls every module into the bundle even though a few helpers are used.',
    recommendation: "Import the specific module (`lodash/debounce`) or use the platform equivalent.",
  },
  {
    id: 'perf.react-effect-no-deps',
    category: 'performance',
    type: 'react-rerender',
    title: 'useEffect without a dependency array',
    severity: 'medium',
    confidence: 0.85,
    languages: ['tsx', 'jsx', 'typescript', 'javascript'],
    pattern: /useEffect\s*\(\s*(?:\(\)|async\s*\(\))\s*=>\s*\{[\s\S]{0,600}?\}\s*\)\s*;/,
    description: 'The effect runs after every render. If it sets state or fetches, it can loop or hammer the network.',
    recommendation: 'Pass a dependency array listing exactly what the effect reads.',
  },

  // ------------------------------------------------------------------- quality
  {
    id: 'quality.todo-marker',
    category: 'quality',
    type: 'unfinished-work',
    title: 'TODO/FIXME marker in source',
    severity: 'info',
    confidence: 1,
    languages: '*',
    pattern: /\b(?:TODO|FIXME|HACK|XXX)\b[:\s]/,
    description: 'The code marks work that was left unfinished.',
    recommendation: 'Resolve it or track it in the issue tracker with a link.',
    skipTests: true,
  },
  {
    id: 'quality.console-log',
    category: 'quality',
    type: 'debug-output',
    title: 'Debug logging left in source',
    severity: 'info',
    confidence: 0.9,
    languages: JS,
    pattern: /\bconsole\.(?:log|debug)\s*\(/,
    description: 'Ad-hoc console output bypasses the structured logger and is noisy in production.',
    recommendation: 'Use the application logger, or remove the statement.',
    skipTests: true,
  },
];

const MAX_PER_RULE_PER_FILE = 8;

/** Run the deterministic rule set over one file. */
export function runStaticRules(file: AnalyzableFile): AnalysisFindingDraft[] {
  if (file.isGenerated) return [];
  const findings: AnalysisFindingDraft[] = [];
  const lines = file.content.split('\n');

  for (const rule of STATIC_RULES) {
    if (rule.skipTests && file.isTest) continue;
    if (rule.languages !== '*' && !rule.languages.includes(file.language)) continue;

    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const pattern = new RegExp(rule.pattern.source, flags);
    let match: RegExpExecArray | null;
    let count = 0;

    while ((match = pattern.exec(file.content)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex++;
        continue;
      }
      const matchStart = lineAt(file.content, match.index);
      const matchEnd = lineAt(file.content, match.index + match[0].length);

      // Anchor to the first line of the match that is real code. A pattern
      // whose leading token is an ordinary word - session, secret, password -
      // will happily begin inside the comment that introduces the call it is
      // about, and anchoring there discarded the finding as commented out
      // while the offending line sat a few rows below, inside the same match.
      let startLine = matchStart;
      while (startLine <= matchEnd && isCommentedOut(lines[startLine - 1] ?? '', file.language)) startLine++;
      if (startLine > matchEnd) continue;
      const lineText = lines[startLine - 1] ?? '';
      if (rule.unless && (rule.unless.test(lineText) || rule.unless.test(file.path))) continue;

      const endLine = Math.min(lines.length, Math.max(matchEnd, startLine));

      findings.push({
        category: rule.category,
        ruleId: rule.id,
        type: rule.type,
        severity: rule.severity,
        title: rule.title,
        description: rule.description,
        evidence: `Matched in ${file.path}:${startLine} — ${lineText.trim().slice(0, 200)}`,
        recommendation: rule.recommendation,
        filePath: file.path,
        startLine,
        endLine,
        snippet: lines.slice(Math.max(0, startLine - 2), Math.min(lines.length, endLine + 2)).join('\n').slice(0, 1200),
        confidence: rule.confidence,
        confidenceLabel: rule.confidence >= 0.8 ? 'high' : rule.confidence >= 0.55 ? 'medium' : 'low',
        status: rule.confidence >= 0.9 ? 'confirmed' : 'likely',
        source: 'static',
        ...(rule.cwe ? { cwe: rule.cwe } : {}),
        metadata: { detector: 'static-rule', rule: rule.id },
      });

      if (++count >= MAX_PER_RULE_PER_FILE) break;
    }
  }

  return findings;
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

function isCommentedOut(line: string, language: string): boolean {
  const trimmed = line.trim();
  if (language === 'python' || language === 'ruby' || language === 'shell' || language === 'yaml') {
    return trimmed.startsWith('#');
  }
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}
