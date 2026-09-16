#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Regression guard for a real, live bug: `dist/index.d.ts` imported types from
// `@fleetless/contracts`, which is a **devDependency** here and therefore not
// in the published tarball's `dependencies` — so no consumer has it in
// `node_modules`, and their `tsc` fails with TS2307 while the runtime JS works
// fine (type-only imports are erased). That is still true now that contracts is
// a public npm package: publishing it changed where it can be installed from,
// not whether an SDK consumer installs it at all. tsup's `dts.resolve` inlines
// contracts' types at build time (see tsup.config.ts); this script proves that
// holds by doing exactly what a stranger does: `npm pack`, install the tarball
// into a bare project with nothing but `typescript`, and typecheck real usage
// against it.
//
// Also runs the tarball, not just typechecks it — `parameterInvalidDetails`
// is the first *value* re-export from `@fleetless/contracts`, and a
// value import is not erased the way a type-only one is: tsup has to
// actually bundle contracts' runtime code into `dist/`, or a consumer's
// `node_modules` (which never has the unpublished `@fleetless/contracts`)
// hits an unresolved import the moment that value is touched. `tsc
// --noEmit` cannot see that failure mode at all — the type still resolves
// from the inlined `.d.ts` even if the value behind it is broken — so this
// guard actually `node`s a small script against the installed tarball
// after the typecheck passes. There is a second, *internal* instance of the
// same risk: `cameras.ts` imports `SNAPSHOT_HEADERS` (a value, not a type)
// from `@fleetless/contracts` to know which response headers to read — that
// import never appears in this package's own public types, so nothing in
// `usage.ts` below would notice if it broke; only actually calling
// `cameras.snapshot()` against the built tarball does.
//
// Not part of `pnpm test` (vitest) — that suite stays offline and fast.
// Run explicitly: `pnpm test:pack`. Needs `npm` and network access for a
// public `typescript`/`zod` install.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INTERNAL_HOST, detectors, hitsIn } from './internal-markers.mjs'

const sdkRoot = fileURLToPath(new URL('..', import.meta.url))

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { cwd: sdkRoot, encoding: 'utf8', stdio: 'pipe', ...options })
}

// Deliberately NOT an explicit `pnpm build` first. `npm pack` runs the
// `prepare` lifecycle script (tsup) on its own before assembling the
// tarball — the same hook a git-hosted `pnpm install` triggers — so calling
// `pnpm build` here would hand the guard the artefact whose production is
// the very thing under test. A check that builds before verifying the
// build cannot tell you whether the build happens: that gap is exactly why
// this guard could not have caught a missing `prepare` script
// no matter how thorough it was otherwise. Verified before
// deleting the line, not assumed: `rm -rf dist && npm pack --dry-run`
// produces a correct dist/ with nothing else run first.
console.log('== npm pack ==')
const workDir = mkdtempSync(join(tmpdir(), 'fleetless-sdk-scoped-pack-verify-'))

/**
 * Refuse, and take the scratch directory with us.
 *
 * **`process.exit()` does not run a `finally`.** Every refusal below used to
 * call it directly from inside the `try` whose `finally` removes `workDir`, so
 * a failing run left a few hundred megabytes of tarball, `node_modules` and two
 * scratch npm projects behind in the system temp directory — once per failure,
 * never cleaned up. A passing run cleaned up correctly, which is why it went
 * unnoticed: the only runs that littered were the ones nobody was looking at
 * afterwards.
 *
 * Every refusal goes through here. The exit code is unchanged, and so is what
 * gets printed, so nothing about how this guard fails has moved — only what it
 * leaves behind.
 */
function fail(...lines) {
  for (const line of lines) console.error(line)
  rmSync(workDir, { recursive: true, force: true })
  process.exit(1)
}

