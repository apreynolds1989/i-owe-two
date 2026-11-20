// `npm run check`: tests the counting rules, input validation, read-only and link allowlists, panel
// placement and color contrast without touching GitHub, then scans the source for unsafe patterns.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_WINDOW_DAYS, parseWindow } from '../src/shared/args';
import {
  EMPTY_HISTORY, forgetPartners, historyCsv, historyView, isPeriodKey, MAX_PERIODS, MAX_STORED_PARTNERS, needsChoice, parseHistory,
  partnerExtras, pendingFinalize, recordPeriod, switchSeries, type Series,
} from '../src/shared/history';
import { COPY_HEADER, MAX_COPIED_PRS, prLinksText } from '../src/shared/prLinks';
import { pendingRecap, periodRecap } from '../src/shared/recap';
import {
  parseView, periodContaining, previousPeriod, RANGE_KINDS, validRange, viewWindow, windowDays,
} from '../src/shared/range';
import { reviewRatio, reviewsToTarget, SUPER_MESSAGES, superMinReviews } from '../src/shared/ratio';
import { validSettings } from '../src/shared/settings';
import { DOT_COLORS, paintDot } from '../src/main/dot';
import { applyPrView, DEFAULT_PR_VIEW, labelOptions, parsePrView } from '../src/shared/prView';
import type { Partner, PrSummary } from '../src/shared/types';
import { allowedGitHubLink, checkToken, isValidLogin, MAX_LOGIN_LENGTH, parseLabels, redact } from '../src/shared/validate';
import { assertReadOnlyQuery, ENDPOINT, GitHubError, graphql, QUERIES, setTransport, type Actor } from '../src/main/github';
import { panelPosition } from '../src/main/placement';
import {
  buildSearchQueries, giveAndTake, hasIgnoredLabel, hasReviewed, humanReviewers, makeLocalDate, myReviewState, needingReviewers,
  reviewedInWindow, shiftDay, splitWaiting, type ReviewNode,
} from '../src/main/rules';

let failures = 0;
const ok = (msg: string) => console.log(`  ok   ${msg}`);
const fail = (msg: string) => {
  failures++;
  console.log(`  FAIL ${msg}`);
};
const expect = (cond: boolean, msg: string) => (cond ? ok(msg) : fail(msg));
const throws = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
const section = (name: string) => console.log(`\n${name}`);

// ---------- dates ----------
section('Dates');
expect(!('error' in parseWindow('2026-11-09', '2026-11-21')), 'accepts a valid window');
expect(!('error' in parseWindow('2026-11-10', '2026-11-10')), 'accepts a one-day window');
expect('error' in parseWindow('2026-11-21', '2026-11-09'), 'rejects reversed dates');
expect('error' in parseWindow('2026-13-01', '2026-13-05'), 'rejects month 13');
expect('error' in parseWindow('2026-02-30', '2026-03-01'), 'rejects Feb 30');
expect('error' in parseWindow('', '2026-11-21'), 'rejects a missing date');
expect('error' in parseWindow('2026-01-01', '2026-12-31'), `rejects windows over ${MAX_WINDOW_DAYS} days`);
expect(shiftDay('2026-11-10', -1) === '2026-11-09' && shiftDay('2026-12-31', 1) === '2027-01-01', 'shiftDay crosses month and year');

// ---------- counting rules ----------
const user = (login: string): Actor => ({ login, __typename: 'User' });
const bot = (login: string): Actor => ({ login, __typename: 'Bot' });
const review = (author: Actor | null, state: string, submittedAt: string | null = '2026-11-12T15:00:00Z'): ReviewNode => ({
  author,
  state,
  submittedAt,
});
// Pinned to a half-hour-offset zone (UTC+5:30) so the edge cases don't depend on the machine running the check.
const local = makeLocalDate('Asia/Kolkata');
const w = { from: '2026-11-10', to: '2026-11-21' };

section('Reviewed in window');
// 19:00 UTC on the 9th is 00:30 on the 10th locally: inside the window although the UTC date isn't.
expect(reviewedInWindow('alice', [review(user('alice'), 'APPROVED', '2026-11-09T19:00:00Z')], w, local), 'a review just after local midnight on the first day counts');
expect(!reviewedInWindow('alice', [review(user('alice'), 'APPROVED', '2026-11-09T18:00:00Z')], w, local), 'a review late on the day before (local) does not count');
// 19:00 UTC on the 21st is 00:30 on the 22nd locally: outside the window although the UTC date isn't.
expect(!reviewedInWindow('alice', [review(user('alice'), 'COMMENTED', '2026-11-21T19:00:00Z')], w, local), 'a review just after the last day ends (local) does not count');
expect(reviewedInWindow('alice', [review(user('alice'), 'COMMENTED', '2026-11-21T18:00:00Z')], w, local), 'a review late on the last day (local) counts');
expect(reviewedInWindow('alice', [review(user('Alice'), 'CHANGES_REQUESTED')], w, local), 'logins match case-insensitively');
expect(reviewedInWindow('alice', [review(user('alice'), 'DISMISSED')], w, local), 'a dismissed review still counts (any state)');
expect(!reviewedInWindow('alice', [review(user('alice'), 'PENDING', null)], w, local), 'an unsent (PENDING) review does not count');
expect(!reviewedInWindow('alice', [review(user('bob'), 'APPROVED')], w, local), "someone else's review does not count");

section('Need reviewers');
expect(humanReviewers('carol', [review(user('a'), 'APPROVED'), review(user('a'), 'COMMENTED')]).length === 1, 'the same reviewer twice counts once');
expect(humanReviewers('carol', [review(user('carol'), 'COMMENTED'), review(user('a'), 'COMMENTED')]).length === 1, "the author's own review doesn't count");
expect(humanReviewers('carol', [review(bot('copilot'), 'COMMENTED'), review(user('dependabot[bot]'), 'APPROVED')]).length === 0, 'bot reviews do not count');
expect(humanReviewers('carol', [review(user('a'), 'PENDING', null), review(user('b'), 'APPROVED')]).length === 1, 'a pending review does not count');
expect(humanReviewers('carol', [review(user('a'), 'DISMISSED'), review(user('b'), 'CHANGES_REQUESTED')]).length === 2, 'any submitted state counts toward the two');
expect(hasIgnoredLabel(['Do Not Review'], ['do not review']) && !hasIgnoredLabel(['bug'], ['do not review']), 'ignore-labels match case-insensitively');

