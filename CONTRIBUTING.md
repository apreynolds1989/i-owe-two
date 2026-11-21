# Contributing to IO2

Thanks for your interest in improving IO2. Bug reports, suggestions and pull requests are all welcome.

This project is maintained on a voluntary, best-effort basis. The maintainer has no obligation to respond to issues, review or accept pull requests, or keep the project maintained. Every change to `main` is merged by the maintainer, at their discretion.

## Reporting issues

- **Bugs and feature requests:** open an issue using one of the templates.
- **Security vulnerabilities:** use [private vulnerability reporting](https://github.com/apreynolds1989/i-owe-two/security/advisories/new), not a public issue. See [SECURITY.md](SECURITY.md).
- **Never include your GitHub token** in an issue, pull request, screenshot or log.

## Pull requests

For anything beyond a small fix, please open an issue first to discuss the change. That avoids spending time on something that might not be merged.

1. Fork the repository and create a branch from `main`.
2. Install with `npm ci` (Node.js 22 or newer).
3. Make your change. Keep it focused: one change per pull request.
4. Before opening the pull request, run:
   - `npm run typecheck`
   - `npm run check`
   - `npm run audit`
   - `npm run screenshots` if you changed the UI. Check the light and dark renders, and make sure all security probes still pass.
5. Open a pull request against `main`. Describe what changed and why, and link the related issue.

### What will be accepted

IO2's security model is a core feature (see [SECURITY.md](SECURITY.md)). Changes are unlikely to be accepted if they:

- need anything beyond a read-only, fine-grained token, or make any change on GitHub
- add any network destination other than `api.github.com`, or add telemetry, analytics or auto-update
- weaken the sandbox, Content Security Policy, IPC validation, link allowlist or Electron fuses
- add runtime dependencies without a clear need

Please also follow the existing code style. Pin any new dev dependency to an exact version and commit the updated `package-lock.json`.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE) that covers this project.
