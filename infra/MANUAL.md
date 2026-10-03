# Manual infrastructure changes

ADR-004: everything is provisioned with Terraform, except where Terraform has no support. Each manual change is recorded here: what, where, who, when, and why it can't be in Terraform.

| Date | Who | Environment | Change | Why manual |
| -- | -- | -- | -- | -- |
| _pending_ | owner | AWS (Bedrock) | Enable Claude Opus 5.5, Opus 5 and Sonnet 5.5 model access in `ap-southeast-2` and `ap-southeast-4`; accept the Anthropic model terms | Model access and EULA acceptance are console actions (AI-01, ADR-011a) |

## Clerk provider (AI-01, ADR-011a)

Fill in after enabling Bedrock access:

- AWS account id: _pending_
- Model ids and inference-profile ids (AU profile, `ap-southeast-4` in-region): _pending_
- Fallback models available on the AU profile (`claude-opus-5`, `claude-sonnet-5-5`): _pending_
- Structured outputs (`output_config.format`) accepted on Bedrock for Opus 5.5? _pending_
- Quota (input and output TPM, RPM): _pending_
- Model-invocation logging: **off** (must stay off; prompts must not be stored)
- Retention and training terms accepted (link and date): _pending_
