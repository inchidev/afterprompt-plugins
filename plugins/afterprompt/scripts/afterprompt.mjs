#!/usr/bin/env node
// AfterPrompt CLI: publish a web game from a folder and play it by link.
// Node 20 or newer, no dependencies. See docs/PUBLISHING_GAMES.md in the AfterPrompt repository.
//
//   afterprompt login               sign in through the browser (OAuth, PKCE, loopback redirect)
//   afterprompt login --device      sign in from another device with a short code (RFC 8628); the default over SSH
//   afterprompt publish <dir>       publish <dir>/afterprompt.json and its files as a new version
//   afterprompt submit <dir>        send the live version of <dir>'s game to catalog review
//   afterprompt games               list your games, their catalog versions and reviews
//   afterprompt logout              forget the stored sign-in
//
// Environment: AFTERPROMPT_URL (default https://afterprompt.games), AFTERPROMPT_TOKEN (an access token to use
// instead of the stored sign-in), AFTERPROMPT_HOME (default ~/.afterprompt; credentials.json lives there).

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_FORMAT = 'afterprompt-package@1'
export const SCOPE = 'openid offline_access afterprompt:games'
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const LIMITS = { fileBytes: 25 * 1024 * 1024, packageBytes: 100 * 1024 * 1024, files: 2000 }
// Mirrors PLAYER_GAME_CONTENT_TYPES in shared/player-games.ts; a test keeps the two in step.
export const EXTENSIONS = ['html', 'js', 'mjs', 'css', 'json', 'wasm', 'data', 'bin', 'unityweb', 'pck', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'mp3', 'ogg', 'wav', 'm4a', 'mp4', 'webm', 'woff', 'woff2', 'ttf', 'otf', 'txt']
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/u
const SKIPPED_DIRECTORIES = new Set(['node_modules'])

class CliError extends Error {}

const baseUrl = (env = process.env) => (env.AFTERPROMPT_URL || 'https://afterprompt.games').replace(/\/+$/u, '')
const homeDir = (env = process.env) => env.AFTERPROMPT_HOME || join(homedir(), '.afterprompt')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const base64url = bytes => Buffer.from(bytes).toString('base64url')

/** Why a package path is refused, or undefined when AfterPrompt accepts it. Same rules as the server. */
export function pathProblem(path) {
  if (path.length > 240) return 'the path is longer than 240 characters'
  const segments = path.split('/')
  if (segments[0].toLowerCase() === '__afterprompt') return '__afterprompt/ is reserved for the AfterPrompt SDK'
  if (segments.length > 12) return 'the path is nested deeper than 12 folders'
  const bad = segments.find(segment => !SEGMENT.test(segment))
  if (bad !== undefined) return `"${bad}" may hold only letters, digits, ".", "_" and "-", and must not start with "." or "-"`
  const name = segments.at(-1)
  if (!name.includes('.') || !EXTENSIONS.includes(name.split('.').pop().toLowerCase())) return 'this file type is not served'
  return undefined
}

