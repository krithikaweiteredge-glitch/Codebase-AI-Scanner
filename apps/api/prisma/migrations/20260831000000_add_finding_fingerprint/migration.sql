-- Stable identity for findings, so user triage survives re-analysis.
--
-- Every analysis run deletes the branch's findings and rebuilds them, which
-- also threw away `false_positive` and `resolved`. A dismissed finding came
-- straight back on the next scan. The fingerprint is derived from the rule,
-- the file and the matched code - never the line number - so the new finding
-- can be recognised as the same one and the triage re-applied.
--
-- Existing rows get NULL: they predate fingerprinting and are replaced by the
-- next run anyway. The column stays nullable so a detector that cannot produce
-- a meaningful identity is still storable.
--
-- NOTE: `prisma migrate diff` also reports the trigram indexes from
-- 20250101000100_search_indexes as drift, because Prisma cannot model
-- expression indexes. They are deliberately kept and must not be dropped.

-- AlterTable
ALTER TABLE "analysis_findings" ADD COLUMN     "fingerprint" TEXT;

-- CreateIndex
CREATE INDEX "analysis_findings_repository_id_fingerprint_idx" ON "analysis_findings"("repository_id", "fingerprint");
