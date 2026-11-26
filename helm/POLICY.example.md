# Local Helm Policy Example

Copy this file to `~/.flagship/policy.md` and tailor it to your team. Helm reads `~/.flagship/policy.md` automatically without committing private repo names or internal workflows to git.

```markdown
# My Team's Helm Policy

## Deploy Rules (Two-Way vs One-Way Doors)

- **Main web app (`web-app`):** Push to `origin/main` auto-deploys staging. Production deploys stay held for QA / team thumbs-up before manual promotion.
- **All other repos (`api`, `workers`, `infra-tools`):**
  - **Two-way doors** (easy to revert or feature-flag off): commit, push, and deploy immediately after verification. Route to the workstation if cloud deploy credentials only live there.
  - **One-way doors** (DB migrations, destructive ops, billing/auth cutovers, hard-to-revert changes): stop before deploying and escalate to Helm for explicit human approval.

## Product & Research Grounding

- **Impact sizing:** Every product/UX/auth triage must include absolute production user counts (28-day volume + weekly run-rate) from our analytics tool — never relative percentages or technical scope alone.
- **Nudge vs build:** Prefer lightweight nudges toward the standard happy path over adding complex, maintenance-heavy code for tiny edge-case cohorts.
```
