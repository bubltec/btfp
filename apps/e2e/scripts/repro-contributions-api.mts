/**
 * API-only repro for POST /contributions against dev (no browser).
 * Usage: same env as test:dev — run via `pnpm repro:contributions` from apps/e2e.
 */
const baseUrl = (process.env.BASE_URL ?? 'https://dev.badthingsforpets.com').replace(/\/$/, '');
const user = process.env.BASIC_AUTH_USER ?? process.env.BTFP_DEV_BASIC_AUTH_USER;
const pass = process.env.BASIC_AUTH_PASSWORD ?? process.env.BTFP_DEV_BASIC_AUTH_PASSWORD;
if (!user || !pass) {
  console.error('Set BASIC_AUTH_USER/PASSWORD or BTFP_DEV_* from secrets:sync');
  process.exit(1);
}

const auth = Buffer.from(`${user}:${pass}`).toString('base64');

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Basic ${auth}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(`${baseUrl}/api${path}`, { ...init, headers, redirect: 'manual' });
}

function cookieJar(setCookie: string | null, existing: string): string {
  if (!setCookie) return existing;
  const match = setCookie.match(/(^|,\s*)([^=;]+=[^;]+)/);
  const part = match?.[2];
  if (!part) return existing;
  return existing ? `${existing}; ${part}` : part;
}

async function signInAndVerify(): Promise<string> {
  const email = `e2e-api-${Date.now()}@badthingsforpets.com`;
  let cookies = '';

  const reqCode = await api('/auth/email/request', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  cookies = cookieJar(reqCode.headers.get('set-cookie'), cookies);
  if (!reqCode.ok) throw new Error(`email/request ${reqCode.status} ${await reqCode.text()}`);

  const codeRes = await api(`/auth/email/test-code?email=${encodeURIComponent(email)}`);
  if (!codeRes.ok) throw new Error(`test-code ${codeRes.status}`);
  const { code } = (await codeRes.json()) as { code: string };

  const confirm = await api('/auth/email/confirm', {
    method: 'POST',
    headers: { Cookie: cookies },
    body: JSON.stringify({ email, code }),
  });
  cookies = cookieJar(confirm.headers.get('set-cookie'), cookies);
  if (!confirm.ok) throw new Error(`confirm ${confirm.status} ${await confirm.text()}`);

  const verify = await api('/auth/test/verify', { method: 'POST', headers: { Cookie: cookies } });
  cookies = cookieJar(verify.headers.get('set-cookie'), cookies);
  if (!verify.ok) throw new Error(`test/verify ${verify.status} ${await verify.text()}`);

  return cookies;
}

async function postContribution(
  cookies: string,
  name: string,
  opts?: { thingId?: string },
): Promise<void> {
  const body = {
    ...(opts?.thingId ? { thingId: opts.thingId } : {}),
    payload: {
      name,
      thingTypeId: 'food',
      petTypes: [{ petTypeId: 'dog', severity: 'unknown' }],
      details: { notes: 'e2e api repro' },
      source: 'e2e-api-repro',
    },
  };
  const res = await api('/contributions', {
    method: 'POST',
    headers: { Cookie: cookies },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`POST /contributions name=${JSON.stringify(name)} → ${res.status} ${text}`);
}

const cookies = await signInAndVerify();

for (const path of ['/auth/me', '/contributions/pending']) {
  const res = await api(path, { headers: { Cookie: cookies } });
  console.log(`GET ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
}

const pendingRes = await api('/contributions/pending', { headers: { Cookie: cookies } });
const pending = (await pendingRes.json()) as { PK?: string }[];
const existingThingId = pending[0]?.PK?.replace(/^THING#/, '');

await postContribution(cookies, `E2E-unique-${Date.now()}`);
await postContribution(cookies, 'Chocolate');
if (existingThingId) {
  await postContribution(cookies, `E2E-linked-${Date.now()}`, { thingId: existingThingId });
}