section('Your standing review on a PR');
const at = (day: number) => `2026-11-${String(day).padStart(2, '0')}T12:00:00Z`;
const mine = (state: string, day: number) => review(user('alice'), state, at(day));
expect(myReviewState('alice', []) === null, 'no reviews: none');
expect(myReviewState('alice', [review(user('bob'), 'APPROVED')]) === null, "someone else's approval isn't yours");
expect(myReviewState('alice', [mine('COMMENTED', 10)]) === 'commented', 'only comments: commented');
expect(myReviewState('alice', [mine('CHANGES_REQUESTED', 10)]) === 'changes_requested', 'changes requested');
expect(myReviewState('alice', [mine('APPROVED', 10), mine('COMMENTED', 11)]) === 'approved', 'a comment after approving keeps the approval (as GitHub shows it)');
expect(myReviewState('alice', [mine('CHANGES_REQUESTED', 10), mine('APPROVED', 11)]) === 'approved', 'approving after requesting changes: approved');
expect(myReviewState('alice', [mine('APPROVED', 10), mine('CHANGES_REQUESTED', 11)]) === 'changes_requested', 'requesting changes after approving: changes requested');
// Out of order on purpose: the latest by submittedAt wins, not the latest in the list.
expect(myReviewState('alice', [mine('APPROVED', 12), mine('CHANGES_REQUESTED', 11)]) === 'approved', 'order follows submission time, not list order');
expect(myReviewState('alice', [mine('DISMISSED', 10)]) === 'dismissed', 'a dismissed review: dismissed');
expect(myReviewState('alice', [mine('DISMISSED', 10), mine('COMMENTED', 11)]) === 'dismissed', 'a comment after a dismissal stays dismissed');
expect(myReviewState('alice', [review(user('alice'), 'PENDING', null)]) === null, 'an unsent (PENDING) review is ignored');
expect(myReviewState('alice', [review(user('ALICE'), 'COMMENTED')]) === 'commented', 'logins match case-insensitively');
expect(hasReviewed('alice', [mine('COMMENTED', 10)]) && !hasReviewed('alice', [review(user('bob'), 'APPROVED')]), 'any submitted review takes a PR out of Need reviewers');

section('Waiting on you: Requested and Involved');
const node = (n: number, reviews: ReviewNode[] = []) => ({ url: `https://github.com/o/r/pull/${n}`, reviews: { nodes: reviews } });
const ids = (list: Array<{ url: string }>) => list.map((x) => x.url.split('/').pop()).join(',');
const requestedNodes = [node(1), node(2, [mine('APPROVED', 10)])]; // #2: approved, then re-requested
const reviewedNodes = [
  node(2, [mine('APPROVED', 10)]),
  node(3, [mine('COMMENTED', 10)]),
  node(4, [mine('CHANGES_REQUESTED', 10)]),
  node(5, [mine('APPROVED', 10)]),
  node(6, [mine('DISMISSED', 10)]),
  node(7, [mine('APPROVED', 10), mine('COMMENTED', 11)]),
];
const split = splitWaiting(requestedNodes, reviewedNodes, 'alice');
expect(ids(split.requested) === '1,2', 'Requested keeps every pending request, including a re-request after approving');
expect(ids(split.involved) === '3,4,6', 'Involved: commented, changes requested and dismissed; approved PRs are dropped');
expect(!split.involved.some((x) => split.requested.some((r) => r.url === x.url)), 'a PR is never in both sections (Requested wins)');

section('Give & take');
const by = (author: Actor | null) => ({ author });
const mineWith = (...reviews: ReviewNode[]) => ({ reviews: { nodes: reviews } });
const traded = giveAndTake(
  'alice',
  [by(user('bob')), by(user('Bob')), by(user('carol')), by(bot('dependabot')), by(null), by(user('alice'))],
  [
    mineWith(review(user('bob'), 'APPROVED'), review(user('bob'), 'COMMENTED'), review(user('dave'), 'COMMENTED')),
    mineWith(review(user('dave'), 'CHANGES_REQUESTED'), review(bot('copilot'), 'COMMENTED'), review(null, 'APPROVED')),
    mineWith(review(user('alice'), 'COMMENTED'), review(user('erin'), 'PENDING', null)),
  ],
);
const tradedText = traded.map((p) => `${p.login}:${p.gave}/${p.got}`).join(',');
expect(tradedText === 'bob:2/1,dave:0/2,carol:1/0', `counts each PR once per person, most traded first (${tradedText})`);
expect(!traded.some((p) => /dependabot|copilot|ghost|alice|erin/i.test(p.login)), 'bots, deleted accounts, yourself and unsent reviews are left out');
expect(traded.find((p) => p.login.toLowerCase() === 'bob')?.login === 'bob', 'the same person in different case is one entry');
expect(giveAndTake('alice', [], []).length === 0, 'nothing traded: nobody listed');
expect(giveAndTake('alice', [by(user('zed')), by(user('amy'))], []).map((p) => p.login).join() === 'amy,zed', 'ties are sorted by login');

section('Your PRs waiting');
const own = (n: number, labels: string[], ...reviews: ReviewNode[]) => ({
  n, author: user('alice'), labels: { nodes: labels.map((name) => ({ name })) }, reviews: { nodes: reviews },
});
const ownPrs = [
  own(1, []),
  own(2, [], review(user('bob'), 'APPROVED')),
  own(3, [], review(user('bob'), 'APPROVED'), review(user('carol'), 'COMMENTED')),
  own(4, ['WIP']),
  own(5, [], review(user('alice'), 'COMMENTED'), review(bot('copilot'), 'COMMENTED'), review(user('bob'), 'COMMENTED')),
];
const stillNeed = needingReviewers(ownPrs, ['wip']).map((x) => x.n).join(',');
expect(stillNeed === '1,2,5', `fewer than 2 human reviewers, ignored labels left out; your own and bots' reviews don't count (${stillNeed})`);

section('Review ratio');
// A week's worth of reviews needed for super, unless a test says otherwise.
const r = (reviewed: number, authored: number, min = superMinReviews(7)) => reviewRatio(reviewed, authored, min);
expect(r(4, 2).status === 'good' && r(4, 2).display === '2.00' && r(4, 2).label === 'On target', 'exactly 2.0 is green');
expect(r(7, 4).status === 'warn', 'exactly 1.75 is orange');
expect(r(17, 10).status === 'bad', '1.7 is red');
expect(r(1999, 1000).status === 'good', 'a value shown as 2.00 is green');
expect(r(399, 100).status === 'good', '3.99 is green, not super');
expect(r(40, 10).status === 'super' && SUPER_MESSAGES.includes(r(40, 10).label), '4.0 with 40 reviews is super-powered with a fun message');
expect(r(30, 7).status === 'super', 'exactly 30 reviews at 4.0+ is super (one week)');
expect(r(29, 7).status === 'good' && r(29, 7).label === 'On target · 1 more review to go super', '4.0+ with 29 reviews is green, 1 review short');
expect(r(8, 2).status === 'good' && r(8, 2).label === 'On target · 22 more reviews to go super', '4.0 with 8 reviews is green, 22 reviews short');
expect(r(40, 10, superMinReviews(14)).status === 'good' && r(60, 15, superMinReviews(14)).status === 'super', 'two weeks needs 60 reviews, not 30');
expect(r(5, 1, superMinReviews(1)).status === 'super' && r(4, 1, superMinReviews(1)).status === 'good', 'a single day needs 5 reviews');
expect(r(45, 10).label === r(90, 20).label, 'the same ratio always gets the same message');
expect(r(5, 0).status === 'none' && r(5, 0).value === null, 'no authored PRs: no ratio');

