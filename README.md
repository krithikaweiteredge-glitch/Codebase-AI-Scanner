# Codebase AI — Codebase Intelligence & Review Platform

An AI-powered codebase intelligence, automated review, and security analysis platform built with Fastify, React, PostgreSQL (`pgvector`), and multi-provider LLMs.

---

## ⚡ Key Features

- **Multi-Model AI Support:** Native integrations with **Google Gemini**, **Groq**, **Anthropic Claude**, **OpenAI**, and an offline **Local fallback**.
- **Hybrid Retrieval-Augmented Generation (RAG):** Combines `pgvector` dense vector embeddings, `pg_trgm` lexical search, and AST symbol resolution so every AI response cites verifiable code lines.
- **Automated Security & Bug Scanner:** Deterministic static analysis, high-entropy secret detection, and LLM reasoning for finding vulnerabilities and edge-case defects.
- **Code Explorer with Monaco Editor:** VS Code editor in the browser with full syntax highlighting, symbol navigation, and file tree browsing.
- **Automated PR Reviews:** Automated pull request scanning with line-by-line comments, summaries, and impact analysis.
- **Architecture & Dependency Visualizer:** Mermaid.js diagrams showing module dependencies, data models, and component hierarchies.
- **Test Generation:** Automated test suggestion engine generating unit test suites for functions and classes.

---

## 🛠️ Technology Stack

For an in-depth breakdown of every technology and the architectural rationale, see [**`docs/TECH_STACK.md`**](./docs/TECH_STACK.md).

- **Frontend:** React 18, TypeScript, Vite 7, Tailwind CSS, Monaco Editor, Mermaid.js, TanStack React Query, Lucide Icons.
- **Backend:** Node.js (>=20), Fastify 5, Prisma ORM 6, Zod, Fastify Helmet/CORS/Rate-Limit/Cookie.
- **Database:** PostgreSQL 16+ with `pgvector` (vector embeddings) and `pg_trgm` (trigram text search).
- **Testing & Tools:** Vitest 3, Testing Library, npm workspaces, Docker Compose.

---

## 🚀 Quickstart

### 1. Prerequisites
- Node.js >= 20.11
- PostgreSQL 16+ with `pgvector` (via Docker or cloud DB like Neon / Supabase)

### 2. Setup Environment
```bash
cp .env.example .env
```
Generate an encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Add your database URL and chosen AI provider key (e.g. Gemini, Groq, Anthropic, or OpenAI) in `.env`.

### 3. Run Migrations & Seed
```bash
npm run db:migrate
npm run db:seed
```
*(Seeds default user: `developer@example.com` / `password123`)*

### 4. Start Development Server
```bash
npm run dev
```
- **Web Interface:** [http://localhost:5173](http://localhost:5173)
- **API Server:** [http://localhost:4000](http://localhost:4000)

---

## 🧪 Testing & Build

```bash
# Run all backend and frontend tests
npm test

# Run TypeScript typechecks
npm run typecheck

# Production build
npm run build
```
