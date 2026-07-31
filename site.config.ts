// Site metadata + SEO. `buddy serve` loads this and injects og/twitter/canonical
// tags per page.
//
// `pages` is deliberately EMPTY. It used to carry a title and description for
// ten routes, duplicating strings the pages themselves now declare with
// useSeoMeta — and the duplication had already drifted. injectSeo is an exact
// key lookup with no wildcards, so sixteen routed pages were absent from it
// entirely and shared as the generic site blurb regardless of their own title.
//
// The rule (guide ch.4.7): a page owns its title, description, og and twitter
// tags, because useSeoMeta derives all four from two strings and they cannot
// drift. This map holds only what a page cannot know about itself — a per-route
// share image, if one is ever commissioned. Nothing needs one today.
//
// /dashboard and /account were listed here with real metadata, which advertised
// auth-walled URLs as indexable. Those routes now set robots: noindex, nofollow
// themselves, and public/robots.txt disallows them.
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
  pages: {},
}
