/**
 * What the views server answers itself and what it hands to the API, plus who
 * is allowed to see what.
 *
 * This is the file that guards `config/server.ts`. Those proxy rules are easy
 * to break and the breakage is quiet: the framework matches a request to the
 * API by METHOD before it ever looks at the path, so putting a method back into
 * `proxy.methods` disables every page action in the app in one line, and
 * listing a path that also has a page proxies that page away. Neither shows up
 * as an error — you get a 404, or JSON where a page should be.
 */
import { describe, expect, test } from 'bun:test'
import { get, postForm, registerAndSignIn, SERVER_UP } from './helpers'

// Skipped, not passed, when nothing is listening — see auth-forms.test.ts.
const only = test.skipIf(!SERVER_UP)

describe('proxy rules', () => {
  only('GET /login renders the page rather than being proxied', async () => {
    const res = await get('/login')
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(html).toContain('<form action="/login"')
  })

  only('POST /login reaches the page action, not the API', async () => {
    // The API would answer JSON. A page action re-renders HTML, or 303s.
    const res = await postForm('/login', { email: 'x@y.test', password: 'wrong-password' })
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  only('the auth POSTs that still belong to the API are still proxied', async () => {
    // /logout is in proxy.paths and IS still a same-origin fetch from the
    // session store. It must not be answered by a rendered page.
    const res = await postForm('/logout', {})
    expect(res.headers.get('content-type') || '').not.toContain('text/html')
  })

  only('/api/* is proxied', async () => {
    const res = await get('/api/me')
    // 401 without a token — the point is that it is answered by the API at all
    expect([200, 401, 403]).toContain(res.status)
    expect(res.headers.get('content-type') || '').not.toContain('text/html')
  })

  only('the SDK ingest endpoint is not shadowed by a page', async () => {
    const res = await fetch(`${Bun.env.E2E_BASE_URL || 'http://localhost:3000'}/logs`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    // rejects the empty body, which means it reached the ingest route
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.headers.get('content-type') || '').not.toContain('text/html')
  })
})

describe('access control', () => {
  const guarded = ['/dashboard', '/settings', '/projects']

  only('guarded pages answer 200 signed out, in their signed-out state', async () => {
    for (const path of guarded) {
      const res = await get(path)
      expect(res.status).toBe(200)
      // They render a shell, not a redirect — the signed-out state is a real
      // rendering decision here, not an error.
      expect(await res.text()).toBeTruthy()
    }
  })

  only('guarded pages render authenticated content with a session', async () => {
    const { cookie } = await registerAndSignIn('gating')
    expect(cookie).not.toBe('')

    for (const path of guarded) {
      const html = await (await get(path, cookie)).text()
      expect(html).not.toContain('id="auth-pending"')
    }
  })

  only('creating a project without a session bounces to sign-in', async () => {
    const res = await postForm('/projects/new', { name: 'Should Not Exist' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/login')
  })

  only('creating a project with a session lands on its settings', async () => {
    const { cookie } = await registerAndSignIn('create-project')
    const res = await postForm('/projects/new', { name: 'E2E App', platform: 'node' }, cookie)

    expect(res.status).toBe(303)
    expect(res.headers.get('location') || '').toStartWith('/settings?project=')
  })

  only('a rejected project name comes back on the page, not as JSON', async () => {
    const { cookie } = await registerAndSignIn('bad-project')
    const res = await postForm('/projects/new', { name: '   ' }, cookie)

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('err-box')
  })

  // Two apps of the same name in one account render identically everywhere, so
  // the key you copy out of a list is a coin flip. This was found the way these
  // things usually are: by making the duplicate and not noticing.
  only('a second app with the same name is refused', async () => {
    const { cookie } = await registerAndSignIn('dupe-project')

    const first = await postForm('/projects/new', { name: 'Dupe App', platform: 'node' }, cookie)
    expect(first.status).toBe(303)

    const second = await postForm('/projects/new', { name: 'Dupe App', platform: 'node' }, cookie)
    expect(second.status).toBe(200)
    expect(await second.text()).toContain('already have an app called')
  })

  // Case is not what distinguishes two apps, so neither should it let one past.
  only('the duplicate check ignores case', async () => {
    const { cookie } = await registerAndSignIn('dupe-case')

    expect((await postForm('/projects/new', { name: 'CaseApp', platform: 'node' }, cookie)).status).toBe(303)
    const clash = await postForm('/projects/new', { name: 'caseapp', platform: 'node' }, cookie)

    expect(clash.status).toBe(200)
    expect(await clash.text()).toContain('already have an app called')
  })
})

describe('every page renders', () => {
  only('all view routes answer 200', async () => {
    const glob = new Bun.Glob('resources/views/**/*.stx')
    const paths = new Set<string>()

    for await (const file of glob.scan('.')) {
      if (file.includes('/partials/') || file.includes('/layouts/'))
        continue
      const route = file
        .replace(/^resources\/views/, '')
        .replace(/\.stx$/, '')
        .replace(/\/index$/, '')
        .replace(/\[[^\]]+\]/g, '1')
      paths.add(route === '' ? '/' : route)
    }

    expect(paths.size).toBeGreaterThan(20)

    const bad: string[] = []
    for (const path of paths) {
      const res = await get(path)
      if (res.status !== 200)
        bad.push(`${res.status} ${path}`)
    }
    expect(bad).toEqual([])
  })
})
