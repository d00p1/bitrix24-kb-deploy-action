import * as fs from 'fs'
import * as core from '@actions/core'
import { getOctokit, context } from '@actions/github'

/**
 * Commits the updated manifest back to the repository via the GitHub Contents
 * API, so document IDs stay stable between runs without an extra workflow step.
 * No-op outside the GitHub/Gitea runner or when no token is provided.
 *
 * `baseUrl` honors GITHUB_API_URL: GitHub sets it to api.github.com, Gitea
 * Actions sets it to the instance API — the same code path works on both.
 */
export async function commitManifest(manifestPath: string, token: string): Promise<boolean> {
  if (!token || !process.env.GITHUB_REPOSITORY || !context.ref.startsWith('refs/heads/')) {
    return false
  }

  const octokit = getOctokit(token, {
    baseUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
  })
  const { owner, repo } = context.repo
  const branch = context.ref.replace('refs/heads/', '')
  const content = fs.readFileSync(manifestPath, 'utf8')
  const path = manifestPath.replace(/^\.\//, '')

  let sha: string | undefined
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref: branch })
    if (!Array.isArray(data) && data.type === 'file') {
      sha = data.sha
      const remote = Buffer.from(data.content, 'base64').toString('utf8')
      if (remote === content) {
        core.info(`Manifest "${path}" is unchanged — no commit needed`)
        return false
      }
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
