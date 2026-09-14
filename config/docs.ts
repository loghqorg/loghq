import type { BunPressOptions } from '@stacksjs/bunpress'

const config: BunPressOptions = {
  verbose: false,
  docsDir: './docs',
  outDir: './dist/docs',
  nav: [
    { text: 'Quick start', link: '/getting-started' },
    { text: 'SDKs', link: '/send/sdks' },
    { text: 'Ingest API', link: '/reference/ingest' },
    { text: 'Dashboard', link: 'https://loghq.org/dashboard' },
    { text: 'GitHub', link: 'https://github.com/stacksjs/loghq' },
  ],
  markdown: {
    title: 'LogHQ Documentation',
    meta: { description: 'Send, search, correlate, retain, and operate structured application logs with LogHQ.', author: 'LogHQ' },
    syntaxHighlightTheme: 'github-dark',
    toc: { enabled: true, minDepth: 2, maxDepth: 3 },
    sidebar: {
      '/': [
        { text: 'Introduction', items: [
          { text: 'What is LogHQ', link: '/introduction' },
          { text: 'Quick start', link: '/getting-started' },
        ] },
        { text: 'Send logs', items: [
          { text: 'Stacks, PHP, and Laravel', link: '/send/sdks' },
          { text: 'HTTP from any language', link: '/send/http' },
        ] },
        { text: 'Use LogHQ', items: [
          { text: 'Search and filters', link: '/use/search-filters' },
          { text: 'Correlation', link: '/use/correlation' },
          { text: 'Projects and teams', link: '/use/projects-teams' },
          { text: 'Alert channels', link: '/use/alerts' },
        ] },
        { text: 'Operate', items: [
          { text: 'Retention and archive', link: '/operate/retention-archive' },
          { text: 'Self-hosting', link: '/operate/self-hosting' },
        ] },
        { text: 'Reference', items: [
          { text: 'Ingest API', link: '/reference/ingest' },
          { text: 'Dashboard API', link: '/reference/api' },
          { text: 'CLI', link: '/reference/cli' },
        ] },
      ],
    },
  },
  themeConfig: {
    darkMode: 'auto',
    footer: { message: 'Open-source log management, released under the MIT License.', copyright: 'Copyright 2026-present LogHQ' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/stacksjs/loghq' }],
  },
  sitemap: { enabled: true, baseUrl: 'https://loghq.org/docs' },
  robots: { enabled: true },
}

export default config
