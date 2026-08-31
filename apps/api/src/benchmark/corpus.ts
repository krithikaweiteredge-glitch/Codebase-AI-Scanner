/**
 * Labelled corpus for measuring detection.
 *
 * Three kinds of case, and all three matter:
 *
 *  - `vulnerable`  code that must be reported. Misses are false negatives.
 *  - `safe`        the correct version of the same pattern. Reports here are
 *                  false positives, which is the number that decides whether
 *                  anyone keeps using the tool.
 *  - `known-miss`  code that is genuinely vulnerable and that the deterministic
 *                  detectors are not expected to catch, because catching it
 *                  needs dataflow or intent. These are not failures - they are
 *                  the blind spots, written down so they stay visible and so a
 *                  future engine can be measured against them.
 *
 * The corpus is deliberately local and offline: it runs in CI in under a
 * second and needs no model, network or checkout.
 */

import type { Language } from '../indexer/languages';

export type CaseKind = 'vulnerable' | 'safe' | 'known-miss';

export interface BenchmarkCase {
  id: string;
  kind: CaseKind;
  /** CWE the case is about. Used to group the report. */
  cwe: string;
  language: Language;
  path: string;
  code: string;
  /** Why a known-miss is missed. Required for that kind, so the gap is explained. */
  note?: string;
}

const js = (path: string) => path;

