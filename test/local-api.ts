// SPDX-License-Identifier: MIT
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A real `node:http` server the auth suites drive the SDK against, instead of
 * a `vi.fn()` standing in for `fetch`.
 *
 * **Why a real socket, for this family.** A suite that passes its own `fetch`
 * never exercises the SDK's default one — the code that actually ships. A
 * client built with no `fetch` option (see `listen`'s doc below) resolves
 * `globalThis.fetch.bind(globalThis)` in `client.ts` and sends real bytes
 * over a real socket, so these suites assert what left the process, not what
 * a double pretended to send.
 *
 * **Measurable, not theoretical.** A `fakeFetch` assertion on `init.headers`
 * proves what the call site *constructed* — it cannot see a header the real
 * `fetch` adds by default, one this SDK stopped setting, or a body
 * `JSON.stringify` dropped. Exactly where that bites: a bodyless `POST`
 * (approve/deny) must NOT carry `content-type: application/json` — the cloud
 * refuses that combination outright — and a fake `fetch` records an omitted
 * header as happily as one we set.
 *
 * **What it still cannot see:** the browser illegal-invocation binding bug
 * (`client.ts`'s `.bind(globalThis)`) — Node's `fetch` performs no receiver
 * brand check — and CORS, since Node's `fetch` filters no response headers.
 * `client.test.ts` covers the first; only a real browser covers the second.
 */
export interface RecordedRequest {
  method: string
  /** The path with no query string, e.g. `/api/client/login`. */
  path: string
  /** The query string, already parsed — `listProviders` and `beginOidcLogin` are the two callers that use one. */
  query: URLSearchParams
  headers: IncomingHttpHeaders
  /** The raw request body as it arrived on the wire, `''` for a bodyless request. */
  body: string
  /** `body` parsed as JSON. Throws if the body was not JSON — a test asserting a JSON body wants that failure, not `undefined`. */
  json(): unknown
}

/** What a test's handler answers with. Omit `body` for a `204`/`202` that sends nothing at all. */
export interface StubReply {
  status: number
  body?: unknown
  /** Overrides the default `application/json`; only a test about content negotiation needs it. */
  contentType?: string
}

export interface LocalApi {
  /** Pass this as `apiUrl`, and pass **no** `fetch` — see this module's doc comment. */
  url: string
  /** Every request that reached the server, in order. A method that must not touch the network leaves this empty. */
  requests: RecordedRequest[]
  close(): Promise<void>
}

/**
 * Starts a server on an ephemeral loopback port that records every request and
 * answers each one from `reply`.
 *
 * `reply` receives the request that just arrived, so a handler can branch on
 * the path when a single call sends more than one (a `token_expired` retry).
 */
export async function listen(reply: (request: RecordedRequest) => StubReply): Promise<LocalApi> {
  const requests: RecordedRequest[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      // `req.url` is origin-form (`/path?query`); the second argument is a
      // base the parser needs and nothing here reads.
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1')
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path: parsed.pathname,
        query: parsed.searchParams,
        headers: req.headers,
        body: raw,
        json: () => JSON.parse(raw) as unknown,
      }
      requests.push(recorded)
      const answer = reply(recorded)
      if (answer.body === undefined) {
        res.writeHead(answer.status)
        res.end()
        return
      }
      res.writeHead(answer.status, { 'content-type': answer.contentType ?? 'application/json' })
      res.end(JSON.stringify(answer.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}
