<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/title-dark.png" />
    <img src="assets/title-light.png" alt="IO2" height="80" />
  </picture>
</h1>

**IO2: *I owe two*.** Every PR you put up, you owe two reviews.

A small tray app (like JetBrains Toolbox) that shows your GitHub pull-request numbers for your range (a day, a week, a two-week sprint, a month or a year):

- **Review ratio**: PRs you reviewed ÷ PRs you authored. Every PR needs two reviewers, so **2.0** means you're doing your share.
  - green from 2.0, orange from 1.75 up to 2.0, red below 1.75
  - below target it tells you how many more PRs to review to get there
  - at **4.0+** with at least **30 reviews a week** it goes super-powered ✨ (scaled to the range: 5 for a day, 60 for two weeks, and so on). It's meant to be hard.
  - click it for **Give & take**: the same numbers broken down by person. *you* is how many of their PRs you reviewed in the range; *them* is how many of the PRs you opened in the range they reviewed. Bots don't count.
- **Authored**: PRs you opened in the range, whatever state they're in now.
- **Reviewed**: other people's PRs where you submitted at least one review (comment, changes requested or approval) in the range. Each PR counts once.
- **Waiting on you**: open, ready PRs on your plate, in two sections. A PR is only ever in one, and Requested wins.
  - **Requested**: your review is requested and still pending. Requests to a team you're on count too. GitHub drops a request once you review; if the author re-requests you, the PR comes back here tagged *Re-requested*.
  - **Involved**: you've reviewed it with comments or requested changes, and haven't approved since. Each PR is tagged *Commented*, *Changes requested* or *Review dismissed*. Only reviews count (including inline review comments); a plain comment on the conversation tab doesn't.
  - Once you approve a PR it leaves both sections, unless you're re-requested. A comment after approving doesn't undo the approval, the same as on GitHub.
- **Your PRs waiting**: your own open, ready PRs with fewer than 2 distinct human reviewers, longest-waiting first. Like Need reviewers, it's live (not limited to the range) and leaves out PRs with an ignored label.
  - **Copy** puts them all on the clipboard, one per line (`- repo#123 Title https://github.com/…`) under "Need reviewers on these, please:", ready to paste into a chat.
- **Need reviewers**: open, ready (non-draft) PRs with fewer than 2 distinct human reviewers that you haven't reviewed yet, longest-waiting first. This is a live count, not limited to the range, and covers every repo of the owner you pick: for an organization, that's the whole org's backlog.
  - Its toolbar flips the list to newest first, groups it into collapsible sections by repo, and filters it to PRs with any of the labels you pick. Your choice is remembered.
