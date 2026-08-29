-- Codebase Intelligence Platform :: initial schema
-- Requires PostgreSQL 14+ with the `vector` (pgvector) and `pg_trgm` extensions.

CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password_hash" TEXT NOT NULL,
    "avatar_url" TEXT,
    "github_login" TEXT,
    "github_user_id" TEXT,
    "github_token_enc" TEXT,
    "github_token_scope" TEXT,
    "github_linked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "oauth_states" (
    "id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "redirect" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "oauth_states_state_key" ON "oauth_states"("state");

-- ---------------------------------------------------------------------------
-- Repositories
-- ---------------------------------------------------------------------------

CREATE TABLE "repositories" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'github',
    "github_id" TEXT,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "description" TEXT,
    "html_url" TEXT,
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "default_branch" TEXT NOT NULL DEFAULT 'main',
    "size_kb" INTEGER,
    "primary_language" TEXT,
    "language_stats" JSONB,
    "ignore_patterns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_analyzed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "repositories_user_id_full_name_key" ON "repositories"("user_id", "full_name");
CREATE INDEX "repositories_user_id_idx" ON "repositories"("user_id");
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "repository_branches" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "commit_sha" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "indexed_sha" TEXT,
    "indexed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "repository_branches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "repository_branches_repository_id_name_key" ON "repository_branches"("repository_id", "name");
ALTER TABLE "repository_branches" ADD CONSTRAINT "repository_branches_repository_id_fkey"
    FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "repository_commits" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "sha" TEXT NOT NULL,
    "branch_name" TEXT,
    "message" TEXT,
    "author_name" TEXT,
    "author_email" TEXT,
    "committed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "repository_commits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "repository_commits_repository_id_sha_key" ON "repository_commits"("repository_id", "sha");
CREATE INDEX "repository_commits_repository_id_committed_at_idx" ON "repository_commits"("repository_id", "committed_at");
ALTER TABLE "repository_commits" ADD CONSTRAINT "repository_commits_repository_id_fkey"
    FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "repository_files" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "extension" TEXT,
    "language" TEXT,
    "role" TEXT,
    "size_bytes" INTEGER NOT NULL,
    "line_count" INTEGER NOT NULL,
    "blob_sha" TEXT,
    "content_hash" TEXT NOT NULL,
    "content" TEXT,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "is_test" BOOLEAN NOT NULL DEFAULT false,
    "is_config" BOOLEAN NOT NULL DEFAULT false,
    "is_generated" BOOLEAN NOT NULL DEFAULT false,
    "has_secrets" BOOLEAN NOT NULL DEFAULT false,
    "complexity" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "repository_files_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "repository_files_branch_id_path_key" ON "repository_files"("branch_id", "path");
CREATE INDEX "repository_files_repository_id_language_idx" ON "repository_files"("repository_id", "language");
CREATE INDEX "repository_files_repository_id_role_idx" ON "repository_files"("repository_id", "role");
ALTER TABLE "repository_files" ADD CONSTRAINT "repository_files_repository_id_fkey"
    FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "repository_files" ADD CONSTRAINT "repository_files_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "repository_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "code_chunks" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "symbol_name" TEXT,
    "symbol_type" TEXT,
    "start_line" INTEGER NOT NULL,
    "end_line" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "token_count" INTEGER NOT NULL DEFAULT 0,
    "embedding" vector(1536),
    "embedding_model" TEXT,
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "code_chunks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "code_chunks_repository_id_idx" ON "code_chunks"("repository_id");
CREATE INDEX "code_chunks_file_id_idx" ON "code_chunks"("file_id");
ALTER TABLE "code_chunks" ADD CONSTRAINT "code_chunks_repository_id_fkey"
    FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "code_chunks" ADD CONSTRAINT "code_chunks_file_id_fkey"
    FOREIGN KEY ("file_id") REFERENCES "repository_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "code_symbols" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "signature" TEXT,
    "parent_name" TEXT,
    "start_line" INTEGER NOT NULL,
    "end_line" INTEGER NOT NULL,
    "exported" BOOLEAN NOT NULL DEFAULT false,
    "is_async" BOOLEAN NOT NULL DEFAULT false,
    "complexity" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "code_symbols_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "code_symbols_repository_id_name_idx" ON "code_symbols"("repository_id", "name");
CREATE INDEX "code_symbols_file_id_idx" ON "code_symbols"("file_id");
ALTER TABLE "code_symbols" ADD CONSTRAINT "code_symbols_repository_id_fkey"
    FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "code_symbols" ADD CONSTRAINT "code_symbols_file_id_fkey"
    FOREIGN KEY ("file_id") REFERENCES "repository_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "dependencies" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "from_file_id" UUID NOT NULL,
    "to_file_id" UUID,
    "specifier" TEXT NOT NULL,
    "is_external" BOOLEAN NOT NULL DEFAULT false,
    "kind" TEXT NOT NULL DEFAULT 'import',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dependencies_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "dependencies_repository_id_idx" ON "dependencies"("repository_id");
CREATE INDEX "dependencies_from_file_id_idx" ON "dependencies"("from_file_id");
CREATE INDEX "dependencies_to_file_id_idx" ON "dependencies"("to_file_id");
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_repository_id_fkey"
    FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_from_file_id_fkey"
    FOREIGN KEY ("from_file_id") REFERENCES "repository_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_to_file_id_fkey"
    FOREIGN KEY ("to_file_id") REFERENCES "repository_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Analysis
