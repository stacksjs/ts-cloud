# Claude Code Guidelines

## About

A zero-dependency AWS infrastructure-as-code framework that lets you define and deploy production-ready cloud infrastructure using TypeScript configuration files. It generates CloudFormation templates and makes direct AWS API calls using Signature V4 (no AWS SDK or CLI required). Includes 13 production-ready presets (static sites, serverless apps, full-stack apps, microservices, data pipelines, etc.), builders for VPC/S3/EC2/ECS/RDS/DynamoDB/CloudFront and more, plus built-in secret detection scanning before deployments.

## Linting

- Use **pickier** for linting — never use eslint directly
- Run `bunx --bun pickier .` to lint, `bunx --bun pickier . --fix` to auto-fix
- When fixing unused variable warnings, prefer `// eslint-disable-next-line` comments over prefixing with `_`

## Frontend

- Use **stx** for templating — never write vanilla JS (`var`, `document.*`, `window.*`) in stx templates
- Use **crosswind** as the default CSS framework which enables standard Tailwind-like utility classes
- stx `<script>` tags should only contain stx-compatible code (signals, composables, directives)

## Dependencies

- **buddy-bot** handles dependency updates — not renovatebot
- **better-dx** provides shared dev tooling as peer dependencies — do not install its peers (e.g., `typescript`, `pickier`, `bun-plugin-dtsx`) separately if `better-dx` is already in `package.json`
- If `better-dx` is in `package.json`, ensure `bunfig.toml` includes `linker = "hoisted"`

## Commits

- Use conventional commit messages (e.g., `fix:`, `feat:`, `chore:`)
