// Site metadata + SEO. `buddy serve` loads this and injects accurate
// <title>, canonical, Open Graph, and Twitter card tags per page (replacing
// stx's "stx App" scaffold defaults). Per-path overrides live in `pages`.
const description = 'Logs for people who ship. Stream, search, and filter your application logs in a fast, live UI instead of tailing a file. Built on Stacks and Postgres.'

export default {
  name: 'loghq',
  url: 'https://loghq.org',
  description,
  seo: {
    siteName: 'loghq',
    title: 'loghq - Logs for people who ship',
    description,
    image: 'https://loghq.org/og.png',
    favicon: '/favicon.svg',
    locale: 'en_US',
    type: 'website',
    twitter: 'stacksjs',
  },
  pages: {
    '/': {
      title: 'loghq - Logs for people who ship',
      description,
    },
    '/dashboard': {
      title: 'Logs - loghq',
      description: 'Your live application log stream — filter by level, search messages, and inspect structured context.',
    },
    '/account': {
      title: 'Account - loghq',
      description: 'Your loghq profile, plan, and sign-in method.',
    },
    '/use-cases': {
      title: 'Use cases - loghq',
      description: 'How SaaS teams, on-call engineers, agencies, indie devs, and open-source maintainers use loghq to catch and triage production errors.',
    },
    '/features/capture': {
      title: 'Automatic error capture - loghq',
      description: 'Initialize once and every uncaught error is captured with its stack trace, release, and environment. No scattered try/catch.',
    },
    '/features/grouping': {
      title: 'Fingerprint grouping - loghq',
      description: 'Identical errors fold into a single issue by fingerprint, with a live event count and an affected-user tally.',
    },
    '/features/releases': {
      title: 'Releases and environments - loghq',
      description: 'Tag every event with a release and environment so a regression points straight at the deploy that caused it.',
    },
    '/features/stack-traces': {
      title: 'Readable stack traces - loghq',
      description: 'Upload a source map and every minified frame resolves back to your original file, function, and line.',
    },
    '/features/alerts': {
      title: 'Alerts and triage - loghq',
      description: 'Get alerted when an issue is new or spiking, and stay quiet for the known and handled. Tune the threshold, not the noise.',
    },
    '/features/self-host': {
      title: 'Self-hosting - loghq',
      description: 'loghq is open source and runs on your own Postgres, so sensitive stack data never leaves servers you control.',
    },
  },
}
