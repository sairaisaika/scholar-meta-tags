/**
 * 入库的 git 写入：追加 → add → commit → pull --rebase → push；失败退避 5 / 15 / 45 s 重试 3 次。
 * 命令可注入（测试不碰真仓）。身份用 Actions 机器人（不写任何人的邮箱）。
 */
import { execFileSync } from 'node:child_process'

export interface GitRunner { (args: string[]): string }

const BOT_NAME = 'github-actions[bot]'
const BOT_EMAIL = `41898282+${BOT_NAME}@users.noreply.github.com`

export const realGit = (cwd: string): GitRunner => (args) =>
  execFileSync('git', ['-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

export const BACKOFF_MS = [5_000, 15_000, 45_000] as const

export interface CommitPushOptions {
  git: GitRunner
  paths: string[]
  message: string
  /** 测试里注入假的等待 */
  sleep?: (ms: number) => Promise<void>
  /** 不推（本地试跑） */
  push?: boolean
}

/** 提交并推送；全部重试失败 ⇒ 抛最后一个错误 */
export async function commitAndPush(opts: CommitPushOptions): Promise<{ committed: boolean; pushed: boolean }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  opts.git(['add', '--', ...opts.paths])
  const staged = opts.git(['diff', '--cached', '--name-only']).trim()
  if (!staged) return { committed: false, pushed: false }
  opts.git(['commit', '-q', '-m', opts.message])
  if (opts.push === false) return { committed: true, pushed: false }
  let last: unknown = null
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      opts.git(['pull', '--rebase', '-q'])
      opts.git(['push', '-q'])
      return { committed: true, pushed: true }
    } catch (e) {
      last = e
      const wait = BACKOFF_MS[attempt]
      if (wait === undefined) break
      await sleep(wait)
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}
