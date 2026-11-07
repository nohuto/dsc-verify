import { CSRF_HEADER, ROUTES } from '../shared/browser-contract';
import type { StatusResponse, TurnstileChallenge } from '../shared/browser-contract';
import {
  describe,
  parseAuthorizeUrl,
  parseReply,
  pollDelay,
  readCapability,
  withWait,
} from './status-view';
import type { Fetched, Phase, Problem, Reply, View } from './status-view';
import { mountArt } from './substrate-art';

const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
// above the 8 second server upstream timeout, a slow provider must not look offline
const REQUEST_TIMEOUT_MS = 20_000;

type TurnstileOptions = {
  readonly sitekey: string;
  readonly action: string;
  readonly cData: string;
  readonly callback: (token: string) => void;
  readonly 'expired-callback': () => void;
  readonly 'error-callback': () => void;
};

type Turnstile = {
  render(container: HTMLElement, options: TurnstileOptions): string | undefined;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
};

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

type Action = {
  readonly label: string;
  readonly run: () => void;
};

type Screen = Pick<View, 'heading' | 'message' | 'guidance'>;

function pick<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
}

const heading = pick('#heading');
const message = pick('#message');
const guidance = pick('#guidance');
const spinner = pick('#spinner');
const widgetBox = pick('#challenge');
const button = pick<HTMLButtonElement>('#action');

let status: StatusResponse | undefined;
let phase: Phase | undefined;
let csrf: string | undefined;
let action: Action | undefined;
let busy = false;
let tries = 0;
let holdUntil = 0;
let timer: number | undefined;
let turnstileLoad: Promise<Turnstile> | undefined;
let widgetId: string | undefined;

const checkAgain: Action = { label: 'Check again', run: refresh };

// rewriting identical text would make screen readers repeat the live region on every poll
function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

// aria-disabled rather than disabled, as a disabled button drops keyboard focus
function syncButton(): void {
  button.setAttribute('aria-disabled', String(busy || Date.now() < holdUntil));
}

function paint(screen: Screen, next?: Action, progress = false): void {
  setText(heading, screen.heading);
  setText(message, screen.message);
  setText(guidance, screen.guidance);
  guidance.hidden = screen.guidance === '';
  spinner.hidden = !progress;
  const refocus = !next && document.activeElement === button;
  action = next;
  button.hidden = !next;
  if (next) setText(button, next.label);
  if (refocus) heading.focus();
  syncButton();
}

function exclusive(task: () => Promise<void>): void {
  if (busy) return;
  busy = true;
  syncButton();
  task()
    .catch(() => {
      paint(
        { heading: 'Something went wrong', message: 'Please try again.', guidance: '' },
        checkAgain,
      );
    })
    .finally(() => {
      busy = false;
      syncButton();
    });
}

async function call(path: string, payload?: object): Promise<Fetched | undefined> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (payload) headers['content-type'] = 'application/json';
  if (payload && csrf) headers[CSRF_HEADER] = csrf;
  try {
    const response = await fetch(path, {
      method: payload ? 'POST' : 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(payload && { body: JSON.stringify(payload) }),
    });
    const body: unknown = await response.json().catch(() => undefined);
    return { http: response.status, body };
  } catch {
    return undefined;
  }
}

function removeWidget(): void {
  if (widgetId !== undefined) window.turnstile?.remove(widgetId);
  widgetId = undefined;
  widgetBox.hidden = true;
}

function restart(problem: Problem): void {
  window.clearTimeout(timer);
  removeWidget();
  status = undefined;
  phase = undefined;
  paint({
    heading: 'Start again from Discord',
    message: withWait(problem.message, problem.retryAfterSeconds),
    guidance: '',
  });
}

function schedulePoll(delay: number): void {
  if (!document.hidden) timer = window.setTimeout(poll, delay);
}

function poll(): void {
  tries += 1;
  refresh();
}

function show(next: StatusResponse): void {
  const view = describe(next);
  if (view.phase !== phase) tries = 0;
  phase = view.phase;
  const settled = { ...next, retryAfterSeconds: 0 };
  status = settled;
  csrf = next.csrfToken ?? csrf;
  const wait = (next.retryAfterSeconds ?? 0) * 1_000;
  holdUntil = Date.now() + wait;
  window.clearTimeout(timer);
  if (view.phase !== 'challenge') removeWidget();

  switch (view.phase) {
    case 'oauth':
      paint(view, { label: 'Continue with Discord', run: startOAuth });
      if (wait > 0) timer = window.setTimeout(() => show(settled), wait);
      break;
    case 'challenge': {
      const { challenge } = next;
      if (!challenge && widgetId === undefined) {
        paint(view, checkAgain);
        break;
      }
      paint(view);
      widgetBox.hidden = false;
      const delay = widgetId === undefined ? wait : Math.max(wait, pollDelay(tries++));
      timer = window.setTimeout(() => {
        paint(describe(settled));
        if (widgetId !== undefined) window.turnstile?.reset(widgetId);
        else if (challenge) mountWidget(challenge);
      }, delay);
      break;
    }
    case 'progress':
      paint(view, tries > 0 ? checkAgain : undefined, true);
      schedulePoll(Math.max(wait, pollDelay(tries)));
      break;
    case 'final':
      paint(view);
      break;
  }
}

