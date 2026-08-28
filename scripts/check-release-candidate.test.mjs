import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveRemoteTagCommit, validateReleaseCandidateMetadata } from './check-release-candidate.mjs'

test('Draft Release 元数据与预发布版本一致时通过', () => {
  const failures = validateReleaseCandidateMetadata({
    version: '1.0.0-alpha.2',
    tag: 'v1.0.0-alpha.2',
    release: {
      tag_name: 'v1.0.0-alpha.2',
      draft: true,
      prerelease: true,
      body: '## AgentLens v1.0.0-alpha.2\n\n### 修复\n- 示例',
    },
  })
  assert.deepEqual(failures, [])
})

test('提前发布、空正文和通道不一致都会被拒绝', () => {
  const failures = validateReleaseCandidateMetadata({
    version: '1.0.0-alpha.2',
    tag: 'v1.0.0-alpha.2',
    release: {
      tag_name: 'v1.0.0-alpha.2',
      draft: false,
      prerelease: false,
      body: '',
    },
  })
  assert.equal(failures.length, 4)
})

test('可以解析 annotated tag 到最终 commit', async () => {
  const responses = new Map([
    ['https://api.github.com/repos/z7ping/agent-lens/git/ref/tags/v1.0.0-alpha.2', {
      object: { type: 'tag', sha: 'tag-object-sha' },
    }],
    ['https://api.github.com/repos/z7ping/agent-lens/git/tags/tag-object-sha', {
      object: { type: 'commit', sha: 'commit-sha' },
    }],
  ])
  const fetchImpl = async url => ({
    ok: responses.has(url),
    status: responses.has(url) ? 200 : 404,
    text: async () => '',
    json: async () => responses.get(url),
  })

  const sha = await resolveRemoteTagCommit({
    repository: 'z7ping/agent-lens',
    tag: 'v1.0.0-alpha.2',
    token: 'test-token',
    fetchImpl,
  })
  assert.equal(sha, 'commit-sha')
})
