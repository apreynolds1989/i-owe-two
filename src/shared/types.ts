// Shapes passed between the main process and the UI over IPC. Plain data only (it is structured-cloned).
// The GitHub token never appears in any of these types: it goes in once (saveToken) and never comes back.
import type { SprintWindow } from './args';
import type { HistoryView } from './history';
import type { RangeKind, RangeSetting, ViewRange } from './range';

export type Theme = 'system' | 'light' | 'dark';
export type View = 'token' | 'start' | 'metrics';

/** What a person enters on the Start screen. */
export interface SprintSettings {
  /** Whose repos to search: a GitHub username or organization name. */
  owner: string;
  /** Whose activity to count. */
  login: string;
  /** The tracked range: it rolls over by itself and builds history. */
  range: RangeSetting;
  /** Lower-cased labels; open PRs carrying any of them are left out of "Need reviewers". */
  ignoreLabels: string[];
}

export interface PrSummary {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  /** ISO time the PR was opened. */
  createdAt: string;
  /** Distinct human reviewers other than the author. Only set for the open-PR lists. */
  reviewerCount?: number;
  /** Label names as written on GitHub. Only set for the "Need reviewers" list (it can be filtered). */
  labels?: string[];
  /** Which "Waiting on you" section the PR is in. Only set for that list. */
  section?: 'requested' | 'involved';
  /** This person's standing review on the PR, if any. Only set for the "Waiting on you" list. */
  myReview?: MyReview;
}

/** Someone's standing review on a PR (see myReviewState in src/main/rules.ts). */
export type MyReview = 'approved' | 'changes_requested' | 'commented' | 'dismissed';

/** How the "Need reviewers" list is shown. Remembered in prefs.json; see src/shared/prView.ts. */
export interface PrListView {
  groupByRepo: boolean;
  sort: 'oldest' | 'newest';
  /** Lower-cased; a PR is shown if it carries any of them. Empty shows every PR. */
  labels: string[];
}

/**
 * Reviews traded with one person in the dates on screen. `gave`: their PRs you reviewed in these dates.
 * `got`: your PRs opened in these dates that they reviewed (see giveAndTake in src/main/rules.ts).
 */
export interface Partner {
  login: string;
  gave: number;
  got: number;
}

export interface Metric {
  count: number;
  prs: PrSummary[];
  /** True when GitHub's search found more than the 1,000 results it lets anyone page through. */
  capped: boolean;
  /** GitHub's total for the underlying search (useful when capped). */
  searchTotal: number;
}

export interface SprintMetrics {
  settings: SprintSettings;
  /** The dates these numbers cover (the tracked period, or the range being viewed). */
  window: SprintWindow;
  ownerType: 'User' | 'Organization';
  timezone: string;
  /** ISO time the numbers were fetched. */
  fetchedAt: string;
  authored: Metric;
  reviewed: Metric;
  needsReviewers: Metric;
  /**
   * Open PRs on this person's plate: review requested and still pending (section 'requested'), or
   * reviewed with comments or changes requested and not approved since (section 'involved').
   */
  waitingOnYou: Metric;
  /** This person's open, ready PRs with fewer than 2 reviewers, longest-waiting first. Not limited to the dates. */
  yourPrsWaiting: Metric;
  /** Everyone reviews were traded with in these dates, most traded first. Never saved unless opted in. */
  partners: Partner[];
}

export type RefreshResult = { ok: true; metrics: SprintMetrics } | { ok: false; error: string };
export type ActionResult = { ok: true } | { ok: false; error: string };

/** History that would be archived or deleted by saving new settings: the UI asks which. */
export interface HistoryChoice {
  kind: RangeKind;
  start: string;
  periods: number;
}
export type StartResult = ActionResult | { ok: false; historyChoice: HistoryChoice };

