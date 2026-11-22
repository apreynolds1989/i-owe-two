# Security

IO2 is designed so that the worst realistic outcome of anything going wrong is "someone could read pull-request titles and reviews". It should never be "someone could change code, run commands on my machine, or act as me on GitHub". This page explains how, so you can check before you run it.

## Your GitHub token

- **Read-only by design.** The app only ever sends read-only queries (see below). It asks for a fine-grained token with *Pull requests: Read-only*, and refuses classic tokens (`ghp_…`), which can carry broad scopes.
  - GitHub doesn't let an app check a fine-grained token's permissions, so a token with write access would still be accepted. Give it read-only access: that's what limits the damage if the token is ever stolen.
- **Encrypted at rest.** The token is encrypted by your operating system before it's written to disk: Windows DPAPI, or the macOS Keychain. It's stored in `token.bin` in the app's data folder.
  - If your OS can't encrypt it, it isn't written to disk at all; it's kept in memory until you quit.
- **Never in the window.** The token goes in once, from the paste box (which is cleared immediately), and stays in the main process after that. The UI never receives it back.
- **One destination.** The token is only sent in the `Authorization` header to `https://api.github.com/graphql`, a fixed address.
  - Redirects are refused, so it can't be forwarded anywhere else.
  - Anything token-shaped is scrubbed from every error message and log line.
- **Proper certificate checks.** Requests go through Electron's Chromium network stack, which checks GitHub's certificate against your operating system's certificate store. They use a separate in-memory session that can only reach `api.github.com`.
  - Node's `NODE_TLS_REJECT_UNAUTHORIZED=0` and `NODE_EXTRA_CA_CERTS`, which some machines set globally, can't switch certificate checking off or add certificates for these requests. The app removes them at startup anyway.
  - The app refuses to start if it's launched with Chromium switches that could weaken this or expose the token: `--ignore-certificate-errors`, `--host-resolver-rules`, `--host-rules`, `--log-net-log` and remote debugging. A system proxy (`--proxy-server`) is still allowed; certificates are checked through it as normal.
- **Clipboard.** Copied text can stay in clipboard history (Windows: Win + V, including cloud clipboard if you use it). After saving the token you can delete it from there.
- **Removable.** Use **Change token… › Remove the saved token** in the app, or delete the token on GitHub at any time.

## Read-only to GitHub

- **No mutations.** The app contains a fixed list of three GraphQL *queries* and nothing else. The request function refuses any document that isn't on that list, or that contains `mutation` or `subscription`. `npm run check` tests this.
- **Nothing you type can change what's searched.**
  - Usernames and organization names must match GitHub's own format (letters, digits, single hyphens), so they can't add qualifiers like `repo:someone/private`.
  - Dates must be strict `YYYY-MM-DD`.
  - Labels are only compared inside the app and never put into a query.
- **Gentle on your account.**
  - Manual refresh is limited to once per 30 seconds, and a refresh that's already running is reused.
  - New settings or a new token trigger a refresh at most every 5 seconds.
  - Requests are spaced out, and paging stops at GitHub's 1,000-result cap.
  - The only automatic fetch is when your range rolls over to a new period: just after local midnight, on waking from sleep, or on opening the panel, the app locks in the period that ended (two searches) and fetches the new one. There's no other polling.
  - Custom dates in **Viewing** are limited to 92 days. Only a tracked Year range searches a longer window (up to 366 days).
  - If GitHub ever reports a rate limit, the app sends nothing at all until GitHub's reset time, and waits at least a minute.
  - Changing settings or removing the token cancels any request still running for the old ones.

## The app on your computer

The UI is built with Electron and follows Electron's [security checklist](https://www.electronjs.org/docs/latest/tutorial/security):

- **Sandboxed UI.** The window runs sandboxed, with context isolation and no Node.js. It can't touch your files or run programs.
- **Its own files only.** The UI is served from a private `app://` address, not from the file system, and only from the app's own UI folder. Attempts to reach other files, including encoded `../` tricks, are refused.
- **A strict Content Security Policy**, sent as a response header and as a `<meta>` tag:
  - scripts only from the app itself
  - no inline scripts and no `eval`
  - **no network access at all** from the window
  - all GitHub calls are made by the main process
- **Defence in depth:**
  - every request the window makes to anything other than its own files is cancelled
  - every permission request (camera, microphone, notifications, location…) is denied
  - embedded web views are blocked
  - navigating away from the app is blocked
- **Links.** Only two kinds of page can be opened, in your default browser: pull-request pages on `https://github.com`, and GitHub's token settings page.
  - The address is parsed and opened in its normalized form, so lookalikes such as `github.com.evil.example` are refused.
  - So are other GitHub pages, such as app-authorization pages.
- **Untrusted text.** PR titles and names from GitHub are displayed as text only, never as HTML.
- **Checked messages.** Every message from the window to the main process is checked: it must come from the app's own page, and its contents are validated before anything happens.
- **Electron fuses** in the installed app switch off features malware could use to hijack the program:
  - running as plain Node.js
  - `NODE_OPTIONS`
  - debugger flags
  - loading code from outside the app archive

  The fuses also enable integrity checks on the archive. DevTools and the default application menu (with shortcuts such as reload) are disabled in the installed app.