/** Every file a package ships: hidden entries, node_modules, afterprompt.json and the .afterprompt folder stay local. */
export async function collectPackage(dir) {
  const root = resolve(dir)
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(root, 'afterprompt.json'), 'utf8'))
  } catch (error) {
    throw new CliError(error.code === 'ENOENT' ? `${join(dir, 'afterprompt.json')} is missing. See the package format in the publishing guide.` : `afterprompt.json is not valid JSON: ${error.message}`)
  }
  if (manifest?.format !== PACKAGE_FORMAT) throw new CliError(`afterprompt.json needs "format": "${PACKAGE_FORMAT}".`)
  if (typeof manifest.title?.en !== 'string' || !manifest.title.en.trim()) throw new CliError('afterprompt.json needs a title: { "en": "…" }.')

  const files = [], skipped = [], refused = []
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue
      const absolute = join(folder, entry.name)
      const path = relative(root, absolute).split(sep).join('/')
      if (entry.isDirectory()) { await walk(absolute); continue }
      if (!entry.isFile() || path === 'afterprompt.json') continue
      const problem = pathProblem(path)
      if (problem === 'this file type is not served') { skipped.push(path); continue }
      if (problem) { refused.push(`${path}: ${problem}`); continue }
      const bytes = await readFile(absolute)
      if (bytes.byteLength > LIMITS.fileBytes) { refused.push(`${path}: a file holds at most 25 MB`); continue }
      files.push({ path, absolute, size: bytes.byteLength, sha256: sha256(bytes) })
    }
  }
  await walk(root)
  if (refused.length) throw new CliError(`These files cannot be published:\n  ${refused.join('\n  ')}`)
  files.sort((a, b) => a.path.localeCompare(b.path))
  if (!files.some(file => file.path.toLowerCase() === 'index.html')) throw new CliError('A package needs index.html at its root.')
  if (files.length > LIMITS.files) throw new CliError(`A package holds at most ${LIMITS.files} files; this one has ${files.length}.`)
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (total > LIMITS.packageBytes) throw new CliError(`A package holds at most 100 MB; this one has ${(total / 1024 / 1024).toFixed(1)} MB.`)
  return { root, manifest, files, skipped, totalBytes: total }
}

// ---- credentials ----

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

async function writePrivateJson(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}

const credentialsPath = env => join(homeDir(env), 'credentials.json')

async function storedCredentials(env, base) {
  return (await readJson(credentialsPath(env)))?.[base]
}

async function storeCredentials(env, base, value) {
  const all = (await readJson(credentialsPath(env))) ?? {}
  if (value) all[base] = value
  else delete all[base]
  await writePrivateJson(credentialsPath(env), all)
}

async function discover(base) {
  const resource = await fetchJson(`${base}/.well-known/oauth-protected-resource`)
  const issuer = resource.authorization_servers?.[0] ?? `${base}/api/auth`
  const metadata = await fetchJson(`${issuer}/.well-known/oauth-authorization-server`).catch(() => fetchJson(`${base}/.well-known/oauth-authorization-server`))
  return { resource: resource.resource ?? `${base}/mcp`, ...metadata }
}

async function fetchJson(url, init) {
  const response = await fetch(url, init)
  const body = await response.json().catch(() => undefined)
  if (!response.ok) throw new CliError(`${init?.method ?? 'GET'} ${url} failed (${response.status}): ${body?.error_description ?? body?.message ?? body?.statusMessage ?? response.statusText}`)
  return body
}

function openBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  try { spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref() } catch { /* the URL is printed too */ }
}

/** No browser can reach a loopback callback here: an SSH session, or Linux without a display. */
export function headless(env = process.env, platform = process.platform) {
  return Boolean(env.SSH_CONNECTION || env.SSH_TTY) || (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY)
}

/** Signs in and stores a refreshable token scoped to publishing games: in this machine's browser, or with a device code. */
export async function login({ env = process.env, log = console.error, browser = true, device = headless(env) } = {}) {
  const base = baseUrl(env)
  const server = await discover(base)
  if (device) return deviceLogin({ env, log, base, server })
  const callback = createServer()
  await new Promise(done => callback.listen(0, '127.0.0.1', done))
  const redirectUri = `http://127.0.0.1:${callback.address().port}/callback`
  try {
    const client = await fetchJson(server.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'AfterPrompt CLI', application_type: 'native', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: SCOPE }),
    })
    const verifier = base64url(randomBytes(48)), state = base64url(randomBytes(16))
    const authorize = new URL(server.authorization_endpoint)
    authorize.search = new URLSearchParams({
      client_id: client.client_id, response_type: 'code', redirect_uri: redirectUri, scope: SCOPE, state,
      code_challenge: base64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: server.resource, prompt: 'consent',
    }).toString()
    const code = new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new CliError('Sign-in timed out after 10 minutes.')), 600_000)
      callback.on('request', (request, response) => {
        const url = new URL(request.url, redirectUri)
        if (url.pathname !== '/callback') { response.writeHead(404).end(); return }
        const ok = url.searchParams.get('state') === state && url.searchParams.get('code')
        response.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
        response.end(`<!doctype html><meta charset="utf-8"><title>AfterPrompt</title><p style="font:16px system-ui;margin:3rem">${ok ? 'Signed in. You can close this tab and return to your agent.' : 'Sign-in failed. Return to your agent and try again.'}</p>`)
        clearTimeout(timer)
        ok ? done(url.searchParams.get('code')) : fail(new CliError(`Sign-in failed: ${url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'the response did not match this sign-in'}.`))
      })
    })
    log(`Open this link to sign in to AfterPrompt:\n\n  ${authorize.href}\n`)
    if (browser) openBrowser(authorize.href)
    const tokens = await fetchJson(server.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: redirectUri, code: await code, code_verifier: verifier, resource: server.resource }),
    })
    await storeCredentials(env, base, credentialsFrom(tokens, { clientId: client.client_id, tokenEndpoint: server.token_endpoint, resource: server.resource }))
    log(`Signed in to ${base}.`)
  } finally {
    callback.close()
  }
}

