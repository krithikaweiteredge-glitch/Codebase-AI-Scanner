# Codebase AI Scan action

Writes your Codebase AI findings as SARIF so they appear on the pull request,
in GitHub's Security tab, and in any editor that reads the format — rather than
only in the web UI, where someone has to remember to go and look.

## Setup

1. **Create a token.** Signed in to Codebase AI:

   ```bash
   curl -X POST https://<your-api>/api/auth/tokens \
     -H 'content-type: application/json' \
     --cookie 'cai_session=<your session cookie>' \
     -d '{"label":"github-actions"}'
   ```

   The token is shown once. Store it as a repository secret, `CODEBASE_AI_TOKEN`.
   It grants what a signed-in session grants; revoke it by deleting the session.

2. **Find the repository id** — the UUID in the URL when you open the repository
   in Codebase AI.

## Use

```yaml
name: Security
on: [pull_request]

permissions:
  contents: read
  security-events: write   # required to upload SARIF

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: krithikaweiteredge-glitch/Codebase-AI-Scanner/.github/actions/scan@main
        id: scan
        with:
          api-url: https://your-api.onrender.com
          api-token: ${{ secrets.CODEBASE_AI_TOKEN }}
          repository-id: 7fde95d5-228a-446b-8db0-63a5087c053b

      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: ${{ steps.scan.outputs.sarif-file }}
```

## Running a fresh analysis first

By default the action exports the findings from the **last** analysis, because a
scan takes minutes and most workflows want yesterday's answer immediately. To
analyse the current commit first:

```yaml
        with:
          analyze: 'true'
          timeout-minutes: '20'
```

It polls until the run completes rather than assuming, because exporting while a
scan is still running reports the previous run's findings as this one's.

## Failing the build on new findings

The action does not fail on findings — that judgement belongs to the repository.
`steps.scan.outputs.findings` carries the count if you want to:

```yaml
      - run: |
          if [ "${{ steps.scan.outputs.findings }}" -gt 0 ]; then
            echo "::error::${{ steps.scan.outputs.findings }} finding(s)"
            exit 1
          fi
```

Findings the repository has declared intentional — through
`.codebase-ai/policy.yml` or a `codebase-ai-ignore` comment — are already
excluded, as are ones marked false positive or resolved.
