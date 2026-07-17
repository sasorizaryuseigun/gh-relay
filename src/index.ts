#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { constants, homedir } from 'node:os'
import { basename, resolve, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAppAuth } from '@octokit/auth-app'

const CONFIG_PATH =
  process.env.GH_APP_CONFIG ??
  resolve(
    process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config'),
    'gh-relay',
    'config.json',
  )

const CONFIG_DIR = dirname(CONFIG_PATH)

interface AppConfig {
  appId: number
  installId: number
  privateKeyPath?: string
}

function readConfig(path: string): AppConfig {
  let base: Partial<AppConfig> = {}
  try {
    base = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (e: unknown) {
    if (e instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${path}\n${e.message}`)
    }
    if (!(e instanceof Error)) throw e
    const nodeError = e as NodeJS.ErrnoException
    if (nodeError.code === 'EACCES') {
      throw new Error(
        `Permission denied reading config file: ${path}\n${e.message}`,
      )
    }
    if (nodeError.code === 'EISDIR') {
      throw new Error(`Config path is a directory: ${path}`)
    }
    if (nodeError.code !== 'ENOENT') {
      throw new Error(`Cannot read config file: ${path}\n${e.message}`)
    }
  }
  const appId = process.env.GH_APP_ID ?? base.appId
  const installId = process.env.GH_INSTALL_ID ?? base.installId
  if (appId == null || appId === '')
    throw new Error('appId is required via GH_APP_ID or config.json')
  if (installId == null || installId === '')
    throw new Error('installId is required via GH_INSTALL_ID or config.json')
  if (Number.isNaN(Number(appId)))
    throw new Error(`appId must be a number, got: ${appId}`)
  if (Number.isNaN(Number(installId)))
    throw new Error(`installId must be a number, got: ${installId}`)
  return {
    appId: Number(appId),
    installId: Number(installId),
    privateKeyPath: process.env.GH_PRIVATE_KEY_PATH ?? base.privateKeyPath,
  }
}

function resolvePrivateKeyPath(configDir: string, rawPath?: string): string {
  return rawPath
    ? resolve(configDir, rawPath)
    : resolve(configDir, 'private-key.pem')
}

function resolveSelfReal(): string {
  const fromMeta = fileURLToPath(import.meta.url)
  try {
    if (statSync(fromMeta).isFile()) {
      return realpathSync(fromMeta)
    }
    console.warn(
      `not a regular file: ${fromMeta}; falling back to ${process.execPath}`,
    )
  } catch {
    // compiled binary: import.meta.url points to bunfs
  }
  try {
    return realpathSync(process.execPath)
  } catch {
    return process.execPath
  }
}

function findGhAndFilterPath(): string {
  const selfReal = resolveSelfReal()
  const selfName = basename(selfReal)
  const entries = (process.env.PATH ?? '').split(delimiter)

  let ghPath: string | undefined
  const filtered: string[] = []

  for (const entry of entries) {
    const dir = resolve(entry || '.')

    if (!ghPath) {
      const candidate = resolve(dir, 'gh')
      try {
        if (
          statSync(candidate).isFile() &&
          !(selfName === 'gh' && realpathSync(candidate) === selfReal)
        ) {
          ghPath = candidate
        }
      } catch {
        // no gh in this directory
      }
    }

    const selfCandidate = resolve(dir, selfName)
    try {
      if (
        statSync(selfCandidate).isFile() &&
        realpathSync(selfCandidate) === selfReal
      ) {
        continue
      }
    } catch {
      // stat/realpath failed; keep dir in PATH
    }

    filtered.push(dir)
  }

  process.env.PATH = filtered.join(delimiter)

  if (!ghPath) {
    throw new Error('gh binary not found in PATH')
  }
  return ghPath
}

async function main(): Promise<void> {
  const existingToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN

  if (!existingToken) {
    const config = readConfig(CONFIG_PATH)

    let pem: string
    if (process.env.GH_PRIVATE_KEY) {
      pem = process.env.GH_PRIVATE_KEY
    } else {
      const keyPath = resolvePrivateKeyPath(CONFIG_DIR, config.privateKeyPath)
      try {
        pem = readFileSync(keyPath, 'utf-8')
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException
        if (err.code === 'ENOENT') {
          throw new Error(`Private key not found: ${keyPath}`)
        } else if (err.code === 'EACCES') {
          throw new Error(`Permission denied reading private key: ${keyPath}`)
        } else if (err.code === 'EISDIR') {
          throw new Error(`Private key path is a directory: ${keyPath}`)
        } else {
          throw new Error(`Cannot read private key: ${keyPath}\n${err.message}`)
        }
      }
    }

    const auth = createAppAuth({
      appId: config.appId,
      privateKey: pem,
      installationId: config.installId,
    })
    const { token } = await auth({ type: 'installation' })
    process.env.GH_TOKEN = token
  }

  const ghPath = findGhAndFilterPath()

  try {
    execFileSync(ghPath, process.argv.slice(2), {
      stdio: 'inherit',
      env: process.env,
    })
  } catch (e: unknown) {
    const err = e as Error & { status?: number; signal?: NodeJS.Signals }
    if (err.signal) {
      const signalCode =
        constants.signals[err.signal as keyof typeof constants.signals]
      if (signalCode !== undefined) {
        process.exit(128 + signalCode)
      }
      process.exit(1)
    }
    process.exit(err.status ?? 1)
  }
}

main().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