const sleep = ms => new Promise(done => setTimeout(done, ms))

/**
 * RFC 8628: shows a code and a link to open on any device, then polls until the person approves it. The token is
 * the same scoped OAuth token the browser sign-in issues.
 */
async function deviceLogin({ env, log, base, server }) {
  if (!server.device_authorization_endpoint) throw new CliError(`${base} does not offer sign-in with a code. Run \`afterprompt login --browser\`.`)
  const client = await fetchJson(server.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'AfterPrompt CLI', application_type: 'native', token_endpoint_auth_method: 'none', grant_types: [DEVICE_GRANT, 'refresh_token'], scope: SCOPE }),
  })
  const form = body => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })
  const grant = await fetchJson(server.device_authorization_endpoint, form({ client_id: client.client_id, scope: SCOPE, resource: server.resource }))
  const code = grant.user_code.length === 8 ? `${grant.user_code.slice(0, 4)}-${grant.user_code.slice(4)}` : grant.user_code
  log(`To sign in to AfterPrompt, open this link on any device and approve the code ${code}:\n\n  ${grant.verification_uri_complete ?? grant.verification_uri}\n\nOr go to ${grant.verification_uri} and enter ${code}. Waiting…`)
  let interval = (grant.interval ?? 5) * 1000
  const deadline = Date.now() + (grant.expires_in ?? 600) * 1000
  while (Date.now() < deadline) {
    await sleep(interval)
    const response = await fetch(server.token_endpoint, form({ grant_type: DEVICE_GRANT, device_code: grant.device_code, client_id: client.client_id, resource: server.resource }))
    const body = await response.json().catch(() => ({}))
    if (response.ok) {
      await storeCredentials(env, base, credentialsFrom(body, { clientId: client.client_id, tokenEndpoint: server.token_endpoint, resource: server.resource }))
      log(`Signed in to ${base}.`)
      return
    }
    if (body.error === 'authorization_pending') continue
    if (body.error === 'slow_down') { interval += 5000; continue }
    if (body.error === 'access_denied') throw new CliError('The sign-in was declined.')
    if (body.error === 'expired_token') break
    throw new CliError(`Sign-in failed: ${body.error_description ?? body.error ?? response.statusText}.`)
  }
  throw new CliError('The code expired before it was approved. Run `afterprompt login` again.')
}

function credentialsFrom(tokens, previous) {
  return {
    clientId: previous.clientId,
    tokenEndpoint: previous.tokenEndpoint,
    resource: previous.resource,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previous.refreshToken,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  }
}

