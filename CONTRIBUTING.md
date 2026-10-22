# Contributing

Thanks for your interest in improving Near. Bug reports, clear documentation fixes, and focused pull requests are welcome.

## Before you start

- Search existing issues and pull requests to avoid duplicate work.
- For a substantial change, open an issue first to discuss the approach.
- Never include passwords, private invite links, API credentials, .env files, or real personal data in an issue, test, screenshot, or pull request.
- Report security vulnerabilities privately. See SECURITY.md.

## Set up the project

Use Node.js 20 or newer, Corepack, and pnpm 9.15.0. From the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

## Check your changes

Before opening a pull request, run:

```sh
pnpm test
pnpm build
```

For changes to WebRTC rooms, voice, reconnection, or local-network behavior, also follow the real-device checks in the README. Automated checks do not cover every browser, microphone, NAT, or multi-device scenario.

## Pull requests

- Keep each pull request focused and explain the user-visible behavior it changes.
- Include or update tests for behavior changes where practical.
- Update the README when setup steps, privacy behavior, configuration, or feature limitations change.
- Describe the checks you ran and any manual scenarios that still need verification.
- Do not commit generated build output or local configuration files.