section('Reviews needed for super, by range length');
for (const [days, want] of [[1, 5], [7, 30], [14, 60], [28, 120], [31, 133], [365, 1565], [366, 1569]] as const) {
  expect(superMinReviews(days) === want, `${days} day${days === 1 ? '' : 's'}: ${want} reviews`);
}

section('Reviews to reach target');
expect(r(17, 10).label === 'Below target · review 3 more PRs', '1.7 with 10 authored: review 3 more PRs');
expect(r(7, 4).label === 'Just under target · review 1 more PR', '1.75 with 4 authored: review 1 more PR');
expect(reviewsToTarget(4, 2) === 0 && reviewsToTarget(1999, 1000) === 0, 'nothing more needed when already on target (as shown)');
expect(reviewsToTarget(3, 0) === 0, 'nothing authored: nothing needed');
// The hint must always agree with the rounded number on screen: n more makes it green, n - 1 doesn't.
let hintAgrees = true;
for (let authored = 1; authored <= 300; authored += 7) {
  for (let reviewed = 0; reviewed < authored * 2; reviewed += 3) {
    const n = reviewsToTarget(reviewed, authored);
    if (r(reviewed + n, authored).status !== 'good' && r(reviewed + n, authored).status !== 'super') hintAgrees = false;
    if (n > 0 && r(reviewed + n - 1, authored).value! >= 2) hintAgrees = false;
  }
}
expect(hintAgrees, 'the "N more" hint always matches the rounded ratio (checked across hundreds of cases)');

// ---------- ranges ----------
section('Tracked ranges');
const win = (from: string, to: string) => ({ from, to });
const same = (a: { from: string; to: string }, b: { from: string; to: string }) => a.from === b.from && a.to === b.to;
const week = { kind: 'week' as const, start: '2026-11-02' };
expect(same(periodContaining(week, '2026-11-20'), win('2026-11-16', '2026-11-22')), 'week: the block containing today');
expect(same(periodContaining(week, '2026-11-02'), win('2026-11-02', '2026-11-08')), 'week: the start day begins a block');
expect(same(periodContaining(week, '2026-10-30'), win('2026-10-26', '2026-11-01')), 'week: dates before the start repeat backwards');
const two = { kind: 'twoWeeks' as const, start: '2026-11-09' };
expect(same(periodContaining(two, '2026-11-22'), win('2026-11-09', '2026-11-22')), 'two weeks: last day of a block');
expect(same(periodContaining(two, '2026-11-23'), win('2026-11-23', '2026-12-06')), 'two weeks: rolls over the next day');
const month31 = { kind: 'month' as const, start: '2026-01-31' };
expect(same(periodContaining(month31, '2026-02-27'), win('2026-01-31', '2026-02-27')), 'month from the 31st: ends the day before Feb 28');
expect(same(periodContaining(month31, '2026-02-28'), win('2026-02-28', '2026-03-30')), 'month from the 31st: Feb 28, then back to Mar 31');
expect(same(periodContaining(month31, '2026-03-31'), win('2026-03-31', '2026-04-29')), 'month from the 31st: Mar 31 to Apr 29');
expect(same(periodContaining({ kind: 'month', start: '2028-01-31' }, '2028-02-29'), win('2028-02-29', '2028-03-30')), 'month: Feb 29 in a leap year');
expect(same(periodContaining({ kind: 'month', start: '2026-11-15' }, '2026-11-14'), win('2026-10-15', '2026-11-14')), 'month: the day before the start belongs to the previous month');
const leapYear = { kind: 'year' as const, start: '2028-02-29' };
expect(same(periodContaining(leapYear, '2029-03-01'), win('2029-02-28', '2030-02-27')), 'year from Feb 29: Feb 28 in other years');
expect(same(periodContaining(leapYear, '2032-02-29'), win('2032-02-29', '2033-02-27')), 'year from Feb 29: back on Feb 29 in leap years');
expect(same(periodContaining({ kind: 'year', start: '2026-01-01' }, '2026-12-31'), win('2026-01-01', '2026-12-31')), 'year: Jan 1 to Dec 31');
expect(same(periodContaining({ kind: 'day', start: '2026-11-02' }, '2026-11-20'), win('2026-11-20', '2026-11-20')), 'day: just today');
expect(same(previousPeriod(week, win('2026-11-16', '2026-11-22')), win('2026-11-09', '2026-11-15')), 'previous week');
expect(same(previousPeriod(month31, win('2026-02-28', '2026-03-30')), win('2026-01-31', '2026-02-27')), 'previous month (clamped)');
// Every day for three years, for every kind and some awkward starts: each day is inside its period, and
// periods follow on from each other with no gaps or overlaps.
let tiles = true;
for (const kind of RANGE_KINDS) {
  for (const start of ['2026-01-31', '2026-02-28', '2028-02-29', '2026-11-02', '2027-12-31']) {
    let prev: { from: string; to: string } | null = null;
    for (let day = '2026-01-01'; day <= '2028-12-31'; day = shiftDay(day, 1)) {
      const p = periodContaining({ kind, start }, day);
      if (!(p.from <= day && day <= p.to)) tiles = false;
      if (prev && !same(prev, p) && p.from !== shiftDay(prev.to, 1)) tiles = false;
      prev = p;
    }
  }
}
expect(tiles, 'every kind: each day falls in its period, and periods follow on with no gaps (3 years, 5 starts)');
expect(windowDays(periodContaining({ kind: 'year', start: '2028-01-01' }, '2028-06-01')) === 366, 'a leap year is 366 days');
expect(validRange({ kind: 'week', start: '2026-11-02' }) !== null, 'accepts a valid range');
for (const bad of [{ kind: 'fortnight', start: '2026-11-02' }, { kind: 'week', start: '2026-02-30' }, { kind: 'week', start: '1999-12-31' }, { kind: 'week' }, null, 'week']) {
  expect(validRange(bad) === null, `refuses range ${JSON.stringify(bad)}`);
}

section('Viewing other dates');
const tracked = win('2026-11-16', '2026-11-22');
expect(same(viewWindow({ kind: 'tracked' }, tracked, '2026-11-20'), tracked), 'my range is the tracked period');
expect(same(viewWindow({ kind: 'lastDays', days: 1 }, tracked, '2026-11-20'), win('2026-11-20', '2026-11-20')), 'Today is just today');
expect(same(viewWindow({ kind: 'lastDays', days: 14 }, tracked, '2026-11-20'), win('2026-11-07', '2026-11-20')), 'last 14 days ends today');
expect(same(viewWindow({ kind: 'custom', from: '2026-10-01', to: '2026-10-31' }, tracked, '2026-11-20'), win('2026-10-01', '2026-10-31')), 'custom dates');
expect(!('error' in parseView({ kind: 'lastDays', days: 30 })) && !('error' in parseView({ kind: 'tracked' })), 'accepts preset views');
expect('error' in parseView({ kind: 'lastDays', days: 5 }), 'refuses a "last N days" that is not offered');
expect('error' in parseView({ kind: 'custom', from: '2026-01-01', to: '2026-12-31' }), `refuses custom dates over ${MAX_WINDOW_DAYS} days`);
expect('error' in parseView({ kind: 'custom', from: '2026-11-21', to: '2026-11-09' }), 'refuses reversed custom dates');
expect('error' in parseView({ kind: 'custom', from: '2026-11-09 repo:x', to: '2026-11-21' }), 'refuses injected custom dates');
expect('error' in parseView('tracked') && 'error' in parseView({ kind: 'everything' }), 'refuses anything else');