async function accessToken(env, { force = false } = {}) {
  if (env.AFTERPROMPT_TOKEN) return env.AFTERPROMPT_TOKEN
  const base = baseUrl(env)
  const stored = await storedCredentials(env, base)
  if (!stored) throw new CliError(`Not signed in to ${base}. Run \`afterprompt login\` or set AFTERPROMPT_TOKEN.`)
  if (!force && stored.expiresAt - 60_000 > Date.now()) return stored.accessToken
  if (!stored.refreshToken) throw new CliError('Your AfterPrompt sign-in expired. Run `afterprompt login` again.')
  const response = await fetch(stored.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: stored.clientId, refresh_token: stored.refreshToken, resource: stored.resource }),
  })
  if (!response.ok) throw new CliError('Your AfterPrompt sign-in expired. Run `afterprompt login` again.')
  const next = credentialsFrom(await response.json(), stored)
  await storeCredentials(env, base, next)
  return next.accessToken
}

/** A studio API call with the caller's token; a rejected stored token is refreshed once. */
async function api(env, path, init = {}) {
  const call = async token => fetch(`${baseUrl(env)}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } })
  let response = await call(await accessToken(env))
  if (response.status === 401 && !env.AFTERPROMPT_TOKEN) response = await call(await accessToken(env, { force: true }))
  const body = await response.json().catch(() => undefined)
  if (!response.ok) {
    const error = new CliError(body?.message || body?.statusMessage || `${init.method ?? 'GET'} ${path} failed with ${response.status}.`)
    error.status = response.status
    throw error
  }
  return body
}

const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// ---- publish ----

const statePath = root => join(root, '.afterprompt', 'game.json')

/** Publishes a folder as a new version of its game, creating the game on the first run. */
export async function publish(dir, { env = process.env, log = console.error, createNew = false, concurrency = 4 } = {}) {
  const base = baseUrl(env)
  const pkg = await collectPackage(dir)
  if (pkg.skipped.length) log(`Skipping ${pkg.skipped.length} file(s) AfterPrompt does not serve: ${pkg.skipped.slice(0, 8).join(', ')}${pkg.skipped.length > 8 ? ', …' : ''}`)
  const state = (await readJson(statePath(pkg.root))) ?? {}
  let gameId = createNew ? undefined : state[base]?.id
  if (!gameId) {
    const game = await api(env, '/api/studio/games', json({ title: pkg.manifest.title.en.trim().slice(0, 60) }))
    gameId = game.id
    state[base] = { id: gameId }
    await mkdir(join(pkg.root, '.afterprompt'), { recursive: true })
    await writeFile(statePath(pkg.root), JSON.stringify(state, null, 2) + '\n')
    log(`Created game ${gameId}; its id is kept in ${relative(process.cwd(), statePath(pkg.root)) || statePath(pkg.root)}.`)
  }
  let declared
  try {
    declared = await api(env, `/api/studio/games/${gameId}/versions`, json({ manifest: pkg.manifest, files: pkg.files.map(({ path, sha256, size }) => ({ path, sha256, size })) }))
  } catch (error) {
    if (error.status === 404) throw new CliError(`Game ${gameId} does not exist or is not yours. Run \`afterprompt publish ${dir} --new\` to create a new game.`)
    throw error
  }
  const bySha = new Map(pkg.files.map(file => [file.sha256, file]))
  const queue = [...declared.missing]
  let uploadedBytes = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let blob = queue.shift(); blob; blob = queue.shift()) {
      const file = bySha.get(blob.sha256)
      await api(env, `/api/studio/blobs/${blob.sha256}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: await readFile(file.absolute) })
      uploadedBytes += file.size
    }
  }))
  const finalized = await api(env, `/api/studio/games/${gameId}/versions/${declared.version}/finalize`, { method: 'POST' })
  return { id: gameId, version: declared.version, files: pkg.files.length, totalBytes: pkg.totalBytes, uploaded: declared.missing.length, uploadedBytes, playUrl: finalized.playUrl, origin: finalized.origin }
}

/** Sends a version of the folder's game (the live one by default) to the catalog review queue. */
export async function submit(dir, { env = process.env, version } = {}) {
  const base = baseUrl(env)
  const id = (await readJson(statePath(resolve(dir))))?.[base]?.id
  if (!id) throw new CliError(`${dir} has no published game on ${base} yet. Run \`afterprompt publish ${dir}\` first.`)
  return api(env, `/api/studio/games/${id}/versions/${version ?? 'latest'}/submit`, { method: 'POST' })
}