-- ---------------------------------------------------------------------------

CREATE TABLE "analysis_runs" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "branch_id" UUID,
    "commit_sha" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'full',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "steps" JSONB DEFAULT '[]',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "stats" JSONB,
    "error" TEXT,
    "ai_provider" TEXT,
    "ai_model" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "analysis_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "analysis_runs_repository_id_created_at_idx" ON "analysis_runs"("repository_id", "created_at");
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_repository_id_fkey"
    FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "repository_branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "pull_requests" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "state" TEXT NOT NULL,
    "author_login" TEXT,
    "head_ref" TEXT,
    "head_sha" TEXT,
    "base_ref" TEXT,
    "base_sha" TEXT,
    "url" TEXT,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "changed_files" INTEGER NOT NULL DEFAULT 0,
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "gh_created_at" TIMESTAMP(3),
    "gh_updated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "pull_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pull_requests_repository_id_number_key" ON "pull_requests"("repository_id", "number");
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repository_id_fkey"
    FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "pull_request_reviews" (
    "id" UUID NOT NULL,
    "pull_request_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "verdict" TEXT,
    "counts" JSONB,
    "model" TEXT,
    "provider" TEXT,
    "posted_to_github" BOOLEAN NOT NULL DEFAULT false,
    "github_comment_url" TEXT,
    "posted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pull_request_reviews_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pull_request_reviews_pull_request_id_idx" ON "pull_request_reviews"("pull_request_id");
ALTER TABLE "pull_request_reviews" ADD CONSTRAINT "pull_request_reviews_pull_request_id_fkey"
    FOREIGN KEY ("pull_request_id") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "analysis_findings" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "run_id" UUID,
    "file_id" UUID,
    "review_id" UUID,
    "category" TEXT NOT NULL,
    "rule_id" TEXT,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" TEXT,
    "recommendation" TEXT,
    "file_path" TEXT,
    "start_line" INTEGER,
    "end_line" INTEGER,
    "snippet" TEXT,
    "related_file_path" TEXT,
    "related_start_line" INTEGER,
    "related_end_line" INTEGER,
    "similarity" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "confidence_label" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'potential',
    "source" TEXT NOT NULL DEFAULT 'static',
    "cwe" TEXT,
    "false_positive" BOOLEAN NOT NULL DEFAULT false,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "analysis_findings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "analysis_findings_repository_id_category_severity_idx" ON "analysis_findings"("repository_id", "category", "severity");
CREATE INDEX "analysis_findings_run_id_idx" ON "analysis_findings"("run_id");
CREATE INDEX "analysis_findings_review_id_idx" ON "analysis_findings"("review_id");
ALTER TABLE "analysis_findings" ADD CONSTRAINT "analysis_findings_repository_id_fkey"
    FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "analysis_findings" ADD CONSTRAINT "analysis_findings_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "analysis_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "analysis_findings" ADD CONSTRAINT "analysis_findings_file_id_fkey"
    FOREIGN KEY ("file_id") REFERENCES "repository_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "analysis_findings" ADD CONSTRAINT "analysis_findings_review_id_fkey"
    FOREIGN KEY ("review_id") REFERENCES "pull_request_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "repository_insights" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "repository_insights_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "repository_insights_repository_id_kind_key" ON "repository_insights"("repository_id", "kind");
ALTER TABLE "repository_insights" ADD CONSTRAINT "repository_insights_repository_id_fkey"
    FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Documentation / tests
-- ---------------------------------------------------------------------------

CREATE TABLE "documentation" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "run_id" UUID,
    "section" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content_md" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "sources" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "documentation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "documentation_repository_id_section_key" ON "documentation"("repository_id", "section");
ALTER TABLE "documentation" ADD CONSTRAINT "documentation_repository_id_fkey"
    FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "documentation" ADD CONSTRAINT "documentation_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "analysis_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "test_suggestions" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "file_id" UUID,
    "target" TEXT NOT NULL,
    "target_kind" TEXT NOT NULL DEFAULT 'function',
    "framework" TEXT NOT NULL,
    "cases" JSONB NOT NULL,
    "code" TEXT,
    "rationale" TEXT,
    "file_path" TEXT,
    "start_line" INTEGER,
    "end_line" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "test_suggestions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "test_suggestions_repository_id_idx" ON "test_suggestions"("repository_id");
ALTER TABLE "test_suggestions" ADD CONSTRAINT "test_suggestions_repository_id_fkey"
    FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_suggestions" ADD CONSTRAINT "test_suggestions_file_id_fkey"
    FOREIGN KEY ("file_id") REFERENCES "repository_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Chat
-- ---------------------------------------------------------------------------

CREATE TABLE "chat_sessions" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New conversation',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "chat_sessions_repository_id_user_id_idx" ON "chat_sessions"("repository_id", "user_id");
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_repository_id_fkey"
    FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "citations" JSONB,
    "context_chunk_ids" JSONB,
    "grounding_score" DOUBLE PRECISION,
    "provider" TEXT,
    "model" TEXT,
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "chat_messages_session_id_created_at_idx" ON "chat_messages"("session_id", "created_at");
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
