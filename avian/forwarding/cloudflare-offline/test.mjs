/*
 * Exercises worker.js's fallback branches against a stubbed origin.
 *
 * The worker only ever earns its keep when the station is down, which is
 * exactly the state that is awkward to reach on purpose in production -
 * so the decision table is checked here instead. Run: node test.mjs
 */
import worker from './worker.js';

const REQ = () => new Request('https://birds.7ml.in/');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`); failures++; }
}

async function withOrigin(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const isOffline = (r) => r.status === 503 && r.headers.get('x-avian-offline') === '1';

console.log('\npass-through: a station that answers');
// 204/304 are null-body statuses - the Response constructor rejects a body
// on them, so the stub has to be honest about that or it throws and the
// worker (correctly) reads the throw as a dead origin.
const NULL_BODY = new Set([204, 304]);
for (const status of [200, 204, 301, 401, 404, 429]) {
  const res = await withOrigin(
    async () => new Response(NULL_BODY.has(status) ? null : 'live collage',
                             { status, headers: { 'x-from': 'origin' } }),
    () => worker.fetch(REQ())
  );
  check(`${status} reaches the visitor untouched`,
    res.status === status && res.headers.get('x-from') === 'origin' && !res.headers.get('x-avian-offline'),
    `got ${res.status}`);
}

console.log('\nfallback: a station that does not answer');
for (const status of [502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]) {
  const res = await withOrigin(
    async () => new Response('cloudflare error page', { status }),
    () => worker.fetch(REQ())
  );
  check(`${status} becomes the offline page`, isOffline(res), `got ${res.status}`);
}

console.log('\nfallback: fetch throws');
{
  const res = await withOrigin(
    async () => { throw new TypeError('connection refused'); },
    () => worker.fetch(REQ())
  );
  check('a thrown subrequest becomes the offline page', isOffline(res));
}

console.log('\nfallback: origin hangs past the timeout');
{
  // Honour the signal the worker passes, so this resolves in ms rather
  // than sitting out the real 10s budget.
  const res = await withOrigin(
    (req, init) => new Promise((_, reject) => {
      if (!init || !(init.signal instanceof AbortSignal)) { reject(new Error('no abort signal passed')); return; }
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 5);
    }),
    () => worker.fetch(REQ())
  );
  check('a hung origin becomes the offline page', isOffline(res));
}

console.log('\nthe offline response itself');
{
  const res = await withOrigin(
    async () => new Response('', { status: 530 }),
    () => worker.fetch(REQ())
  );
  const body = await res.text();
  check('503, so it is never indexed or cached as the real site', res.status === 503);
  check('retry-after: 30', res.headers.get('retry-after') === '30');
  check('cache-control: no-store', /no-store/.test(res.headers.get('cache-control') || ''));
  check('x-robots-tag: noindex', /noindex/.test(res.headers.get('x-robots-tag') || ''));
  check('content-type is html', /text\/html/.test(res.headers.get('content-type') || ''));
  check('carries the recovery marker the page polls for', res.headers.get('x-avian-offline') === '1');
  check('body is the offline page', /Off the air/.test(body) && /empty nest/.test(body));
  check('body needs nothing from the station', !/(src|href)="(?!data:)[^"]/.test(body),
    'a non-data: src/href would 404 during the outage');
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
