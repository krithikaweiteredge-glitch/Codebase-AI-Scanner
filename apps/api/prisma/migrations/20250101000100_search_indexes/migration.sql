-- Search acceleration: vector ANN index, trigram indexes for identifier search,
-- full-text indexes for keyword search, plus category views over analysis_findings.
--
-- NOTE: these objects are intentionally not represented in schema.prisma
-- (Prisma cannot model expression indexes / views). Apply migrations with
-- `npm run db:deploy` (prisma migrate deploy) rather than `prisma migrate dev`.

-- Approximate nearest neighbour over code chunk embeddings (cosine distance).
CREATE INDEX IF NOT EXISTS "code_chunks_embedding_hnsw_idx"
    ON "code_chunks" USING hnsw ("embedding" vector_cosine_ops);

-- Keyword / identifier search over chunk bodies and symbol names.
CREATE INDEX IF NOT EXISTS "code_chunks_content_trgm_idx"
    ON "code_chunks" USING gin ("content" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "code_chunks_symbol_name_trgm_idx"
    ON "code_chunks" USING gin ("symbol_name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "code_symbols_name_trgm_idx"
    ON "code_symbols" USING gin ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "repository_files_path_trgm_idx"
    ON "repository_files" USING gin ("path" gin_trgm_ops);

-- Full text search over chunk bodies.
CREATE INDEX IF NOT EXISTS "code_chunks_content_fts_idx"
    ON "code_chunks" USING gin (to_tsvector('english', "content"));

-- Category views (the platform stores every finding in one normalised table;
-- these views keep the per-category names from the data model spec usable).
CREATE OR REPLACE VIEW "security_findings" AS
    SELECT * FROM "analysis_findings" WHERE "category" = 'security';
CREATE OR REPLACE VIEW "bug_findings" AS
    SELECT * FROM "analysis_findings" WHERE "category" = 'bug';
CREATE OR REPLACE VIEW "performance_findings" AS
    SELECT * FROM "analysis_findings" WHERE "category" = 'performance';
CREATE OR REPLACE VIEW "duplicate_findings" AS
    SELECT * FROM "analysis_findings" WHERE "category" = 'duplicate';
CREATE OR REPLACE VIEW "quality_findings" AS
    SELECT * FROM "analysis_findings" WHERE "category" = 'quality';
