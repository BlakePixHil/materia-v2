# Manual infrastructure changes

ADR-004: everything is provisioned with Terraform, except where Terraform has no support. Each manual change is recorded here: what, where, who, when, and why it can't be in Terraform.

| Date      | Who   | Environment       | Change                                                                                                          | Why manual                                                        |
| --------- | ----- | ----------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| _pending_ | owner | Anthropic Console | Create the organisation and the `dev` and `prod` workspaces with spend limits; create one API key per workspace | The Anthropic Console has no Terraform provider (AI-01, ADR-011a) |
| _pending_ | owner | GCP dev, prod     | Add the matching key to Secret Manager as `ANTHROPIC_API_KEY`                                                   | Secret values are never committed or held in Terraform state      |

## Clerk provider (AI-01, ADR-011a)

Fill in after setup. **Never record key values here.**

- Anthropic organisation and workspace names: _pending_
- Spend limits per workspace: _pending_
- Data retention (standard or zero data retention) and the date agreed: _pending_
- Secret Manager secret: `ANTHROPIC_API_KEY` in dev (_pending_) and prod (_pending_)