/** Everything the UI needs to draw itself, pushed by the main process whenever it changes. */
export interface AppState {
  view: View;
  hasToken: boolean;
  /** False when the OS can't encrypt the token, so it's only kept until the app quits. */
  tokenPersisted: boolean;
  /** Login of the token's owner, once known. */
  viewerLogin: string | null;
  /** Last settings used (also the Start form's defaults). */
  settings: SprintSettings | null;
  /** The current period of the tracked range. */
  trackedWindow: SprintWindow | null;
  /** What's being looked at: the tracked range, or a temporary range that's never saved. */
  viewing: ViewRange;
  /** The dates on screen (trackedWindow unless viewing something else). */
  window: SprintWindow | null;
  history: HistoryView;
  theme: Theme;
  pinned: boolean;
  openAtLogin: boolean;
  /** Start at login only works for the installed app, not when run from the repo. */
  canOpenAtLogin: boolean;
  /** Epoch ms when a manual refresh is allowed again (30 s cooldown). */
  refreshAvailableAt: number;
  prView: PrListView;
  /** Opt-in: History also keeps the top teammates' logins per period (only when tracking yourself). */
  rememberTeammates: boolean;
  /** "from|to" of the last period whose recap was dismissed. */
  recapSeen: string | null;
}

export interface StartInput {
  owner: string;
  login: string;
  kind: string;
  start: string;
  ignoreLabels: string;
  /** Only sent after the UI asked what to do with existing history. */
  historyChoice?: 'archive' | 'delete';
}

/** What the preload bridge exposes to the UI as `window.sprint`. */
export interface SprintBridge {
  getState(): Promise<AppState>;
  saveToken(token: string): Promise<ActionResult>;
  clearToken(): Promise<void>;
  start(input: StartInput): Promise<StartResult>;
  /** Look at another range without saving it. Resolves with an error message for bad custom dates. */
  setViewing(view: ViewRange): Promise<ActionResult>;
  /** Asks where to save, then writes a CSV. ok with nothing written if the person cancels. */
  exportHistory(): Promise<ActionResult>;
  /** Asks for confirmation, then deletes all history. */
  clearHistory(): Promise<void>;
  showView(view: View): void;
  refresh(): void;
  setTheme(theme: Theme): void;
  setPinned(pinned: boolean): void;
  setOpenAtLogin(open: boolean): void;
  setPrView(view: PrListView): void;
  /** Copies "Your PRs waiting" (title and link per line) to the clipboard. The main process builds the text. */
  copyYourPrs(): Promise<ActionResult>;
  /** Asks for confirmation in a native dialog; turning it off deletes every stored teammate login. */
  setRememberTeammates(on: boolean): Promise<void>;
  /** Marks a period's recap ("from|to") as seen, so it stops showing on its own. */
  setRecapSeen(key: string): void;
  openExternal(url: string): void;
  hide(): void;
  quit(): void;
  /** Each subscribe returns an unsubscribe function. */
  onState(cb: (state: AppState) => void): () => void;
  onResult(cb: (result: RefreshResult) => void): () => void;
  onLoading(cb: (loading: boolean) => void): () => void;
}

export const IPC = {
  getState: 'state:get',
  state: 'state:changed',
  saveToken: 'token:save',
  clearToken: 'token:clear',
  start: 'sprint:start',
  setViewing: 'view:range',
  exportHistory: 'history:export',
  clearHistory: 'history:clear',
  showView: 'view:show',
  refresh: 'metrics:refresh',
  result: 'metrics:result',
  loading: 'metrics:loading',
  setTheme: 'theme:set',
  setPinned: 'panel:pin',
  setOpenAtLogin: 'app:open-at-login',
  setPrView: 'prview:set',
  copyYourPrs: 'prs:copy-yours',
  setRememberTeammates: 'history:remember-teammates',
  setRecapSeen: 'recap:seen',
  openExternal: 'link:open',
  hide: 'panel:hide',
  quit: 'app:quit',
} as const;