section('Saved settings (including 0.1.x)');
const old = (from: string, to: string) => validSettings({ owner: 'octo-org', login: 'alice', from, to, ignoreLabels: ['wip'] });
const oldWeek = old('2026-11-09', '2026-11-15');
expect(oldWeek?.range.kind === 'week' && oldWeek.range.start === '2026-11-09', 'an old 7-day window becomes Week from its first day');
expect(old('2026-11-09', '2026-11-22')?.range.kind === 'twoWeeks', 'an old 14-day window becomes Two weeks');
const oldOdd = old('2026-11-09', '2026-11-21');
expect(oldOdd?.range.kind === 'twoWeeks' && oldOdd.range.start === '2026-11-09', 'any other old window becomes Two weeks from its first day');
expect(old('2026-11-21', '2026-11-09') === null, 'an invalid old window is dropped');
const current = validSettings({ owner: 'octo-org', login: 'alice', range: { kind: 'month', start: '2026-11-15' }, ignoreLabels: [] });
expect(current?.range.kind === 'month', 'new-style settings load');
expect(validSettings({ owner: 'octo-org', login: 'alice', range: { kind: 'hour', start: '2026-11-15' }, ignoreLabels: [] }) === null, 'a bad range kind is refused');
expect(validSettings({ owner: 'octo org', login: 'alice', range: { kind: 'week', start: '2026-11-15' }, ignoreLabels: [] }) === null, 'a bad owner is refused');

// ---------- history ----------
section('History');
const S1 = { owner: 'octo-org', login: 'alice', range: { kind: 'week' as const, start: '2026-11-02' }, ignoreLabels: [] };
const S2 = { ...S1, range: { kind: 'twoWeeks' as const, start: '2026-11-02' } };
const t = (n: number) => `2026-11-${String(n).padStart(2, '0')}T12:00:00.000Z`;
const p = (from: string, to: string, authored: number, reviewed: number, final = false) => ({ from, to, authored, reviewed, final });
const h1 = recordPeriod(EMPTY_HISTORY, S1, p('2026-11-02', '2026-11-08', 4, 7), t(3));
expect(EMPTY_HISTORY.series.length === 0, 'recording never changes the history it was given');
expect(h1.series.length === 1 && h1.series[0]!.archivedAt === null && h1.series[0]!.periods.length === 1, 'the first period starts an active series');
const h2 = recordPeriod(h1, S1, p('2026-11-02', '2026-11-08', 5, 9), t(4));
expect(h2.series[0]!.periods.length === 1 && h2.series[0]!.periods[0]!.reviewed === 9, 'the same period is updated, not added twice');
const h3 = recordPeriod(h2, S1, p('2026-11-02', '2026-11-08', 5, 10, true), t(9));
expect(pendingFinalize(h2, S1, win('2026-11-09', '2026-11-15'))?.from === '2026-11-02', 'an ended, unfinished period is waiting to be finalized');
expect(pendingFinalize(h3, S1, win('2026-11-09', '2026-11-15')) === null, 'nothing to finalize once it is final');
expect(pendingFinalize(h2, S1, win('2026-11-02', '2026-11-08')) === null, 'the current period is never finalized early');
expect(recordPeriod(h3, S1, p('2026-11-02', '2026-11-08', 1, 1), t(10)).series[0]!.periods[0]!.reviewed === 10, 'a final period is never overwritten by a live one');
expect(needsChoice(h3, S2)?.periods === 1 && needsChoice(h3, S2)?.kind === 'week', 'a new range with history behind it asks what to do');
expect(needsChoice(h3, { ...S1, ignoreLabels: ['wip'] }) === null, 'changing only the ignored labels does not ask');
expect(needsChoice(h3, { ...S1, owner: 'OCTO-ORG' }) === null, 'the same owner in different case is the same history');
expect(needsChoice(EMPTY_HISTORY, S2) === null, 'no history: nothing to ask');
const archived = switchSeries(h3, S2, 'archive', t(12));
expect(historyView(archived, false, S2).active === null && historyView(archived, false, S2).archived.length === 1, 'archive: the old history is kept read-only');
const h4 = recordPeriod(archived, S2, p('2026-11-16', '2026-11-29', 6, 12), t(17));
expect(historyView(h4, false, S2).active?.kind === 'twoWeeks' && h4.series.length === 2, 'the new range starts its own history');
const resumed = switchSeries(h4, S1, 'archive', t(18));
const resumedView = historyView(resumed, false, S1);
expect(resumedView.active?.kind === 'week' && resumedView.active.periods.length === 1 && resumedView.archived[0]?.kind === 'twoWeeks', 'going back to earlier settings resumes their history');
const deleted = switchSeries(h3, S2, 'delete', t(12));
expect(deleted.series.length === 0, 'delete: the old history is removed');
// Cap: an archived series of 400 periods and an active one of 100, then one more period.
const periodsFrom = (start: string, n: number, final = true) =>
  Array.from({ length: n }, (_, i) => ({ ...p(shiftDay(start, i * 7), shiftDay(start, i * 7 + 6), 1, 2, final), updatedAt: t(1) }));
const big = {
  version: 1,
  series: [
    { owner: 'octo-org', login: 'alice', kind: 'twoWeeks' as const, start: '2000-01-03', startedAt: t(1), archivedAt: t(2), periods: periodsFrom('2000-01-03', 400) },
    { owner: 'octo-org', login: 'alice', kind: 'week' as const, start: '2026-11-02', startedAt: t(2), archivedAt: null, periods: periodsFrom('2024-12-30', 100) },
  ],
};
const capped = recordPeriod(big, S1, p('2026-11-30', '2026-12-06', 1, 1), t(30));
const total = capped.series.reduce((n, s) => n + s.periods.length, 0);
expect(total === MAX_PERIODS && capped.series[0]!.periods.length === 399 && capped.series[1]!.periods.length === 101, `capped at ${MAX_PERIODS} periods, oldest archived ones first`);
const file = JSON.parse(JSON.stringify(h4)) as unknown;
const parsed = parseHistory(file);
expect(!parsed.readOnly && JSON.stringify(parsed.history) === JSON.stringify(h4), 'a saved file reads back the same');
expect(parseHistory({ version: 99, series: [] }).readOnly, 'a file from a newer version is left alone (read-only)');
expect(parseHistory('junk').history.series.length === 0 && parseHistory(null).history.series.length === 0, 'a broken file starts empty');
const tampered = parseHistory({
  version: 1,
  series: [
    { ...h1.series[0], periods: [{ from: '2026-11-02', to: '2026-11-08', authored: -1, reviewed: 3, final: false, updatedAt: t(1) }, h1.series[0]!.periods[0]] },
    { ...h1.series[0], owner: 'bad owner!' },
    { ...h1.series[0], kind: 'twoWeeks' },
  ],
});
expect(tampered.history.series.length === 2 && tampered.history.series[0]!.periods.length === 1, 'invalid series and periods in a hand-edited file are dropped');
expect(tampered.history.series.filter((s) => s.archivedAt === null).length === 1, 'only one series can be active');
const csv = historyCsv(h4).split('\r\n');
expect(csv[0] === '"owner","login","range","range_start","status","from","to","authored","reviewed","ratio","final","reviewed_for","reviewed_by"', 'CSV export has a header');
expect(csv.length === 4 && csv[1]!.includes('"active"') && csv[2]!.includes('"archived"') && csv[1]!.includes('"2.00"'), 'CSV export lists every period, active series first');