- **History**: each period's numbers, kept on your computer as your range rolls over.
  - **Recap**: when a period ends, a short recap shows once at the top: its ratio, the change from the period before, how many periods in a row you've been at 2.0+, and how many people you reviewed for and who reviewed yours. Dismiss it with ✕; click any ended period in History to see its recap again.
  - History keeps counts only. To have recaps name the person you traded the most reviews with, switch on **⋯ › Remember teammates in history** (off by default; see [below](#remembering-teammates)).
- **Tray dot**: the tray icon shows a green, orange, red or purple dot for where your range stands, so you can check without opening the panel.

Click a number to see its PRs (with how long ago each was opened); click a PR to open it on GitHub.

It works for any GitHub account or organization; nothing in it is specific to one team.

> [!IMPORTANT]
> IO2 was developed largely with the assistance of AI tools. Please read the [Disclaimer](#disclaimer) before you install or use it.

## Install

You need **Node.js 22 or newer**.

```bash
git clone https://github.com/apreynolds1989/i-owe-two.git
cd i-owe-two
npm ci
```

Then either:

- **Run it from the repo:** `npm start`. This is handy for developers; everyone else should install it (below), which also gets you the extra hardening of the installed app.
- **Install it as an app:**
  1. Run `npm run dist`.
  2. Run the installer it creates in `release/`: `IO2 Setup <version>.exe` on Windows, or the `.dmg` on Mac.

  After that it's in your Start menu (Windows) or Applications (Mac), and you don't need the terminal. Because you built it yourself, Windows and macOS don't show an "unknown app" warning.

**Windows tip:** a new tray icon may start out hidden under the **^** arrow next to the clock. Drag it onto the taskbar to keep it visible.

## First launch: add a read-only token

The app asks for a GitHub **fine-grained personal access token** with **read-only** access. The app itself only ever reads from GitHub, and it refuses classic tokens because those can have broad access. It can't check a fine-grained token's permissions, though, so keep the token read-only as described below: that limits the damage if it's ever stolen.

1. On GitHub, go to **Settings › Developer settings › Personal access tokens › Fine-grained tokens** and choose **Generate new token**. (Direct link: https://github.com/settings/personal-access-tokens)
2. Name it **IO2** and pick an expiry. 90 days is a good default.
3. Set **Resource owner** to the organization, or your own account, whose pull requests you want to see. Set **Repository access** to **All repositories**.
4. Under **Permissions**, set **Pull requests** to **Read-only**. **Metadata** is added as read-only automatically. Leave everything else as **No access**.
5. Generate the token, copy it, and paste it into the app.

If your organization requires approval for tokens, an org admin has to approve it before it works.

A token covers one owner. To look at a different organization, create a token for that organization and use **Change token…**.

## Using it

- **Open and close:** click the tray icon (menu-bar icon on Mac) to open the panel. Click anywhere else, or press **Esc**, to hide it.
- **📌 Pin:** keeps the panel open and on top of other windows, and lets you drag it anywhere by its header.
- **Choose your range:** set these on the Start screen.
  - **Where**: the organization or username your token was created for.
  - **GitHub user**: whose numbers to count. It defaults to you, and you can enter a teammate.
  - **Range** and **Starts on**: how long each period is (Day, Week, Two weeks, Month or Year) and the day one begins, e.g. your sprint's first day. Dates are in your computer's time zone. The app moves on to the next period by itself.
  - **Ignore PRs labelled** (optional): labels such as "do not review" that should be left out of "Need reviewers".
- **Change your range later:** click the line under the header (`org · range · dates · @user`). If you change the owner, user, range or start date and you have history, you're asked whether to **archive** it (kept read-only under History) or **delete** it. Going back to exactly the same settings later picks the archived history up again.
- **Look at other dates:** the **Viewing** menu shows Today, the last 7, 14 or 30 days, or custom dates, without changing your settings. It's just a look: nothing is saved to history, and the tray keeps showing your range. **Back to my range** returns.
- **When a period ends:** just after midnight (or when your computer wakes, or when you open the panel), the app notices the new period. It fetches the period that just ended one last time to lock in its numbers, then fetches the new one. That's the only thing it ever does without being asked. If that last fetch can't happen, the period shows as "partial" in History.
- **Refresh:** the ⟳ button. To stay well within GitHub's limits, it can be used once every 30 seconds.
- **Theme:** the 🖥 / ☀ / 🌙 button switches between System, Light and Dark.
- **⋯ menu:** Change range, Export history (a CSV file, saved where you choose), Clear history, Remember teammates in history, Change token, Start at login (installed app only), and Quit.
- **Tray menu:** right-click the tray icon for the same options.

Closing the panel only hides it, and the app stays in the tray. Use **Quit** to exit.

### Remembering teammates

**⋯ › Remember teammates in history** is off by default. When it's on, each period in History also keeps the GitHub usernames of the 5 people you traded the most reviews with (and the counts), so recaps can say "Traded most with @bob".

- It's only recorded while the **GitHub user** is you (the token's owner), never when you're looking at a teammate's numbers.
- It stays on your computer and is never included in **Export history**.
- Switching it off deletes every stored username, including in archived history.

This keeps a record about other people, not just you. Whether that's appropriate is your choice: check it fits your team's expectations and your organization's policies. See the [Disclaimer](#disclaimer).

## Updating

```bash
git pull
npm ci
npm start          # or: npm run dist, then run the new installer
```

Installing a new version over the old one keeps your settings, token and history. Settings from 0.1.x are converted: a 7-day window becomes a Week range, anything else a Two weeks range, starting on its first day. Please update now and then: new Electron versions include Chromium security fixes.

## Removing it

- **Installed app:** uninstall it from Windows Settings › Apps, or drag it out of Applications on Mac. The Windows uninstaller also deletes the app's saved data (including the encrypted token and your history) and the installer copy it keeps in `%LOCALAPPDATA%\i-owe-two-updater`.
- **History:** uninstalling deletes it. To keep a copy, use **⋯ › Export history…** first.
- **Token:** to switch off its access completely, delete it on GitHub at https://github.com/settings/personal-access-tokens. In the app, **Change token… › Remove the saved token** deletes it from your computer.

## Safety

The short version:

- Read-only token.
- Stored encrypted by your OS.
- Only ever sent to `api.github.com`.
- The window's code is sandboxed and can't reach the network or your files.
- No telemetry, no auto-update. The only thing it does unasked is fetch your numbers when a new period starts.

The details, and the remaining risks stated plainly, are in [SECURITY.md](SECURITY.md).

## Support

Bugs and questions are welcome as GitHub issues, and pull requests are welcome too; see [CONTRIBUTING.md](CONTRIBUTING.md). See [SECURITY.md](SECURITY.md#reporting-a-problem) for how to report a security issue. This project is maintained on a voluntary, best-effort basis, with no obligation to respond, fix or keep it maintained.

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
- `src/shared`: types, validation, and the rules for ranges, the ratio and history, used by both sides.
- `build/installer.nsh`: Windows installer hooks. electron-builder loads this file automatically.

## Disclaimer

IO2 was developed largely with the assistance of AI tools. While care has been taken over its design, security and testing, AI-assisted software can contain errors or security weaknesses that aren't immediately apparent.

The software is provided "as is", without warranty of any kind, as set out in the [LICENSE](LICENSE). Use of IO2 is entirely at your own discretion and risk. Before installing it or giving it a GitHub token, please review the source code and [SECURITY.md](SECURITY.md), and decide whether it meets your own and your organization's requirements. If your organization has policies on third-party or AI-assisted tools, check that using IO2 complies with them.

The maintainer accepts no liability for any loss, damage or other consequences arising from its use.

## License

[MIT](LICENSE)
