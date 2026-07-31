import type { UserConfig } from 'cz-git'
import git from './git'

/**
 * Commit scopes.
 *
 * This used to spread `components` and `functions` from '@stacksjs/utils'.
 * Neither is exported by the installed package — verified at runtime — so the
 * import threw `Export named 'components' not found` and took the whole config
 * down with it. It went unnoticed because `config/` was outside tsconfig's
 * `include`, so `tsc --noEmit` never loaded this file.
 *
 * Those two exports were a monorepo convention: auto-derived scope names from
 * `resources/components` and `resources/functions`. loghq has no such surface
 * worth enumerating (11 dead scaffolding components, 2 orphan functions), so
 * the declared list in config/git.ts is the single source of truth.
 */
const scopes = [...new Set(git.scopes)]

export default {
  rules: {
    // @see: https://commitlint.js.org/#/reference-rules
    'scope-enum': [2, 'always', scopes],
  },

  prompt: {
    messages: git.messages,
    types: git.types,
    useEmoji: false,
    themeColorCode: '',
    scopes,
    allowCustomScopes: true,
    allowEmptyScopes: true,
    customScopesAlign: 'bottom',
    customScopesAlias: 'custom',
    emptyScopesAlias: 'empty',
    upperCaseSubject: false,
    allowBreakingChanges: ['feat', 'fix'],
    breaklineNumber: 100,
    breaklineChar: '|',
    skipQuestions: [],
    issuePrefixes: [{ value: 'closed', name: 'closed:   ISSUES has been processed' }],
    customIssuePrefixsAlign: 'top',
    emptyIssuePrefixsAlias: 'skip',
    customIssuePrefixsAlias: 'custom',
    allowCustomIssuePrefixs: true,
    allowEmptyIssuePrefixs: true,
    confirmColorize: true,
    maxHeaderLength: Number.POSITIVE_INFINITY,
    maxSubjectLength: Number.POSITIVE_INFINITY,
    minSubjectLength: 0,
    scopeOverrides: undefined,
    defaultBody: '',
    defaultIssues: '',
    defaultScope: '',
    defaultSubject: '',
  },
} satisfies UserConfig
