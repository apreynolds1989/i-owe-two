// Shapes passed between the main process and the UI over IPC. Plain data only (it is structured-cloned).
// The GitHub token never appears in any of these types: it goes in once (saveToken) and never comes back.

export type Theme = 'system' | 'light' | 'dark';
export type View = 'token' | 'start' | 'metrics';

/** What a person enters on the Start screen. */
export interface SprintSettings {
  /** Whose repos to search: a GitHub username or organization name. */
  owner: string;
  /** Whose activity to count. */
  login: string;
  /** Inclusive local dates, YYYY-MM-DD. */
  from: string;
  to: string;
  /** Lower-cased labels; open PRs carrying any of them are left out of "Need reviewers". */
  ignoreLabels: string[];
}

export interface PrSummary {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  /** Distinct human reviewers other than the author. Only set for the "Need reviewers" list. */
  reviewerCount?: number;
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
  ownerType: 'User' | 'Organization';
  timezone: string;
  /** ISO time the numbers were fetched. */
  fetchedAt: string;
  authored: Metric;
  reviewed: Metric;
  needsReviewers: Metric;
}

export type RefreshResult = { ok: true; metrics: SprintMetrics } | { ok: false; error: string };
export type ActionResult = { ok: true } | { ok: false; error: string };

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
  theme: Theme;
  pinned: boolean;
  openAtLogin: boolean;
  /** Start at login only works for the installed app, not when run from the repo. */
  canOpenAtLogin: boolean;
  /** Epoch ms when a manual refresh is allowed again (30 s cooldown). */
  refreshAvailableAt: number;
}

/** What the preload bridge exposes to the UI as `window.sprint`. */
export interface SprintBridge {
  getState(): Promise<AppState>;
  saveToken(token: string): Promise<ActionResult>;
  clearToken(): Promise<void>;
  start(input: { owner: string; login: string; from: string; to: string; ignoreLabels: string }): Promise<ActionResult>;
  showView(view: View): void;
  refresh(): void;
  setTheme(theme: Theme): void;
  setPinned(pinned: boolean): void;
  setOpenAtLogin(open: boolean): void;
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
  showView: 'view:show',
  refresh: 'metrics:refresh',
  result: 'metrics:result',
  loading: 'metrics:loading',
  setTheme: 'theme:set',
  setPinned: 'panel:pin',
  setOpenAtLogin: 'app:open-at-login',
  openExternal: 'link:open',
  hide: 'panel:hide',
  quit: 'app:quit',
} as const;
