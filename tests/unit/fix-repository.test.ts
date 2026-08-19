/**
 * What people actually paste into "connect a repository".
 *
 * Nobody types `owner/name`. They copy the address bar, which carries a scheme,
 * a host, and often a trailing path from whatever page they were on. They paste
 * the clone box, which is an SSH remote ending in `.git`. Rejecting those means
 * the field is right and the person is wrong, which is the wrong way round.
 *
 * The rejections matter as much: `owner` and `name` are interpolated into a
 * GitHub API path, so anything that could carry a slash or a traversal segment
 * out of the two-segment shape has to fail here rather than downstream.
 */
import { describe, expect, test } from 'bun:test'
import { parseRepositoryRef } from '../../app/Fix/repository'

describe('parseRepositoryRef accepts the shapes people paste', () => {
  const owner = { owner: 'loghqorg', name: 'loghq' }

  test.each([
    ['loghqorg/loghq'],
    ['https://github.com/loghqorg/loghq'],
    ['http://github.com/loghqorg/loghq'],
    ['https://www.github.com/loghqorg/loghq'],
    ['github.com/loghqorg/loghq'],
    ['git@github.com:loghqorg/loghq.git'],
    ['https://github.com/loghqorg/loghq.git'],
    ['https://github.com/loghqorg/loghq/'],
    ['  loghqorg/loghq  '],
    // Copied from a page deeper in the repo, which is the common case.
    ['https://github.com/loghqorg/loghq/tree/main/app/Fix'],
    ['https://github.com/loghqorg/loghq/pull/12'],
  ])('%s', (input) => {
    expect(parseRepositoryRef(input)).toEqual(owner)
  })

  test('keeps dots, hyphens and underscores, which are all legal', () => {
    expect(parseRepositoryRef('some-org/my_repo.js')).toEqual({ owner: 'some-org', name: 'my_repo.js' })
  })
})

describe('parseRepositoryRef rejects what cannot be a repository', () => {
  test.each([
    [''],
    ['   '],
    ['loghq'],
    ['/loghq'],
    ['https://github.com/'],
    ['https://gitlab.com/loghqorg/loghq'.replace('loghqorg/loghq', '')],
    // Would escape the two-segment shape once interpolated into an API path.
    ['../../etc/passwd'],
    ['owner/na me'],
    ['owner/name?ref=x'],
  ])('%p', (input) => {
    expect(parseRepositoryRef(input)).toBeNull()
  })
})