section('History: teammates (counts always, logins only when opted in)');
const team: Partner[] = ['bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi'].map((login, i) => ({ login, gave: 7 - i, got: i % 2 }));
const counted = partnerExtras(team, false);
expect(counted.reviewedFor === 7 && counted.reviewedBy === 3 && counted.partners === undefined, 'without the opt-in, only the anonymous counts are kept');
const remembered = partnerExtras(team, true);
expect(remembered.partners?.length === MAX_STORED_PARTNERS && remembered.partners[0]!.login === 'bob', `with it, only the top ${MAX_STORED_PARTNERS} logins are kept`);
expect(partnerExtras([], true).partners === undefined, 'nobody traded: no logins stored');
const withTeam = recordPeriod(EMPTY_HISTORY, S1, { ...p('2026-11-02', '2026-11-08', 4, 7), ...remembered }, t(3));
const roundTrip = parseHistory(JSON.parse(JSON.stringify(withTeam)) as unknown);
// Compared with keys sorted: a period read back lists its fields in a different order.
const canon = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
expect(canon(roundTrip.history) === canon(withTeam), 'remembered teammates read back the same');
const handEdited = parseHistory({
  version: 1,
  series: [{
    ...withTeam.series[0],
    periods: [{
      ...withTeam.series[0]!.periods[0],
      reviewedFor: -2,
      partners: [{ login: 'bad login!', gave: 1, got: 1 }, { login: 'ok', gave: 'x', got: 1 }, ...Array.from({ length: 8 }, (_, i) => ({ login: `p${i}`, gave: 1, got: 0 }))],
    }],
  }],
});
const editedPeriod = handEdited.history.series[0]!.periods[0]!;
expect(
  editedPeriod.reviewedFor === undefined && editedPeriod.reviewedBy === 3 && editedPeriod.partners?.length === MAX_STORED_PARTNERS && editedPeriod.partners[0]!.login === 'p0',
  'bad extras in a hand-edited file are dropped, the period is kept, and at most 5 logins survive',
);
const forgot = forgetPartners(switchSeries(withTeam, S2, 'archive', t(5)));
expect(forgot.series.every((x) => x.periods.every((pp) => pp.partners === undefined)) && forgot.series[0]!.periods[0]!.reviewedFor === 7, 'forgetting removes every login, archived too, and keeps the counts');
expect(!JSON.stringify(forgot).includes('bob'), 'no login is left anywhere in the file');
expect(forgetPartners(h4) === h4, 'nothing to forget: unchanged');
const teamCsv = historyCsv(withTeam);
expect(teamCsv.split('\r\n')[0]!.endsWith(',"reviewed_for","reviewed_by"') && teamCsv.includes('"7","3"'), 'CSV export has the anonymous counts as its last columns');
expect(!/bob|carol|dave/.test(teamCsv), 'CSV export never includes teammate logins');
expect(isPeriodKey('2026-11-02|2026-11-08') && !isPeriodKey('2026-11-02') && !isPeriodKey('x|y') && !isPeriodKey(42), 'period keys are checked');

section('Period recap');
const recapSeries = (periods: Array<{ from: string; to: string; authored: number; reviewed: number; final?: boolean }>): Series => ({
  owner: 'octo-org', login: 'alice', kind: 'week', start: '2026-10-05', startedAt: t(1), archivedAt: null,
  periods: periods.map((x) => ({ ...x, final: x.final ?? true, updatedAt: t(1) })),
});
const wk = (i: number, authored: number, reviewed: number, final = true) =>
  ({ from: shiftDay('2026-10-05', i * 7), to: shiftDay('2026-10-05', i * 7 + 6), authored, reviewed, final });
const rs = recapSeries([wk(0, 2, 1), wk(1, 2, 4), wk(2, 0, 3), wk(3, 4, 9), wk(4, 2, 1, false)]);
const rp = (i: number) => periodRecap(rs, rs.periods[i]!);
expect(rp(0).delta === null && rp(0).streak === 0, 'the first period has nothing to compare with, and below target has no streak');
expect(rp(1).delta === 1.5 && rp(1).streak === 1, 'change from the period before (0.50 → 2.00)');
expect(rp(2).streak === 2 && rp(2).delta === null, 'reviewing while opening nothing keeps the streak going (but has no ratio to compare)');
expect(rp(3).streak === 3 && rp(3).delta === null, 'streak counts back-to-back periods at target; no ratio before means no change shown');
expect(rp(4).streak === 0 && rp(4).delta === -1.75, 'dropping below target ends the streak, and the drop is shown');
const gappy = recapSeries([wk(0, 1, 2), wk(2, 1, 2)]);
expect(periodRecap(gappy, gappy.periods[1]!).streak === 1 && periodRecap(gappy, gappy.periods[1]!).delta === null, 'a missing period breaks the streak and the comparison');
const idle = recapSeries([wk(0, 1, 2), wk(1, 0, 0)]);
expect(periodRecap(idle, idle.periods[1]!).streak === 0, 'a period with no activity at all is not on target');
expect(periodRecap(recapSeries([{ ...wk(0, 1, 2) }]), { ...wk(0, 1, 2), updatedAt: t(1), partners: [{ login: 'bob', gave: 2, got: 1 }] }).topPartner?.login === 'bob', 'the top remembered teammate is named');
const now5 = { from: shiftDay('2026-10-05', 35), to: shiftDay('2026-10-05', 41) };
expect(pendingRecap(rs, now5, null)?.from === wk(3, 0, 0).from, 'the recap that shows by itself is the newest locked-in period (partial ones are skipped)');
expect(pendingRecap(rs, now5, `${wk(3, 0, 0).from}|${wk(3, 0, 0).to}`) === null, 'once dismissed, it stays dismissed');
expect(pendingRecap(rs, { from: wk(3, 0, 0).from, to: wk(3, 0, 0).to }, null)?.from === wk(2, 0, 0).from, 'the period in progress never has a recap');
expect(pendingRecap(null, now5, null) === null, 'no history: no recap');