function showProblem(problem: Problem): void {
  if (problem.restart) {
    restart(problem);
    return;
  }
  if (status) {
    show({ ...status, ...problem });
    return;
  }
  const wait = (problem.retryAfterSeconds ?? 0) * 1_000;
  holdUntil = Date.now() + wait;
  const text = withWait(problem.message, problem.retryAfterSeconds);
  paint({ heading: 'Something went wrong', message: text, guidance: '' }, checkAgain);
  if (wait > 0)
    timer = window.setTimeout(() => showProblem({ ...problem, retryAfterSeconds: 0 }), wait);
}

function apply(reply: Reply): void {
  if ('status' in reply) show(reply.status);
  else showProblem(reply.problem);
}

function refresh(): void {
  exclusive(async () => {
    apply(parseReply(await call(ROUTES.session)));
  });
}

function exchange(capability: string, mayRetry: boolean): void {
  exclusive(async () => {
    const fetched = await call(ROUTES.session, { capability });
    const reply = parseReply(fetched);
    if ('status' in reply) show(reply.status);
    else if (!fetched && mayRetry) {
      paint(
        { heading: 'Connection problem', message: reply.problem.message, guidance: '' },
        { label: 'Try again', run: () => exchange(capability, false) },
      );
    } else restart(reply.problem);
  });
}

function startOAuth(): void {
  exclusive(async () => {
    const fetched = await call(ROUTES.oauthStart, {});
    const url = parseAuthorizeUrl(fetched?.body);
    if (!url) {
      apply(parseReply(fetched));
      return;
    }
    paint(
      { heading: 'Opening Discord', message: 'Taking you to Discord to sign in.', guidance: '' },
      undefined,
      true,
    );
    location.assign(url);
  });
}

function submit(token: string): void {
  exclusive(async () => {
    window.clearTimeout(timer);
    paint(
      { heading: 'Checking your result', message: 'This takes a few seconds.', guidance: '' },
      undefined,
      true,
    );
    apply(parseReply(await call(ROUTES.verify, { token })));
  });
}

function loadTurnstile(): Promise<Turnstile> {
  turnstileLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const fail = (): void => {
      script.remove();
      turnstileLoad = undefined;
      reject(new Error('Turnstile did not load'));
    };
    script.src = TURNSTILE_URL;
    script.addEventListener('error', fail);
    script.addEventListener('load', () => {
      if (window.turnstile) resolve(window.turnstile);
      else fail();
    });
    document.head.append(script);
  });
  return turnstileLoad;
}

function widgetFailed(): void {
  paint(
    {
      heading: 'Browser check',
      message:
        "The browser check couldn't load, turn off content blockers for this page and try again.",
      guidance: '',
    },
    {
      label: 'Try again',
      run: () => {
        if (status) show(status);
      },
    },
  );
}

function mountWidget(challenge: TurnstileChallenge): void {
  loadTurnstile()
    .then((turnstile) => {
      if (phase !== 'challenge' || widgetId !== undefined) return;
      widgetId = turnstile.render(widgetBox, {
        sitekey: challenge.siteKey,
        action: challenge.action,
        cData: challenge.cdata,
        callback: submit,
        'expired-callback': () => {
          setText(message, "The browser check expired, it's refreshing now.");
        },
        'error-callback': widgetFailed,
      });
      if (widgetId === undefined) widgetFailed();
    })
    .catch(widgetFailed);
}

button.addEventListener('click', () => {
  if (!busy && Date.now() >= holdUntil) action?.run();
});

document.addEventListener('visibilitychange', () => {
  if (phase !== 'progress') return;
  window.clearTimeout(timer);
  schedulePoll(Math.max(0, holdUntil - Date.now()));
});

// returning from discord through the back/forward cache leaves "Opening Discord" on screen
window.addEventListener('pageshow', (event) => {
  if (event.persisted) refresh();
});

const entry = readCapability(location.hash);
if (entry === undefined) {
  refresh();
} else {
  history.replaceState(null, '', location.pathname);
  exchange(entry, true);
}

// waits for idle so it never delays the verification requests
const art = document.querySelector<HTMLElement>('.art');
const main = document.querySelector('main');
if (art && main) {
  const start = (): void => mountArt(art, main);
  if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 2000 });
  else window.setTimeout(start, 200);
}