- **Running from the repo (`npm start`)** uses the stock Electron binary, so there are no fuses. The start script strips `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE` and the TLS overrides before launching, so an IDE terminal can't attach a debugger to the process holding the token. If you're not a developer, use the installed app.
- **Nothing else running.**
  - Writes only `prefs.json` (your settings, theme, list view and choices such as dismissed recaps), `token.bin` and `history.json` to its own data folder. All three are deleted on uninstall.
  - History holds counts (dates, PRs authored and reviewed, and how many people you reviewed for and who reviewed yours), never PR titles or links. Other people's usernames are only stored if you switch on **Remember teammates in history**; see [Teammates in history](#teammates-in-history).
  - **Export history…** writes a CSV only where you choose in the save dialog. The dialog and the file write happen in the main process; the window never touches your files. It never includes teammates' usernames.
  - **Copy** (on Your PRs waiting) writes to the clipboard only when you click it. The main process builds the text itself from the numbers it fetched: the window can't choose what goes on the clipboard. Only pull-request links on `github.com` are included, and titles are flattened to one line with control and text-direction characters removed. The app never reads the clipboard.
  - Runs no shell commands.
  - Has no auto-update, telemetry, analytics or crash reporting.
  - Talks to no server except `api.github.com`.
  - Starts at login only if you switch that on.
  - Installs per-user, with no admin rights needed, and uninstalls cleanly.

## Teammates in history

**Remember teammates in history** (in the ⋯ and tray menus) is **off by default**. Switching it on is your choice, and you're responsible for it.

- **What's stored:** for each period, the GitHub usernames of up to 5 people you traded the most reviews with, and the two counts for each. That's on top of the counts History always keeps.
- **Where:** in `history.json` on your computer only. Like the rest of History, it's plain JSON in the app's data folder (not encrypted), readable by anything running as you.
- **Guardrails:**
  - It's only recorded while the tracked GitHub user is the token's owner, so the app can't quietly build a record about someone else.
  - It's never included in **Export history**.
  - Switching it off deletes every stored username, including in archived history.
  - Turning it on and off both ask first.
- **Why it's off by default:** it's a record about other people, who haven't opted in. Over time it shows who reviews whose work. Before switching it on, check that it fits your team's expectations and your organization's policies, including any rules on keeping data about colleagues.

The Give & take list itself is worked out fresh on every refresh and never saved unless this option is on.

The maintainer accepts no liability for how this option is used, or for any consequence of storing or sharing this information. The software is provided "as is", as set out in the [LICENSE](LICENSE) and the README's [Disclaimer](README.md#disclaimer).

## Dependencies

- **Small.** The shipped app contains only its own compiled files. React is bundled in, and there's no `node_modules` folder inside the app.
- **Pinned.** Every development dependency is pinned to an exact version, and `package-lock.json` is committed. Install with `npm ci`, which installs exactly those versions and verifies their integrity hashes.
- **Patched.** `npm run audit` must report no moderate-or-higher issues. One build-time dependency of the packager (`minimatch`) is overridden to a patched version for that reason.

## Remaining risks (stated plainly)

- **Malware already running as you.** OS encryption protects the token from other users and from a stolen disk. It can't protect it from malicious software already running under your own account.
  - Because the token is read-only, the most that software could do with it is read pull requests.
  - The same software could also modify a per-user install, because the installer isn't code-signed. The archive integrity check only fully protects a signed app.
- **macOS builds aren't notarized.** You build the app on your own Mac, so Gatekeeper doesn't block it.
  - **Speculative:** if you run from the repo on a Mac, the Keychain entry is tied to the generic Electron binary. Another app run the same way might be able to read it without a prompt.
  - The installed app has its own identity.
- **Electron and Chromium bugs** can't be ruled out in any app. Loading no remote content, plus the sandbox, CSP and fuses, removes most of the paths an attacker would need. Keep the app updated (`git pull`, then `npm ci` and rebuild).
- **Build-time install scripts.** `npm ci` runs the install steps of a few well-known packages (Electron's binary download is checksum-verified). They're pinned and integrity-checked, but they do run on your machine at build time.
- **Organization policy.** An org can require approval for fine-grained tokens, or forbid them. The app shows GitHub's message; it can't work around it.

## Reporting a problem

Please report security vulnerabilities privately, using GitHub's private vulnerability reporting (**Security** tab › [**Report a vulnerability**](https://github.com/apreynolds1989/i-owe-two/security/advisories/new)). Don't open a public issue for them. Bugs that don't put users at risk can go in a normal issue.

This project is maintained on a voluntary, best-effort basis. The maintainer has no obligation to respond to issues, accept contributions, provide fixes or keep the project maintained, and may stop doing so at any time. It is provided as-is, as set out in the [LICENSE](LICENSE).