section('Copying your PRs');
const ownPr = (n: number, title: string, url = `https://github.com/octo-org/api/pull/${n}`): PrSummary =>
  ({ repo: 'octo-org/api', number: n, title, url, author: 'alice', createdAt: '2026-11-15T10:00:00Z' });
const copied = prLinksText([ownPr(412, 'Add retry to webhook sender'), ownPr(88, 'Fix\nthe\u202edate\tpicker  ')]);
expect(
  copied === `${COPY_HEADER}\n- api#412 Add retry to webhook sender https://github.com/octo-org/api/pull/412\n- api#88 Fix the date picker https://github.com/octo-org/api/pull/88`,
  'one PR per line: repo#number, title and link; line breaks and direction overrides in titles are flattened',
);
expect(prLinksText([ownPr(1, 'Settings', 'https://github.com/settings/personal-access-tokens'), ownPr(2, 'Evil', 'https://github.com.evil.example/o/r/pull/2')]) === '', 'only pull-request links on github.com are copied');
expect(prLinksText([]) === '', 'nothing to copy: empty');
expect(prLinksText([ownPr(3, 'x'.repeat(500))]).split('\n')[1]!.length < 200, 'very long titles are shortened');
expect(prLinksText(Array.from({ length: 150 }, (_, i) => ownPr(i + 1, 'PR'))).split('\n').length === MAX_COPIED_PRS + 1, `at most ${MAX_COPIED_PRS} PRs are copied`);

// ---------- tray dot ----------
section('Tray status dot');
const blank = new Uint8Array(16 * 16 * 4);
const dotted = paintDot(blank, 16, DOT_COLORS.good);
const px = (x: number, y: number) => Array.from(dotted.slice((y * 16 + x) * 4, (y * 16 + x) * 4 + 4));
expect(blank.every((v) => v === 0), 'the original icon pixels are not modified');
expect(px(12, 12).join() === [DOT_COLORS.good[2], DOT_COLORS.good[1], DOT_COLORS.good[0], 255].join(), 'the dot is drawn in the bottom-right corner (BGRA, opaque)');
expect(px(0, 0).join() === '0,0,0,0' && px(8, 2).join() === '0,0,0,0', 'the rest of the icon is untouched');
expect(px(15, 12)[3]! > 0 && px(15, 12)[3]! < 255 || px(15, 12).join() === '0,0,0,0', 'the edge of the dot is anti-aliased or clear');

// ---------- validation and injection ----------
section('Usernames and organizations');
for (const good of ['octocat', 'octo-org', 'a', 'A1-b2', 'alice_acme', 'x'.repeat(MAX_LOGIN_LENGTH)]) {
  expect(isValidLogin(good), `accepts "${good.length > 12 ? good.slice(0, 12) + '…' : good}"`);
}
for (const bad of ['', '-lead', '_lead', 'trail-', 'two--hyphens', 'x'.repeat(MAX_LOGIN_LENGTH + 1), 'alice repo:victim/private', 'alice\nrepo:x', 'a"b', 'org:other', 'a b', 'ünï']) {
  expect(!isValidLogin(bad), `rejects ${JSON.stringify(bad)}`);
}

section('Search queries');
const q = buildSearchQueries('Organization', 'octo-org', 'alice', w);
expect(q.authored === 'org:octo-org is:pr author:alice created:2026-11-09..2026-11-22', 'authored query (org scope, widened a day each side)');
expect(q.reviewed === 'org:octo-org is:pr reviewed-by:alice -author:alice updated:>=2026-11-09', 'reviewed query');
expect(q.open === 'org:octo-org is:pr is:open draft:false', 'open-PR query');
expect(q.waiting === 'org:octo-org is:pr is:open draft:false review-requested:alice', 'waiting-on-you query');
expect(q.involved === 'org:octo-org is:pr is:open draft:false reviewed-by:alice -author:alice', 'involved query');
expect(q.mine === 'org:octo-org is:pr is:open draft:false author:alice', 'your-PRs query');
expect(buildSearchQueries('User', 'alice', 'alice', w).open.startsWith('user:alice '), 'user scope uses user:');
expect(throws(() => buildSearchQueries('Organization', 'octo-org repo:victim/x', 'alice', w)), 'an injected owner is refused');
expect(throws(() => buildSearchQueries('Organization', 'octo-org', 'alice OR is:open', w)), 'an injected login is refused');
expect(throws(() => buildSearchQueries('Organization', 'octo-org', 'alice', { from: '2026-11-09 repo:x', to: '2026-11-21' })), 'injected dates are refused');

section('Labels');
const labels = parseLabels(' Do Not Review , wip,WIP ');
expect(Array.isArray(labels) && labels.join('|') === 'do not review|wip', 'labels are trimmed, lower-cased and de-duplicated');
expect(!Array.isArray(parseLabels('a,'.repeat(11))), 'too many labels are refused');
expect(!Array.isArray(parseLabels('x'.repeat(51))), 'an over-long label is refused');
expect(!Array.isArray(parseLabels('bad\u0000label')), 'control characters are refused');