export const CORPUS: BenchmarkCase[] = [
  // ------------------------------------------------------------------ CWE-89
  {
    id: 'sqli-template-js',
    kind: 'vulnerable',
    cwe: 'CWE-89',
    language: 'typescript',
    path: js('src/repo/users.ts'),
    code: [
      'export async function findUser(id: string) {',
      '  return db.query(`SELECT * FROM users WHERE id = ${id}`);',
      '}',
    ].join('\n'),
  },
  {
    id: 'sqli-concat-js',
    kind: 'vulnerable',
    cwe: 'CWE-89',
    language: 'typescript',
    path: js('src/repo/search.ts'),
    code: ['export function search(req: Request) {', '  const sql = "SELECT * FROM t WHERE n = \'" + req.body.name;', '  return db.query(sql);', '}'].join('\n'),
  },
  {
    id: 'sqli-python-fstring',
    kind: 'vulnerable',
    cwe: 'CWE-89',
    language: 'python',
    path: 'app/repo.py',
    code: ['def find(cursor, uid):', '    cursor.execute(f"SELECT * FROM users WHERE id = {uid}")'].join('\n'),
  },
  {
    id: 'sqli-parameterised-js',
    kind: 'safe',
    cwe: 'CWE-89',
    language: 'typescript',
    path: js('src/repo/safe.ts'),
    code: ['export async function findUser(id: string) {', '  return db.query("SELECT * FROM users WHERE id = $1", [id]);', '}'].join('\n'),
  },
  {
    id: 'sqli-parameterised-python',
    kind: 'safe',
    cwe: 'CWE-89',
    language: 'python',
    path: 'app/safe.py',
    code: ['def find(cursor, uid):', '    cursor.execute("SELECT * FROM users WHERE id = %s", (uid,))'].join('\n'),
  },
  {
    id: 'sqli-interprocedural',
    kind: 'known-miss',
    cwe: 'CWE-89',
    language: 'typescript',
    path: js('src/repo/indirect.ts'),
    note:
      'The taint crosses a function boundary; single-line patterns cannot follow it. ' +
      'The variable is deliberately NOT named something in the concat rule\'s identifier ' +
      'list, so this stays a real dataflow test rather than a naming coincidence.',
    code: [
      'function buildWhere(value: string) {',
      '  return "SELECT * FROM users WHERE label = \'" + value + "\'";',
      '}',
      'export function handler(req: Request) {',
      '  const clause = buildWhere(req.body.label);',
      '  return db.query(clause);',
      '}',
    ].join('\n'),
  },

  // ------------------------------------------------------------------ CWE-78
  {
    id: 'cmdi-exec-js',
    kind: 'vulnerable',
    cwe: 'CWE-78',
    language: 'typescript',
    path: js('src/jobs/run.ts'),
    code: ['import { exec } from "node:child_process";', 'export function run(name: string) {', '  exec(`ls ${name}`);', '}'].join('\n'),
  },
  {
    id: 'cmdi-python',
    kind: 'vulnerable',
    cwe: 'CWE-78',
    language: 'python',
    path: 'app/run.py',
    code: ['import os', 'def run(name):', '    os.system("ls " + name)'].join('\n'),
  },
  {
    id: 'cmdi-execfile-args',
    kind: 'safe',
    cwe: 'CWE-78',
    language: 'typescript',
    path: js('src/jobs/safe.ts'),
    code: ['import { execFile } from "node:child_process";', 'export function run(name: string) {', '  execFile("ls", [name]);', '}'].join('\n'),
  },

  // ------------------------------------------------------------------ CWE-95
  {
    id: 'eval-dynamic',
    kind: 'vulnerable',
    cwe: 'CWE-95',
    language: 'typescript',
    path: js('src/lib/calc.ts'),
    code: ['export function calc(expr: string) {', '  return eval(expr);', '}'].join('\n'),
  },

  // ------------------------------------------------------------------ CWE-79
  {
    id: 'xss-dangerously-set',
    kind: 'vulnerable',
    cwe: 'CWE-79',
    language: 'tsx',
    path: js('src/components/Bio.tsx'),
    code: ['export function Bio({ html }: { html: string }) {', '  return <div dangerouslySetInnerHTML={{ __html: html }} />;', '}'].join('\n'),
  },
  {
    id: 'xss-escaped-text',
    kind: 'safe',
    cwe: 'CWE-79',
    language: 'tsx',
    path: js('src/components/SafeBio.tsx'),
    code: ['export function Bio({ text }: { text: string }) {', '  return <div>{text}</div>;', '}'].join('\n'),
  },

  // ------------------------------------------------------------------ CWE-22
  {
    id: 'path-traversal-join',
    kind: 'vulnerable',
    cwe: 'CWE-22',
    language: 'typescript',
    path: js('src/routes/download.ts'),
    code: [
      'import * as fs from "node:fs";',
      'export function download(req: Request) {',
      '  return fs.readFileSync(path.join("/data", req.query.file as string));',
      '}',
    ].join('\n'),
  },

  // ----------------------------------------------------------------- CWE-918
  {
    id: 'ssrf-fetch-user-url',
    kind: 'vulnerable',
    cwe: 'CWE-918',
    language: 'typescript',
    path: js('src/routes/proxy.ts'),
    code: ['export async function proxy(req: Request) {', '  return fetch(req.query.url as string);', '}'].join('\n'),
  },

  // ----------------------------------------------------------------- CWE-347
  {
    id: 'jwt-decode-unverified',
    kind: 'vulnerable',
    cwe: 'CWE-347',
    language: 'typescript',
    path: js('src/auth/token.ts'),
    code: ['import jwt from "jsonwebtoken";', 'export function who(token: string) {', '  return jwt.decode(token);', '}'].join('\n'),
  },
  {
    id: 'jwt-verified',
    kind: 'safe',
    cwe: 'CWE-347',
    language: 'typescript',
    path: js('src/auth/safeToken.ts'),
    code: ['import jwt from "jsonwebtoken";', 'export function who(token: string) {', '  return jwt.verify(token, process.env.SECRET as string);', '}'].join('\n'),
  },

  // ----------------------------------------------------------------- CWE-327
  {
    id: 'weak-hash-md5',
    kind: 'vulnerable',
    cwe: 'CWE-327',
    language: 'typescript',
    path: js('src/lib/hash.ts'),
    code: ['import { createHash } from "node:crypto";', 'export function h(p: string) {', '  return createHash("md5").update(p).digest("hex");', '}'].join('\n'),
  },

  // ----------------------------------------------------------------- CWE-338
  {
    id: 'insecure-random-token',
    kind: 'vulnerable',
    cwe: 'CWE-338',
    language: 'typescript',
    path: js('src/lib/token.ts'),
    code: ['export function token() {', '  return Math.random().toString(36).slice(2);', '}'].join('\n'),
  },

  // Guards for the broadened insecure-random rule: non-security randomness
  // must stay unreported, or the rule becomes noise.
  {
    id: 'random-jitter-not-a-secret',
    kind: 'safe',
    cwe: 'CWE-338',
    language: 'typescript',
    path: js('src/lib/backoff.ts'),
    code: ['export function backoff(attempt: number) {', '  return 1000 * 2 ** attempt * (0.5 + Math.random() * 0.5);', '}'].join('\n'),
  },
  {
    id: 'random-array-shuffle',
    kind: 'safe',
    cwe: 'CWE-338',
    language: 'typescript',
    path: js('src/lib/shuffle.ts'),
    code: ['export function pick<T>(items: T[]) {', '  return items[Math.floor(Math.random() * items.length)];', '}'].join('\n'),
  },
  {
    id: 'random-crypto-token',
    kind: 'safe',
    cwe: 'CWE-338',
    language: 'typescript',
    path: js('src/lib/safeToken.ts'),
    code: ['import { randomBytes } from "node:crypto";', 'export function token() {', '  return randomBytes(32).toString("hex");', '}'].join('\n'),
  },
  // Guard for the broadened SQL concat rule.
  {
    id: 'sql-concat-of-constants',
    kind: 'safe',
    cwe: 'CWE-89',
    language: 'typescript',
    path: js('src/repo/constants.ts'),
    code: ['const BASE = "SELECT id, name FROM users";', 'export const withOrder = BASE + " ORDER BY name";'].join('\n'),
  },

  // ----------------------------------------------------------------- CWE-942
  {
    id: 'cors-wildcard-credentials',
    kind: 'vulnerable',
    cwe: 'CWE-942',
    language: 'typescript',
    path: js('src/app/cors.ts'),
    code: ['app.use(cors({ origin: "*", credentials: true }));'].join('\n'),
  },

  // ----------------------------------------------------------------- CWE-295
  {
    id: 'tls-verification-disabled',
    kind: 'vulnerable',
    cwe: 'CWE-295',
    language: 'typescript',
    path: js('src/lib/http.ts'),
    code: ['process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";'].join('\n'),
  },

  // ----------------------------------------------------------------- CWE-502
  {
    id: 'unsafe-deserialization-python',
    kind: 'vulnerable',
    cwe: 'CWE-502',
    language: 'python',
    path: 'app/load.py',
    code: ['import pickle', 'def load(blob):', '    return pickle.loads(blob)'].join('\n'),
  },

  // ----------------------------------------------------------------- CWE-798
  {
    id: 'hardcoded-aws-key',
    kind: 'vulnerable',
    cwe: 'CWE-798',
    language: 'typescript',
    path: js('src/config/aws.ts'),
    code: ['export const config = {', '  accessKeyId: "AKIAIOSFODNN7EXAMPLE",', '};'].join('\n'),
  },
  {
    id: 'secret-from-env',
    kind: 'safe',
    cwe: 'CWE-798',
    language: 'typescript',
    path: js('src/config/safe.ts'),
    code: ['export const config = {', '  accessKeyId: process.env.AWS_ACCESS_KEY_ID,', '};'].join('\n'),
  },

  // ------------------------------------------------- known blind spots
  {
    id: 'auth-missing-ownership-check',
    kind: 'known-miss',
    cwe: 'CWE-639',
    language: 'typescript',
    path: js('src/routes/doc.ts'),
    note: 'IDOR. Requires knowing that a document belongs to a user - intent, not syntax.',
    code: [
      'app.get("/api/documents/:id", async (req, res) => {',
      '  const doc = await prisma.document.findUnique({ where: { id: req.params.id } });',
      '  return res.send(doc);',
      '});',
    ].join('\n'),
  },
  {
    id: 'signature-check-fails-open',
    kind: 'known-miss',
    cwe: 'CWE-347',
    language: 'typescript',
    path: js('src/webhook/verify.ts'),
    note: 'The exact bug found by hand in this codebase: returns true when unconfigured. Needs intent.',
    code: [
      'export function verifySignature(payload: string, signature?: string) {',
      '  if (!process.env.WEBHOOK_SECRET) return true;',
      '  if (!signature) return false;',
      '  return hmac(payload) === signature;',
      '}',
    ].join('\n'),
  },
  {
    id: 'race-condition-check-then-act',
    kind: 'known-miss',
    cwe: 'CWE-367',
    language: 'typescript',
    path: js('src/wallet/withdraw.ts'),
    note: 'TOCTOU across an await. Needs concurrency reasoning.',
    code: [
      'export async function withdraw(userId: string, amount: number) {',
      '  const balance = await getBalance(userId);',
      '  if (balance < amount) throw new Error("insufficient");',
      '  await debit(userId, amount);',
      '}',
    ].join('\n'),
  },
  {
    id: 'wrong-comparison-operator',
    kind: 'known-miss',
    cwe: 'CWE-697',
    language: 'typescript',
    path: js('src/auth/role.ts'),
    note: 'Logic inversion. Syntactically perfect; only a spec says which way it should go.',
    code: ['export function canDelete(role: string) {', '  return role !== "admin";', '}'].join('\n'),
  },
];

export function corpusByKind(kind: CaseKind): BenchmarkCase[] {
  return CORPUS.filter((entry) => entry.kind === kind);
}
