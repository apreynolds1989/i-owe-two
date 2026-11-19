<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/title-dark.png" />
    <img src="assets/title-light.png" alt="ReciPRocity" height="80" />
  </picture>
</h1>

A small tray app (like JetBrains Toolbox) that shows your GitHub pull-request numbers for a sprint:

- **Review ratio**: PRs you reviewed ÷ PRs you authored. Every PR needs two reviewers, so **2.0** means you're doing your share.
  - green from 2.0, orange from 1.75 up to 2.0, red below 1.75
  - at **4.0+** it goes super-powered ✨
- **Authored**: PRs you opened in the date window, whatever state they're in now.
- **Reviewed**: other people's PRs where you submitted at least one review (comment, changes requested or approval) in the window. Each PR counts once.
- **Need reviewers**: open, ready (non-draft) PRs with fewer than 2 distinct human reviewers. This is a live count, not limited to the window, and covers every repo of the owner you pick: for an organization, that's the whole org's backlog.

Click a number to see its PRs; click a PR to open it on GitHub.

It works for any GitHub account or organization; nothing in it is specific to one team.

## Install

You need **Node.js 22 or newer**.

```bash
git clone https://github.com/apreynolds1989/reciprocity.git
cd reciprocity
npm ci
```

Then either:

- **Run it from the repo:** `npm start`. This is handy for developers; everyone else should install it (below), which also gets you the extra hardening of the installed app.
- **Install it as an app:**
  1. Run `npm run dist`.
  2. Run the installer it creates in `release/`: `ReciPRocity Setup <version>.exe` on Windows, or the `.dmg` on Mac.

  After that it's in your Start menu (Windows) or Applications (Mac), and you don't need the terminal. Because you built it yourself, Windows and macOS don't show an "unknown app" warning.

**Windows tip:** a new tray icon may start out hidden under the **^** arrow next to the clock. Drag it onto the taskbar to keep it visible.

## First launch: add a read-only token

The app asks for a GitHub **fine-grained personal access token** with **read-only** access. It can't change anything on GitHub with it, and it refuses classic tokens because those can have broad access.

1. On GitHub, go to **Settings › Developer settings › Personal access tokens › Fine-grained tokens** and choose **Generate new token**. (Direct link: https://github.com/settings/personal-access-tokens)
2. Name it **ReciPRocity** and pick an expiry. 90 days is a good default.
3. Set **Resource owner** to the organization, or your own account, whose pull requests you want to see. Set **Repository access** to **All repositories**.
4. Under **Permissions**, set **Pull requests** to **Read-only**. **Metadata** is added as read-only automatically. Leave everything else as **No access**.
5. Generate the token, copy it, and paste it into the app.

If your organization requires approval for tokens, an org admin has to approve it before it works.

A token covers one owner. To look at a different organization, create a token for that organization and use **Change token…**.

## Using it

- **Open and close:** click the tray icon (menu-bar icon on Mac) to open the panel. Click anywhere else, or press **Esc**, to hide it.
- **📌 Pin:** keeps the panel open and on top of other windows, and lets you drag it anywhere by its header.
- **Choose a sprint:** set these on the Start screen.
  - **Where**: the organization or username your token was created for.
  - **GitHub user**: whose numbers to count. It defaults to you, and you can enter a teammate.
  - **From / To**: the dates, inclusive, in your computer's time zone.
  - **Ignore PRs labelled** (optional): labels such as "do not review" that should be left out of "Need reviewers".
- **Change the sprint later:** click the line under the header (`org · dates · @user`).
- **Refresh:** the ⟳ button. To stay well within GitHub's limits, it can be used once every 30 seconds.
- **Theme:** the 🖥 / ☀ / 🌙 button switches between System, Light and Dark.
- **⋯ menu:** Change sprint, Change token, Start at login (installed app only), and Quit.
- **Tray menu:** right-click the tray icon for the same options.

Closing the panel only hides it, and the app stays in the tray. Use **Quit** to exit.

## Updating

```bash
git pull
npm ci
npm start          # or: npm run dist, then run the new installer
```

Installing a new version over the old one keeps your settings and token. Please update now and then: new Electron versions include Chromium security fixes.

## Removing it

- **Installed app:** uninstall it from Windows Settings › Apps, or drag it out of Applications on Mac. The Windows uninstaller also deletes the app's saved data (including the encrypted token) and the installer copy it keeps in `%LOCALAPPDATA%\reciprocity-updater`.
- **Token:** to switch off its access completely, delete it on GitHub at https://github.com/settings/personal-access-tokens. In the app, **Change token… › Remove the saved token** deletes it from your computer.

## Safety

The short version:

- Read-only token.
- Stored encrypted by your OS.
- Only ever sent to `api.github.com`.
- The window's code is sandboxed and can't reach the network or your files.
- No telemetry, no auto-update, no background activity.

The details, and the remaining risks stated plainly, are in [SECURITY.md](SECURITY.md).

## Support

Bugs and questions are welcome as GitHub issues; see [SECURITY.md](SECURITY.md#reporting-a-problem) for how to report a security issue. This project is maintained on a voluntary, best-effort basis, with no obligation to respond, fix or keep it maintained.

## For developers

| Command | What it does |
|---|---|
| `npm start` | Build, then run from the repo |
| `npm run dist` | Build an installer for this OS into `release/` |
| `npm run check` | Tests: counting rules, input validation, injection attempts, allowlists, panel placement, color contrast, source scan for unsafe patterns |
| `npm run typecheck` | TypeScript |
| `npm run audit` | `npm audit` (moderate and above) |
| `npm run screenshots` | Renders every screen in light and dark with made-up data into `screenshots/`, then runs security probes against the real page setup (blocked network, scripts, navigation, file access) |

Layout:

- `src/main`: the main process. It handles the tray, the panel, the token, the GitHub calls and the security setup.
- `src/preload`: the bridge to the UI.
- `src/renderer`: the React UI.
- `src/shared`: types and validation used by both sides.
- `build/installer.nsh`: Windows installer hooks. electron-builder loads this file automatically.

## License

[MIT](LICENSE)