section('Need-reviewers view (sort, group, label filter)');
const waiting = (repo: string, number: number, createdAt: string, labels: string[]): PrSummary => ({
  repo, number, title: `#${number}`, url: `https://github.com/${repo}/pull/${number}`, author: 'bob', createdAt, labels,
});
const backlog = [
  waiting('octo-org/web', 3, '2026-11-12T10:00:00Z', ['Frontend']),
  waiting('octo-org/api', 1, '2026-11-03T10:00:00Z', ['backend']),
  waiting('octo-org/web', 2, '2026-11-05T10:00:00Z', []),
  waiting('octo-org/api', 4, '2026-11-18T10:00:00Z', ['backend', 'frontend']),
];
const nums = (prs: PrSummary[]) => prs.map((p) => p.number).join(',');
const flat = applyPrView(backlog, DEFAULT_PR_VIEW);
expect(flat.groups.length === 1 && flat.groups[0]!.repo === null && nums(flat.groups[0]!.prs) === '1,2,3,4', 'default: one list, oldest first');
expect(nums(applyPrView(backlog, { ...DEFAULT_PR_VIEW, sort: 'newest' }).groups[0]!.prs) === '4,3,2,1', 'newest first reverses the order');
expect(nums(backlog) === '3,1,2,4', 'applying a view does not reorder the original list');
const grouped = applyPrView(backlog, { ...DEFAULT_PR_VIEW, groupByRepo: true });
expect(
  grouped.groups.map((g) => g.repo).join('|') === 'octo-org/api|octo-org/web' && nums(grouped.groups[0]!.prs) === '1,4' && nums(grouped.groups[1]!.prs) === '2,3',
  'grouped: repos alphabetical, each oldest first',
);
const fe = applyPrView(backlog, { ...DEFAULT_PR_VIEW, labels: ['frontend'] });
expect(nums(fe.groups[0]!.prs) === '3,4' && fe.shown === 2, 'label filter matches case-insensitively');
expect(applyPrView(backlog, { ...DEFAULT_PR_VIEW, labels: ['frontend', 'backend'] }).shown === 3, 'several labels match any of them');
expect(applyPrView(backlog, { ...DEFAULT_PR_VIEW, labels: ['security'] }).shown === 0, 'a label no PR has shows nothing');
expect(applyPrView(backlog, { ...DEFAULT_PR_VIEW, groupByRepo: true, labels: ['security'] }).groups.length === 0, 'no empty repo groups');
expect(labelOptions(backlog, ['security']).join('|') === 'backend|frontend|security', 'label options: lower-cased, de-duplicated, sorted, keep selected');
const pv = parsePrView({ groupByRepo: true, sort: 'newest', labels: [' Frontend ', 'frontend'] });
expect(pv?.groupByRepo === true && pv.sort === 'newest' && pv.labels.join('|') === 'frontend', 'a stored view is accepted (labels trimmed, lower-cased, de-duplicated)');
for (const [bad, why] of [
  [null, 'not an object'],
  [{ groupByRepo: 'yes', sort: 'oldest', labels: [] }, 'a non-boolean groupByRepo'],
  [{ groupByRepo: false, sort: 'random', labels: [] }, 'an unknown sort'],
  [{ groupByRepo: false, sort: 'oldest', labels: 'frontend' }, 'labels that are not a list'],
  [{ groupByRepo: false, sort: 'oldest', labels: [1] }, 'a non-string label'],
  [{ groupByRepo: false, sort: 'oldest', labels: Array.from({ length: 11 }, (_, i) => `l${i}`) }, 'too many labels'],
  [{ groupByRepo: false, sort: 'oldest', labels: ['x'.repeat(51)] }, 'an over-long label'],
  [{ groupByRepo: false, sort: 'oldest', labels: ['bad\u0000'] }, 'a control character'],
  [{ groupByRepo: false, sort: 'oldest', labels: ['a,b'] }, 'a comma inside a label'],
] as const) {
  expect(parsePrView(bad) === null, `a stored view with ${why} is refused`);
}

section('Tokens');
const fine = `github_pat_${'A1b2'.repeat(10)}`;
expect('token' in checkToken(` ${fine} `), 'a fine-grained token is accepted (and trimmed)');
expect('error' in checkToken(`ghp_${'a'.repeat(36)}`), 'a classic token is refused');
expect('error' in checkToken('hello'), 'junk is refused');
expect('error' in checkToken(''), 'empty is refused');
expect(redact(`failed for ${fine} and ghp_${'b'.repeat(36)}`) === 'failed for [redacted] and [redacted]', 'tokens are redacted from messages');

section('Read-only GraphQL allowlist');
expect(Object.values(QUERIES).every((doc) => !throws(() => assertReadOnlyQuery(doc))), 'every built-in query is allowed');
expect(throws(() => assertReadOnlyQuery('mutation { deleteRepository(input: {}) { clientMutationId } }')), 'a mutation is refused');
expect(throws(() => assertReadOnlyQuery('query { viewer { login } }')), 'a query that is not on the allowlist is refused');
expect(Object.values(QUERIES).every((doc) => /^\s*query\b/.test(doc) && !/\bmutation\b/i.test(doc)), 'no built-in document is a mutation');

section('Link allowlist');
for (const good of ['https://github.com/octo-org/web.app/pull/12', 'https://github.com/settings/personal-access-tokens']) {
  expect(allowedGitHubLink(good) === good, `opens ${good}`);
}
expect(allowedGitHubLink('https://GITHUB.com/octo-org/repo/pull/1') === 'https://github.com/octo-org/repo/pull/1', 'opens the normalized form, not the raw string');
for (const bad of [
  'http://github.com/octo-org/repo/pull/1',
  'https://github.com.evil.example/octo-org/repo/pull/1',
  'https://evil.example/github.com/octo-org/repo/pull/1',
  'https://user@github.com/octo-org/repo/pull/1',
  'https://github.com:8443/octo-org/repo/pull/1',
  'https://github.com/login/oauth/authorize?client_id=x',
  'https://github.com/apps/some-app/installations/new',
  'https://github.com/octo-org/repo/pull/1?evil=1',
  'https://github.com/octo-org/repo/settings',
  'javascript:alert(1)',
  'file:///C:/Windows/System32/calc.exe',
  'not a url',
]) {
  expect(allowedGitHubLink(bad) === null, `refuses ${bad}`);
}

section('GitHub transport (with a fake network)');
const fineToken = `github_pat_${'Z9y8'.repeat(10)}`;
const calls: Array<{ url: string; init: RequestInit }> = [];
const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  setTransport(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  });
respond(200, { data: { viewer: { login: 'alice' } } });
const viewer = await graphql<{ viewer: { login: string } }>(fineToken, QUERIES.viewer);
const sent = calls[0]!;
expect(viewer.viewer.login === 'alice', 'a query returns its data');
expect(sent.url === ENDPOINT && ENDPOINT === 'https://api.github.com/graphql', 'requests go only to https://api.github.com/graphql');
expect(sent.init.redirect === 'error', 'redirects are refused (the token is never forwarded)');
expect(new Headers(sent.init.headers).get('authorization') === `Bearer ${fineToken}`, 'the token travels only in the Authorization header');
expect(!String(sent.init.body).includes(fineToken), 'the token is never in the request body');
let threw: unknown = await graphql(fineToken, 'mutation { x }').then(() => null, (e) => e);
expect(threw instanceof Error && calls.length === 1, 'a mutation is refused before anything is sent');
respond(429, { message: 'slow down' }, { 'retry-after': '120' });
threw = await graphql(fineToken, QUERIES.viewer).then(() => null, (e) => e);
expect(threw instanceof GitHubError && (threw.retryAt ?? 0) >= Date.now() + 110_000, 'a rate limit (429) reports when to try again');
respond(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' });
threw = await graphql(fineToken, QUERIES.viewer).then(() => null, (e) => e);
expect(threw instanceof GitHubError && (threw.retryAt ?? 0) >= Date.now() + 55_000, 'a rate limit with no reset time still waits at least a minute');
respond(401, { message: 'Bad credentials' });
threw = await graphql(fineToken, QUERIES.viewer).then(() => null, (e) => e);
expect(threw instanceof GitHubError && /token/i.test(threw.message) && !threw.message.includes(fineToken), 'a rejected token gives a clear message without the token');
respond(200, { errors: [{ message: `Bad token ${fineToken}` }] });
threw = await graphql(fineToken, QUERIES.viewer).then(() => null, (e) => e);
expect(threw instanceof GitHubError && !threw.message.includes(fineToken) && threw.message.includes('[redacted]'), 'GitHub error messages are redacted');

// ---------- panel placement ----------
section('Panel placement (1920x1080 display, 380x600 panel)');
const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
const size = { width: 380, height: 600 };
const inside = (p: { x: number; y: number }, wa: typeof bounds) =>
  p.x >= wa.x && p.y >= wa.y && p.x + size.width <= wa.x + wa.width && p.y + size.height <= wa.y + wa.height;
const bottom = { x: 0, y: 0, width: 1920, height: 1032 };
const pb = panelPosition({ x: 1800, y: 1040, width: 24, height: 24 }, { bounds, workArea: bottom }, size, 'win32');
expect(inside(pb, bottom) && pb.y + size.height === 1032 - 8, 'bottom taskbar: panel sits just above it');
const top = { x: 0, y: 48, width: 1920, height: 1032 };
const pt = panelPosition({ x: 1800, y: 12, width: 24, height: 24 }, { bounds, workArea: top }, size, 'win32');
expect(inside(pt, top) && pt.y === 48 + 8, 'top taskbar: panel sits just below it');
const left = { x: 60, y: 0, width: 1860, height: 1080 };
const pl = panelPosition({ x: 18, y: 900, width: 24, height: 24 }, { bounds, workArea: left }, size, 'win32');
expect(inside(pl, left) && pl.x === 60 + 8, 'left taskbar: panel sits beside it');
const right = { x: 0, y: 0, width: 1860, height: 1080 };
const pr = panelPosition({ x: 1878, y: 900, width: 24, height: 24 }, { bounds, workArea: right }, size, 'win32');
expect(inside(pr, right) && pr.x + size.width === 1860 - 8, 'right taskbar: panel sits beside it');
const menuBar = { x: 0, y: 25, width: 1920, height: 1055 };
const pm = panelPosition({ x: 1700, y: 0, width: 22, height: 24 }, { bounds, workArea: menuBar }, size, 'darwin');
expect(inside(pm, menuBar) && pm.y === 25 + 8, 'Mac menu bar: panel drops down below it');
const corner = panelPosition({ x: 1910, y: 1040, width: 24, height: 24 }, { bounds, workArea: bottom }, size, 'win32');
expect(inside(corner, bottom), 'an icon in the far corner still keeps the panel on screen');

// ---------- color contrast (read straight from styles.css) ----------
section('Color contrast (4.5:1 minimum for text)');
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(appDir, 'src/renderer/styles.css'), 'utf8');
const tokens = (block: string) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1]!, m[2]!]));
const lightTokens = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')));
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const darkTokens = { ...lightTokens, ...tokens(css.slice(darkStart, css.indexOf('\n}\n', darkStart))) };
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (c: number[]) => {
  const [r2, g, b] = c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r2! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: number[], b: number[]) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** color-mix(in srgb, fg p%, transparent) laid over bg. */
