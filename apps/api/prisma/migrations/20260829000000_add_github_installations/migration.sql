-- GitHub App installation support. The models existed in schema.prisma but no
-- migration was ever generated for them, so deployed databases were missing
-- `github_installations` and `repositories.installation_id` entirely.
--
-- NOTE: `prisma migrate diff` also reports the trigram indexes from
-- 20250101000100_search_indexes as drift, because Prisma cannot model
-- expression indexes. They are deliberately kept and must not be dropped.

-- AlterTable
ALTER TABLE "repositories" ADD COLUMN     "installation_id" TEXT;

-- CreateTable
CREATE TABLE "github_installations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "installation_id" TEXT NOT NULL,
    "account_login" TEXT NOT NULL,
    "account_type" TEXT NOT NULL DEFAULT 'User',
    "account_avatar" TEXT,
    "repository_selection" TEXT NOT NULL DEFAULT 'all',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_installations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_installations_installation_id_key" ON "github_installations"("installation_id");

-- CreateIndex
CREATE INDEX "github_installations_user_id_idx" ON "github_installations"("user_id");

-- CreateIndex
CREATE INDEX "repositories_installation_id_idx" ON "repositories"("installation_id");

-- AddForeignKey
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "github_installations"("installation_id") ON DELETE SET NULL ON UPDATE CASCADE;
