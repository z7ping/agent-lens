import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const apiBase = 'https://api.github.com'

export function validateReleaseCandidateMetadata({ release, version, tag }) {
  const failures = []
  if (release.tag_name !== tag) failures.push(`Release tag=${release.tag_name}, expected=${tag}`)
  if (release.draft !== true) failures.push('Release 必须保持 Draft，候选构建完成前禁止提前发布')
  const expectedPrerelease = version.includes('-')
  if (release.prerelease !== expectedPrerelease) {
    failures.push(`prerelease=${release.prerelease}, expected=${expectedPrerelease}`)
  }
  if (!String(release.body ?? '').trim()) failures.push('Release Notes 不能为空')
  if (!String(release.body ?? '').includes(tag)) failures.push(`Release Notes 必须明确包含版本 ${tag}`)
  return failures
}

export async function resolveRemoteTagCommit({ repository, tag, token, fetchImpl = fetch }) {
  const headers = githubHeaders(token)
  let ref = await fetchJson(
    `${apiBase}/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
    { headers },
    fetchImpl,
  )
  let object = ref.object
  for (let depth = 0; depth < 5 && object?.type === 'tag'; depth += 1) {
    const annotated = await fetchJson(
      `${apiBase}/repos/${repository}/git/tags/${object.sha}`,
      { headers },
      fetchImpl,
    )
    object = annotated.object
  }
  if (object?.type !== 'commit' || !object.sha) {
    throw new Error(`无法把远端 Tag ${tag} 解析到 commit`)
  }
  return object.sha
}

export async function waitForDraftRelease({ repository, tag, token, waitSeconds = 0, fetchImpl = fetch }) {
  const headers = githubHeaders(token)
  const deadline = Date.now() + waitSeconds * 1000
  let lastError = null

  do {
    try {
      return await fetchJson(
        `${apiBase}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
        { headers },
        fetchImpl,
      )
    } catch (error) {
      lastError = error
      if (!error || error.status !== 404 || Date.now() >= deadline) throw error
      await new Promise(resolvePromise => setTimeout(resolvePromise, 2000))
    }
  } while (Date.now() <= deadline)

  throw lastError ?? new Error(`没有找到 Draft Release ${tag}`)
}

async function fetchJson(url, options, fetchImpl) {
  const response = await fetchImpl(url, options)
  if (!response.ok) {
    const error = new Error(`GitHub API ${response.status}: ${await response.text()}`)
    error.status = response.status
    throw error
  }
  return response.json()
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

function parseArgs(argv) {
  let waitSeconds = 0
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--wait-seconds') waitSeconds = Number(argv[++index])
    else throw new Error(`未知参数：${argv[index]}`)
  }
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) throw new Error('--wait-seconds 必须是非负数字')
  return { waitSeconds }
}

async function main() {
  const { waitSeconds } = parseArgs(process.argv.slice(2))
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const repository = process.env.GITHUB_REPOSITORY
  const tag = process.env.GITHUB_REF_NAME
  const sha = process.env.GITHUB_SHA
  const token = process.env.GITHUB_TOKEN
  if (!repository || !tag || !sha || !token) {
    throw new Error('候选门禁需要 GITHUB_REPOSITORY / GITHUB_REF_NAME / GITHUB_SHA / GITHUB_TOKEN')
  }

  const expectedTag = `v${packageJson.version}`
  if (tag !== expectedTag) throw new Error(`当前 Tag ${tag} 与 package.json ${expectedTag} 不一致`)

  const release = await waitForDraftRelease({ repository, tag, token, waitSeconds })
  const failures = validateReleaseCandidateMetadata({ release, version: packageJson.version, tag })
  if (failures.length) {
    throw new Error(`Draft Release 候选检查失败：\n- ${failures.join('\n- ')}`)
  }

  const tagCommit = await resolveRemoteTagCommit({ repository, tag, token })
  if (tagCommit !== sha) {
    throw new Error(`远端 Tag ${tag} 指向 ${tagCommit}，当前候选提交为 ${sha}`)
  }

  console.log(`Draft Release 候选检查通过：${tag} -> ${sha}`)
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : null
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