try {
  run('npm', ['pack', '--pack-destination', workDir])
  const tarball = readdirSync(workDir).find((f) => f.endsWith('.tgz'))
  if (!tarball) throw new Error('npm pack produced no .tgz')
  const tarballPath = join(workDir, tarball)

  // Nothing the SDK needs at runtime may sit behind a `git+`, `file:` or
  // `link:` specifier. Such a dependency installs fine on a machine that
  // happens to have the repository or the path, and fails for everyone else —
  // the exact shape of bug this guard exists to catch, one field over from
  // where it otherwise looks. So read the *packed* package.json (not the
  // repo's, which could differ) and fail before install ever gets a chance to
  // succeed for the wrong reason.
  //
  // **Every dependency section, not `dependencies` alone.** The internal host
  // that shipped inside 3.0.0's published manifest was in `devDependencies`, a
  // section this check did not open — and `npm pack` keeps `devDependencies` in
  // the tarball's `package.json`, so it was published verbatim while the check
  // reported clean.
  console.log('== packed dependency specifiers are all installable from the registry ==')
  const packedManifest = JSON.parse(run('tar', ['-xOf', tarballPath, 'package/package.json']))
  const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
  const badDeps = DEP_SECTIONS.flatMap((section) =>
    Object.entries(packedManifest[section] ?? {})
      .filter(([, specifier]) => /^(git\+|file:|link:|ssh:|https?:)/.test(specifier))
      .map(([name, specifier]) => [`${section}.${name}`, specifier]),
  )
  if (badDeps.length > 0) {
    fail(
      `✗ packed package.json has a local/git dependency, installable here but not for anyone outside this org:`,
      ...badDeps.map(([name, specifier]) => `    ${name}: ${specifier}`),
    )
  }
  // The manifest ships whole, so every string in it is published prose — and it
  // is npm's copy, which can differ from the one on disk. The marker detectors
  // are imported rather than restated: a second copy of the host pattern here
  // would be a second policy, and this file has been the one that leaked
  // already.
  {
    const manifestText = run('tar', ['-xOf', tarballPath, 'package/package.json'])
    const markers = detectors('sdk').filter((d) => !d.stance)
    if (markers.length < 10) fail(`✗ only ${markers.length} marker detector(s) loaded`)
    const found = markers.flatMap((d) => hitsIn(d, `package.json [${d.name}]`, manifestText))
    if (found.length > 0) fail('✗ the packed package.json carries internal text:', ...found.map((f) => `    ${f}`))
    console.log(`  the packed manifest is clean against ${markers.length} marker detectors`)
  }

  // The npm page, and every legal review a consumer runs, reads the tarball.
  // So the licence has to be *in the package*: a LICENSE file next to the code
  // and an SPDX id in the manifest, both read back out of the packed artefact
  // rather than off disk.
  //
  // **`repository` is checked against the host shape, not for being
  // reachable.** It used to be refused outright, on the reasoning that
  // the source was private and a repository field would send readers to a
  // URL none of them can open. That reasoning is being retired: the SDK gets
  // a public GitHub repository, and the field then has to be there. What
  // this check catches is the failure the old check was aimed at — a
  // `repository` pointing at a host only a maintainer can reach, a dead link
  // for every reader of the npm page. `INTERNAL_HOST` is imported rather than
  // restated: this file spelt the hostname out in a regex of its own, which
  // published it just as well as the field would have. It fetches nothing,
  // so it does NOT catch every dead link: today, `repository:
  // https://github.com/fleetless/sdk` would pass and still 404 for an
  // anonymous reader, because the repository is private. That residual stays
  // until the repository is public.
  console.log('== the tarball carries the licence and says so ==')
  const packedFiles = run('tar', ['-tf', tarballPath]).split('\n')
  // npm ships LICENSE and README.md whatever `files` says, so every OTHER
  // entry here depends on that list being right — and is therefore what a wrong
  // `files` can silently drop. The three community documents are on it because
  // the README links them relatively: a reader who opens the package from
  // `node_modules`, or the npm page's own file browser, follows those links,
  // and a missing SECURITY.md turns "here is how to report a vulnerability"
  // into a 404.
  for (const entry of [
    'package/LICENSE',
    'package/CHANGELOG.md',
    'package/SECURITY.md',
    'package/CONTRIBUTING.md',
    'package/CODE_OF_CONDUCT.md',
  ]) {
    if (!packedFiles.includes(entry)) fail(`✗ ${entry.replace('package/', '')} is not in the tarball`)
  }

  // **And every relative link in every shipped document resolves inside the
  // tarball**, which the five names above are only examples of. The requirement
  // is about links; a list of five filenames is that requirement guarded by
  // five examples, and it missed the one dangling link there was:
  // CONTRIBUTING.md's `[RELEASING.md](RELEASING.md)`, to a file `files` does
  // not ship. Adding a sixth document, or renaming one, reproduces it.
  {
    const RELATIVE_LINK = /\[[^\]]*\]\(([^)#:\s]+)(?:#[^)\s]*)?\)/g
    const docs = packedFiles.filter((f) => f.endsWith('.md'))
    if (docs.length < 5) fail(`✗ the tarball holds ${docs.length} markdown file(s); expected at least 5`)
    const packed = new Set(packedFiles)
    const dangling = []
    let linksChecked = 0
    for (const doc of docs) {
      const text = run('tar', ['-xOf', tarballPath, doc])
      const dir = doc.slice(0, doc.lastIndexOf('/') + 1)
      for (const [, target] of text.matchAll(RELATIVE_LINK)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue
        linksChecked++
        // Resolved against the document's own directory, the way npm's file
        // browser and an editor opening `node_modules` both do.
        const stack = []
        for (const part of (dir + target).split('/')) {
          if (part === '.' || part === '') continue
          else if (part === '..') stack.pop()
          else stack.push(part)
        }
        const resolved = stack.join('/')
        if (!packed.has(resolved)) dangling.push(`${doc} \u2192 ${target}`)
      }
    }
    // Anti-vacuity: a link regex that stopped matching would report zero
    // dangling links about zero links, which is the same green tick.
    if (linksChecked < 5) fail(`✗ only ${linksChecked} relative link(s) found across ${docs.length} shipped documents`)
    if (dangling.length > 0) {
      fail(
        `✗ ${dangling.length} relative link(s) in shipped documents point outside the tarball:`,
        ...dangling.map((d) => `    ${d}`),
      )
    }
    console.log(`  ${linksChecked} relative link(s) across ${docs.length} documents all resolve inside the tarball`)
  }

  // **What must NOT be in the tarball**, which the presence loop above cannot
  // say anything about. A widened `files` — `"src"` added, or tsup sourcemaps
  // turned on, whose `sourcesContent` embeds the whole source tree — ships
  // every comment that esbuild strips out of `dist/`, with every assertion
  // above still green.
  {
    const allowedTop = new Set([...(packedManifest.files ?? []), 'package.json', 'README.md', 'LICENSE'])
    const unexpected = packedFiles
      .filter(Boolean)
      .map((f) => f.replace(/^package\//, ''))
      .filter((f) => f && !allowedTop.has(f.split('/')[0]))
    if (unexpected.length > 0) {
      fail(`✗ the tarball carries entries outside \`files\`: ${unexpected.join(', ')}`)
    }
    const sourcemaps = packedFiles.filter((f) => f.endsWith('.map'))
    if (sourcemaps.length > 0) {
      fail(
        `✗ the tarball carries sourcemaps: ${sourcemaps.join(', ')}`,
        '  Their `sourcesContent` embeds the whole source tree, comments included.',
      )
    }
    const sourceLeak = packedFiles.filter((f) => /^package\/(src|test|scripts)\//.test(f))
    if (sourceLeak.length > 0) fail(`✗ the tarball carries source files: ${sourceLeak.join(', ')}`)
    console.log(`  ${packedFiles.filter(Boolean).length} tarball entries, all inside \`files\`, no sourcemaps, no source`)
  }

  // The SPDX header on the bytes a consumer actually receives.
  //
  // `test/license-headers.test.ts` asserts it over `src/`, `test/` and
  // `scripts/`, none of which is published. `dist/` is, and `tsup` writes no
  // header of its own — `scripts/stamp-dist.mjs` adds it after the build. That
  // script reports what it stamped, but a script's own report cannot tell a
  // stamped build from a stamped *publish*: `npm pack` runs `prepare`, so the
  // tarball is built fresh, and reading the `dist/` sitting on disk would be
  // answering about a different artefact than the one going to the registry.
  // So the header is read back out of the tarball.
  {
    const distEntries = packedFiles.filter((f) => /^package\/dist\/.+\.(js|cjs|mjs|d\.ts|d\.cts)$/.test(f))
    // Anti-vacuity: four emits, and a `dist/` the pack did not produce would
    // otherwise make the loop below assert nothing at all.
    if (distEntries.length < 4) {
      fail(`✗ the tarball holds ${distEntries.length} dist file(s); expected at least 4`)
    }
    //
    // **The whole file, not its first line.** `startsWith` reads exactly one
    // line and is structurally incapable of seeing a second, contradicting
    // identifier below it — which is what `index.d.ts` and `index.d.cts`
    // carried: six inherited `Apache-2.0` tags under the MIT one, in a package
    // whose manifest and LICENSE say MIT only. A consumer's licence scan reads
    // file-level tags, so it reported Apache obligations for a tarball that
    // ships no Apache text, and this guard could not tell "this file is MIT"
    // from "this file claims two licences". `scripts/stamp-dist.mjs` strips the
    // inherited ones; this is the assertion that says it did.
    const SPDX_LINE = /^\/\/ SPDX-License-Identifier: (.+)$/gm
    const wrong = []
    for (const entry of distEntries) {
      const text = run('tar', ['-xOf', tarballPath, entry])
      const ids = [...text.matchAll(SPDX_LINE)].map((m) => m[1].trim())
      if (ids.length === 0) wrong.push(`${entry}: no SPDX identifier`)
      else if (!text.startsWith('// SPDX-License-Identifier: MIT')) wrong.push(`${entry}: does not open with the MIT identifier`)
      else if (ids.length > 1) wrong.push(`${entry}: carries ${ids.length} identifiers (${[...new Set(ids)].join(', ')})`)
    }
    if (wrong.length > 0) {
      fail(`✗ the published files do not each declare exactly one licence:`, ...wrong.map((w) => `    ${w}`))
    }
    console.log(`  all ${distEntries.length} dist files carry exactly one SPDX identifier, and it is MIT`)
  }
  if (packedManifest.license !== 'MIT') fail(`✗ packed package.json license is ${JSON.stringify(packedManifest.license)}, expected "MIT"`)
  for (const field of ['author', 'homepage', 'bugs', 'keywords']) if (!packedManifest[field]) fail(`✗ packed package.json has no ${field}`)
  {
    const repo = packedManifest.repository
    const url = typeof repo === 'string' ? repo : repo?.url
    if (url && INTERNAL_HOST.test(url)) {
      fail(
        `✗ packed package.json repository points at an internal host: ${url}`,
        '  Every reader of the npm page gets a dead link. Point it at the public repository or leave the field out.',
      )
    }
    if (repo && !url) fail('✗ packed package.json has a repository field with no url')
    console.log(url ? `  repository: ${url}` : '  repository: absent (allowed until the public repository exists)')
  }

  const bareProject = join(workDir, 'bare-project')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(bareProject)
  writeFileSync(join(bareProject, 'package.json'), JSON.stringify({ name: 'bare-project', private: true, type: 'module' }))
  writeFileSync(
    join(bareProject, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: false },
    }),
  )
  // Mirrors the README's own quick-start shape — if this ever stops
  // typechecking, the README's first example is broken too.
  writeFileSync(
    join(bareProject, 'usage.ts'),
    [
      "import { createClient, FleetlessError, InMemoryTokenStore, parameterInvalidDetails } from '@fleetless/sdk'",
      "import type { DatapointValue, DatapointEvent, ClientIdentity, TokenStore, StoredSession, ParameterInvalidDetails } from '@fleetless/sdk'",
      "import type { CameraDescriptor, CameraSnapshot, CameraSnapshotMeta, CameraLiveSession } from '@fleetless/sdk'",
      "import type { Job, AssetListResponse, Asset, UrdfCompleteness, AssetBytes, MeshLoaderDelegate } from '@fleetless/sdk'",
      "import type { JobEvent, JobSubscription, JobSubscriptionHandlers } from '@fleetless/sdk'",
      "import type { HistoryOptions, HistoryAggregation, HistorySamplesResponse, HistoryBucketsResponse } from '@fleetless/sdk'",
      "import type { UrdfSceneManager, PrepareUrdfSceneOptions, UrdfSceneResources } from '@fleetless/sdk'",
      "import type { RegisterOptions, AcceptInvitationOptions, ProviderButton, McpInteractionDecision } from '@fleetless/sdk'",
      "import type { BeginOidcLoginOptions, OidcLoginRequest, CompleteOidcLoginOptions } from '@fleetless/sdk'",
      "import type { ClientMcpInteraction, McpConsentGrant, ClientOidcErrorCode } from '@fleetless/sdk'",
      '',
      "const client = createClient({ apiUrl: 'https://api.fleetless.dev', appIdentifier: 'app_x', tokenStore: new InMemoryTokenStore() })",
      '',
      'async function readBattery(): Promise<DatapointValue> {',
      "  return client.datapoints.get('robot-id', 'battery-percentage')",
      '}',
      '',
      'function subscribe(): void {',
      "  client.datapoints.subscribe('robot-id', 'battery-percentage', {",
      '    onEvent(event: DatapointEvent) { void event },',
      '    onError(error: FleetlessError) { void error.code },',
      '  })',
      '}',
      '',
      'async function whoAmI(): Promise<ClientIdentity> {',
      '  return client.auth.me()',
      '}',
      '',
      '// The client auth API (3.0.0). Every option/result type below is defined',
      "// in this package itself (not re-exported from @fleetless/contracts, unlike",
      '// ClientIdentity above), so this is the guard that the BUILT tarball',
      '// publishes them rather than merely src/ declaring them.',
      'async function registration(): Promise<void> {',
      "  const options: RegisterOptions = { email: 'a@b.de', password: 'correct-horse-battery', displayName: 'Ada' }",
      '  await client.auth.register(options)',
      "  await client.auth.resendVerification('a@b.de')",
      "  await client.auth.verifyEmail('token-from-the-mail')",
      '}',
      '',
      'async function recovery(): Promise<void> {',
      "  await client.auth.requestPasswordReset('a@b.de')",
      "  await client.auth.confirmPasswordReset('token-from-the-mail', 'new-correct-horse-battery')",
      "  await client.auth.changePassword('old-correct-horse-battery', 'new-correct-horse-battery')",
      "  const invitation: AcceptInvitationOptions = { token: 'token-from-the-mail', password: 'correct-horse-battery' }",
      '  await client.auth.acceptInvitation(invitation)',
      '}',
      '',
      '// Federated sign-in, per app: the SDK builds the URL and never navigates.',
      'async function federated(): Promise<void> {',
      '  const providers: ProviderButton[] = await client.auth.listProviders()',
      "  const options: BeginOidcLoginOptions = { slug: providers[0]?.slug ?? 'okta', redirectUri: 'https://app.example.com/cb' }",
      '  const request: OidcLoginRequest = await client.auth.beginOidcLogin(options)',
      '  // A real caller persists request.state/request.codeVerifier here (they do',
      '  // not survive the redirect), navigates to request.url, and later reads',
      '  // code/state back off the query string of the redirect to redirectUri.',
      "  const failed = client.auth.oidcErrorFromCallback(new URLSearchParams('error=no_access'))",
      '  if (failed) {',
      '    const reason: ClientOidcErrorCode | string = failed.code',
      '    void reason',
      '    return',
      '  }',
      '  const complete: CompleteOidcLoginOptions = {',
      "    code: 'code-from-redirect',",
      '    state: request.state,',
      '    expectedState: request.state,',
      '    codeVerifier: request.codeVerifier,',
      '  }',
      '  return client.auth.completeOidcLogin(complete)',
      '}',
      '',
      '// The MCP consent screen and the standing grants behind it.',
      'async function mcpConsent(): Promise<void> {',
      "  const interaction: ClientMcpInteraction = await client.auth.mcpInteraction('int_123')",
      '  // client_name_verified is the literal false — never render the name as an identity.',
      '  void interaction.client_name_verified',
      '  const decision: McpInteractionDecision = interaction.already_granted',
      "    ? await client.auth.approveMcpInteraction('int_123')",
      "    : await client.auth.denyMcpInteraction('int_123')",
      '  void decision.redirectTo',
      '  const grants: McpConsentGrant[] = await client.auth.listMcpGrants()',
      "  for (const grant of grants) await client.auth.revokeMcpGrant(grant.client_id)",
      '}',
      '',
      'const customStore: TokenStore = {',
      '  load: (): StoredSession | null => null,',
      '  save: (_session: StoredSession | null): void => {},',
      '}',
      '',
      '// Actions/services/publishers — once unexercised by this guard, while',
      '// only auth/datapoints, cameras and jobs/assets were.',
      'async function invokeAction(): Promise<Job> {',
      "  return client.actions.invoke('robot-id', 'dock', { speed: 1 })",
      '}',
      '',
      'async function cancelAction(): Promise<Job | null> {',
      "  return client.actions.cancel('robot-id', 'dock')",
      '}',
      '',
      'function subscribeAction(): JobSubscription {',
      "  return client.actions.subscribe('robot-id', 'dock', {",
      '    onJob(event: JobEvent) { void event },',
      '    onError(error: FleetlessError) { void error.code },',
      '  } satisfies JobSubscriptionHandlers)',
      '}',
      '',
      'async function callService(): Promise<unknown> {',
      "  return client.services.call('robot-id', 'get_status', {})",
      '}',
      '',
      'async function publishMessage(): Promise<void> {',
      "  return client.publishers.publish('robot-id', 'cmd_vel', { linear: { x: 0 } })",
      '}',
      '',
      '// History — the same gap as above, and closed for the same reason.',
      'async function readHistorySamples(): Promise<HistorySamplesResponse> {',
      "  return client.datapoints.history('robot-id', 'battery-percentage', { from: 'now-1h' })",
      '}',
      '',
      'async function readHistoryBuckets(): Promise<HistoryBucketsResponse> {',
      "  const aggregate: HistoryAggregation = { window: '1m', agg: 'avg' }",
      "  const options: HistoryOptions & { aggregate: HistoryAggregation } = { from: 'now-1h', aggregate }",
      "  return client.datapoints.history('robot-id', 'battery-percentage', options)",
      '}',
      '',
      '// The type side of parameterInvalidDetails (a value re-export — see runtime-check.mjs',
      '// below for the half this cannot prove: that the value itself resolves at runtime).',
      'function parseParameterInvalid(details: unknown): ParameterInvalidDetails {',
      '  return parameterInvalidDetails.parse(details)',
      '}',
      '',
      "// Cameras — CameraDescriptor is a type re-exported straight from",
      '// @fleetless/contracts, exactly the kind of import that broke before',
      '// dts.resolve inlined it; CameraSnapshot/CameraSnapshotMeta/CameraLiveSession',
      '// are defined in this package itself but built on that same inlining.',
      'async function listCameras(): Promise<CameraDescriptor[]> {',
      "  return client.cameras.list('robot-id')",
      '}',
      '',
      'async function readSnapshot(): Promise<CameraSnapshot> {',
      "  return client.cameras.snapshot('robot-id', 'front')",
      '}',
      '',
      'async function readSnapshotMeta(): Promise<CameraSnapshotMeta> {',
      "  return client.cameras.snapshotMeta('robot-id', 'front')",
      '}',
      '',
      'async function watchLive(): Promise<void> {',
      "  const session: CameraLiveSession = await client.cameras.live('robot-id', 'front')",
      '  await session.release()',
      '}',
      '',
      "// Jobs — Job is a type re-exported straight from",
      '// @fleetless/contracts, same pattern as CameraDescriptor above.',
      'async function listJobs(): Promise<Job[]> {',
      "  return client.jobs.list('robot-id')",
      '}',
      '',
      "// Assets — AssetListResponse/Asset/UrdfCompleteness are re-exported",
      '// straight from @fleetless/contracts; AssetBytes/MeshLoaderDelegate are',
      '// defined in this package itself but built on that same inlining.',
      'async function listAssets(): Promise<AssetListResponse> {',
      "  return client.assets.list('robot-id')",
      '}',
      '',
      'async function getAsset(): Promise<AssetBytes> {',
      "  return client.assets.get('robot-id', 'asset-id')",
      '}',
      '',
      'async function readUrdf(): Promise<string> {',
      "  return client.assets.urdf('robot-id')",
      '}',
      '',
      'function meshLoader(): MeshLoaderDelegate {',
      "  return client.assets.createMeshLoader('robot-id', (_path, _manager, _material, onComplete) => onComplete(null))",
      '}',
      '',
      'function checkAssetShape(asset: Asset, completeness: UrdfCompleteness): void {',
      '  void asset.sha256; void completeness.missing',
      '}',
      '',
      "// prepareUrdfScene — UrdfSceneManager is structural (no three.js",
      '// dependency), so a plain object satisfying it is enough to typecheck this',
      '// without pulling in three.js as a test dependency.',
      'const fakeManager: UrdfSceneManager = { setURLModifier: (_callback: (url: string) => string) => undefined }',
      '',
      'async function prepareScene(): Promise<UrdfSceneResources> {',
      // signal — checked here for the same reason the
      // auth option types are above: prove the field typechecks against the
      // BUILT tarball, not merely against src/.
      "  const options: PrepareUrdfSceneOptions = { concurrency: 4, signal: new AbortController().signal }",
      "  return client.assets.prepareUrdfScene('robot-id', fakeManager, options)",
      '}',
      '',
      'void readBattery; void subscribe; void whoAmI; void customStore; void parseParameterInvalid',
      'void registration; void recovery; void federated; void mcpConsent',
      'void listCameras; void readSnapshot; void readSnapshotMeta; void watchLive',
      'void listJobs; void listAssets; void getAsset; void readUrdf; void meshLoader; void checkAssetShape',
      'void invokeAction; void cancelAction; void subscribeAction; void callService; void publishMessage',
      'void readHistorySamples; void readHistoryBuckets; void prepareScene',
      '',
    ].join('\n'),
  )

  // Plain JS, run directly with `node` — no compile step, so it exercises
  // exactly what a consumer's require/import graph resolves at runtime,
  // not what tsc resolves from the (separately inlined) .d.ts.
  writeFileSync(
    join(bareProject, 'runtime-check.mjs'),
    [
      "import { parameterInvalidDetails, createClient } from '@fleetless/sdk'",
      '',
      'const result = parameterInvalidDetails.parse({',
      "  violations: [{ field: 'order', rule: 'required', message: 'order is required' }],",
      '})',
      "if (result.violations.length !== 1 || result.violations[0].field !== 'order') {",
      "  throw new Error('parameterInvalidDetails.parse returned an unexpected shape: ' + JSON.stringify(result))",
      '}',
      "console.log('runtime parse OK')",
      '',
      "// cameras.ts imports SNAPSHOT_HEADERS — a runtime VALUE from",
      '// @fleetless/contracts, not just a type — to know which response',
      '// headers to read. usage.ts above only proves the *types* resolve;',
      '// this proves that value import is actually bundled into dist/ and',
      '// used correctly, by driving snapshot() end to end against a fake',
      '// fetch and checking the parsed fields came from the right headers.',
      "const fakeFetch = async () =>",
      '  new Response(new Uint8Array([1, 2, 3]), {',
      '    status: 200,',
      "    headers: {",
      "      'content-type': 'image/jpeg',",
      "      'x-fleetless-age-ms': '42',",
      "      'x-fleetless-timestamp-ms': '1786440000000',",
      "      'x-fleetless-width': '1280',",
      "      'x-fleetless-height': '720',",
      '    },',
      '  })',
      '',
      "const client = createClient({ apiUrl: 'https://api.fleetless.dev', appIdentifier: 'app_x', serverKey: 'flk_x', fetch: fakeFetch })",
      "const snap = await client.cameras.snapshot('robot-id', 'front')",
      "if (snap.mime !== 'image/jpeg' || snap.age_ms !== 42 || snap.width !== 1280 || snap.height !== 720) {",
      "  throw new Error('cameras.snapshot() returned an unexpected shape: ' + JSON.stringify(snap))",
      '}',
      "console.log('runtime cameras.snapshot() OK')",
      '',
    ].join('\n'),
  )

  console.log('== npm install (bare project: the tarball + typescript only) ==')
  run('npm', ['install', '--no-audit', '--no-fund', tarballPath, 'typescript'], { cwd: bareProject })

  console.log('== tsc --noEmit ==')
  run('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], { cwd: bareProject })

  console.log('== node runtime-check.mjs (proves the value re-export actually resolves and works, not just its type) ==')
  run('node', ['runtime-check.mjs'], { cwd: bareProject })

  // The bare project above resolves with `moduleResolution: Bundler`, which
  // reads the exports map's top-level `types` and never enters the
  // *conditional* type-resolution path at all. So it cannot see the shape of
  // bug this second project exists for: a map that offers `require` a
  // JavaScript entry point but only ever an ESM `.d.ts` alongside it. Under
  // `node16`/`nodenext` — what a plain `tsc` in a plain Node project uses —
  // TypeScript then refuses the require with TS1479 ("the referenced file is
  // an ECMAScript module and cannot be imported with 'require'"), while the
  // runtime half works fine. With the single-`types`
  // map this package shipped in 1.0.0, `usage.cts` below fails exactly that
  // way and `usage.mts` passes.
  //
  // One project, no `"type"` field (so CommonJS), and the extension decides
  // the module system per file: `.mts` takes the `import` condition and
  // `.cts` the `require` one. Both conditions of the map are therefore
  // typechecked by the same run, which is the claim the README makes when it
  // advertises ESM **and** CJS.
  console.log('== the exports map types BOTH conditions (node16 resolution, ESM + CJS) ==')
  const dualProject = join(workDir, 'dual-resolution-project')
  mkdirSync(dualProject)
  writeFileSync(join(dualProject, 'package.json'), JSON.stringify({ name: 'dual-resolution-project', private: true }))
  writeFileSync(
    join(dualProject, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'node16', moduleResolution: 'node16', strict: true, skipLibCheck: false, noEmit: true },
    }),
  )
  // Deliberately the same source text in both files. The point is not what
  // the code does — it is which `.d.ts` the resolver reaches for it, and a
  // difference between the two files would blur that.
  const dualUsage = [
    "import { createClient, FleetlessError, InMemoryTokenStore } from '@fleetless/sdk'",
    "import type { ClientIdentity, DatapointValue } from '@fleetless/sdk'",
    '',
    "const client = createClient({ apiUrl: 'https://api.fleetless.dev', appIdentifier: 'app_x', tokenStore: new InMemoryTokenStore() })",
    '',
    'export async function whoAmI(): Promise<ClientIdentity> {',
    '  return client.auth.me()',
    '}',
    '',
    'export async function readBattery(): Promise<DatapointValue> {',
    "  return client.datapoints.get('robot-id', 'battery-percentage')",
    '}',
    '',
    'export function errorCode(error: FleetlessError): string {',
    '  return error.code',
    '}',
    '',
  ].join('\n')
  writeFileSync(join(dualProject, 'usage.mts'), dualUsage)
  writeFileSync(join(dualProject, 'usage.cts'), dualUsage)

  console.log('== npm install (dual-resolution project: the tarball + typescript only) ==')
  run('npm', ['install', '--no-audit', '--no-fund', tarballPath, 'typescript'], { cwd: dualProject })

  console.log('== tsc --noEmit (node16: usage.mts takes `import`, usage.cts takes `require`) ==')
  run('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], { cwd: dualProject })

  console.log('\nOK — the published package typechecks AND runs with nothing but `typescript` installed.')
} catch (error) {
  console.error('\nFAILED — a stranger cannot use the published package as-is.\n')
  if (error.stdout) console.error(error.stdout)
  if (error.stderr) console.error(error.stderr)
  process.exitCode = 1
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