const tint = (fg: string, p: number, bg: string) => rgb(fg).map((v, i) => v * p + rgb(bg)[i]! * (1 - p));
for (const [name, t] of [
  ['light', lightTokens],
  ['dark', darkTokens],
] as const) {
  const pairs: Array<[string, number[], number[]]> = [
    ['text on panel', rgb(t.text!), rgb(t.panel!)],
    ['text on card', rgb(t.text!), rgb(t.card!)],
    ['muted on panel', rgb(t.muted!), rgb(t.panel!)],
    ['muted on card', rgb(t.muted!), rgb(t.card!)],
    ['button text on accent', rgb(t['accent-text']!), rgb(t.accent!)],
    ['accent badge on card', rgb(t.accent!), tint(t.accent!, 0.12, t.card!)],
    ['accent icon on card', rgb(t.accent!), tint(t.accent!, 0.14, t.card!)],
    ['error text', rgb(t['error-text']!), rgb(t['error-bg']!)],
    ['ratio green', rgb(t.good!), rgb(t['good-bg']!)],
    ['ratio orange', rgb(t.warn!), rgb(t['warn-bg']!)],
    ['ratio red', rgb(t.bad!), rgb(t['bad-bg']!)],
    ['neutral status tag on card', rgb(t.text!), tint(t.muted!, 0.16, t.card!)],
    ['warning status tag', rgb(t.warn!), rgb(t['warn-bg']!)],
  ];
  for (const [label, fg, bg] of pairs) {
    const c = contrast(fg, bg);
    expect(c >= 4.5, `${name}: ${label} ${c.toFixed(2)}:1`);
  }
}
for (const stop of ['#4c1d95', '#9d174d', '#b45309']) {
  const c = contrast(rgb('#ffffff'), rgb(stop));
  expect(c >= 4.5, `super card: white on ${stop} ${c.toFixed(2)}:1`);
}

// ---------- source scan ----------
section('Source scan');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const source = files(join(appDir, 'src')).map((f) => ({ path: relative(appDir, f).replaceAll('\\', '/'), text: readFileSync(f, 'utf8') }));
const offenders = (re: RegExp, only?: (path: string) => boolean) =>
  source.filter((f) => (!only || only(f.path)) && re.test(f.text)).map((f) => f.path);
const none = (list: string[], msg: string) => expect(list.length === 0, `${msg}${list.length ? `: ${list.join(', ')}` : ''}`);

none(offenders(/innerHTML|dangerouslySetInnerHTML|outerHTML|insertAdjacentHTML|document\.write/), 'no raw HTML injection');
none(offenders(/\beval\s*\(|new Function\s*\(/), 'no eval or new Function');
none(offenders(/nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false|webSecurity:\s*false|allowRunningInsecureContent/), 'no weakened Electron settings');
none(offenders(/\bfetch\s*\(/, (p) => p !== 'src/main/transport.ts'), 'only src/main/transport.ts makes network requests');
none(offenders(/data:/, (p) => p === 'src/renderer/index.html' || p === 'src/main/security.ts'), 'the CSP allows no data: URLs');
none(offenders(/http:\/\//), 'no plain-http URLs');
none(offenders(/child_process|execFile|\bspawn\(|shell\.openPath|shell\.openExternal/, (p) => p !== 'src/main/security.ts'), 'no shell commands; only security.ts opens links');
none(offenders(/from ['"](\.\.\/main|electron)/, (p) => p.startsWith('src/renderer/')), 'the UI never imports Electron or main-process code');
none(offenders(/from ['"](?!electron['"]|\.\.\/shared\/)/, (p) => p.startsWith('src/preload/')), 'the preload only imports electron and shared types');
none(offenders(/exposeInMainWorld\([^)]*ipcRenderer\s*\)/), 'raw ipcRenderer is never exposed');
const mainSrc = source.find((f) => f.path === 'src/main/main.ts')?.text ?? '';
expect(/^refuseDangerousSwitches\(\);/m.test(mainSrc), 'main.ts refuses unsafe Chromium switches at startup');
const html = source.find((f) => f.path === 'src/renderer/index.html')?.text ?? '';
expect(/connect-src 'none'/.test(html) && /script-src 'self'/.test(html), "index.html CSP blocks network access and foreign scripts");
const security = source.find((f) => f.path === 'src/main/security.ts')?.text ?? '';
expect(/"connect-src 'none'"/.test(security) && !/unsafe-inline|unsafe-eval/.test(security), 'the CSP response header blocks network access, inline and eval');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