function describeGame(game) {
  const review = game.review && game.review.state !== 'approved' && game.review.state !== 'withdrawn'
    ? `review v${game.review.version}: ${game.review.state}${game.review.reason ? ` (${game.review.reason})` : ''}`
    : ''
  return [game.id, `v${game.liveVersion ?? '-'}`, game.catalogVersion ? `catalog v${game.catalogVersion}` : 'not in catalog', review, game.title, game.playUrl].filter(Boolean).join('  ')
}

// ---- command line ----

const USAGE = `Usage:
  afterprompt login [--device|--browser] [--no-browser]
                                       sign in; --device shows a code to approve on any device
                                       (the default over SSH or without a display)
  afterprompt publish <dir> [--new] [--submit] [--json]
                                       publish <dir> as a new version; --new creates another game;
                                       --submit also sends it to catalog review
  afterprompt submit <dir> [--version N] [--json]
                                       send the live (or given) version to catalog review
  afterprompt games [--json]           list your games
  afterprompt logout                   forget the stored sign-in

AFTERPROMPT_URL picks the server (default https://afterprompt.games); AFTERPROMPT_TOKEN supplies a token.`

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, ...rest] = argv
  const flags = new Set(rest.filter(arg => arg.startsWith('--')))
  const args = rest.filter(arg => !arg.startsWith('--'))
  const print = value => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  switch (command) {
    case 'login':
      return login({ env, browser: !flags.has('--no-browser'), device: flags.has('--device') || (!flags.has('--browser') && headless(env)) })
    case 'logout':
      await storeCredentials(env, baseUrl(env), undefined)
      return console.error(`Signed out of ${baseUrl(env)}.`)
    case 'games': {
      const { games } = await api(env, '/api/studio/games')
      return print(flags.has('--json') ? games : games.length ? games.map(describeGame).join('\n') : 'No games yet.')
    }
    case 'publish': {
      if (args.length !== 1) throw new CliError('Usage: afterprompt publish <dir> [--new] [--submit] [--json]')
      const result = await publish(args[0], { env, createNew: flags.has('--new') })
      if (flags.has('--submit')) result.review = await submit(args[0], { env, version: result.version })
      if (flags.has('--json')) return print(result)
      console.error(`Published version ${result.version}: ${result.files} files, ${(result.totalBytes / 1024).toFixed(0)} KB, ${result.uploaded} uploaded.`)
      if (result.review) console.error(`Version ${result.version} is waiting for catalog review.`)
      return print(result.playUrl)
    }
    case 'submit': {
      const versionFlag = rest.find(arg => arg.startsWith('--version='))?.slice(10) ?? (rest.includes('--version') ? rest[rest.indexOf('--version') + 1] : undefined)
      const dirs = args.filter(arg => arg !== versionFlag)
      if (dirs.length !== 1) throw new CliError('Usage: afterprompt submit <dir> [--version N] [--json]')
      const version = versionFlag === undefined ? undefined : Number(versionFlag)
      if (version !== undefined && !(Number.isInteger(version) && version > 0)) throw new CliError('--version takes a version number.')
      const review = await submit(dirs[0], { env, version })
      return flags.has('--json') ? print(review) : print(`Version ${review.version} is waiting for catalog review. \`afterprompt games\` shows the decision.`)
    }
    case undefined: case 'help': case '--help': case '-h':
      return print(USAGE)
    default:
      throw new CliError(`Unknown command "${command}".\n\n${USAGE}`)
  }
}

const invoked = process.argv[1] && await realpath(process.argv[1]).then(path => path === fileURLToPath(import.meta.url), () => false)
if (invoked) {
  main().catch(error => {
    console.error(error instanceof CliError ? error.message : error)
    process.exitCode = 1
  })
}
