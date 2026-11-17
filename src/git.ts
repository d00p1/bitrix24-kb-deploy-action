import * as fs from 'fs'
import * as core from '@actions/core'
import { getOctokit, context } from '@actions/github'

/**
 * Commits the updated manifest back to the repository via the GitHub Contents
 * API, so document IDs stay stable between runs without an extra workflow step.
 * No-op outside the GitHub runner or when no token is provided.
 */
export async function commitManifest(manifestPath: string, token: string): Promise<boolean> {
  if (!token || !process.env.GITHUB_REPOSITORY || !context.ref.startsWith('refs/heads/')) {
    return false
  }

  const octokit = getOctokit(token)
  const { owner, repo } = context.repo
  const branch = context.ref.replace('refs/heads/', '')
  const content = fs.readFileSync(manifestPath, 'utf8')
  const path = manifestPath.replace(/^\.\//, '')

  let sha: string | undefined
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref: branch })
    if (!Array.isArray(data) && data.type === 'file') {
      sha = data.sha
    }
  } catch (err) {
    if ((err as { status?: number }).status !== 404) throw err // file not found is fine — creating
  }

  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    branch,
    content: Buffer.from(content, 'utf8').toString('base64'),
    message: `chore: update KB manifest [skip ci]`,
    ...(sha ? { sha } : {}),
  })
  core.info(`Committed updated manifest "${path}" to ${branch}`)
  return true
}
