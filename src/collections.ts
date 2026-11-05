// SPDX-License-Identifier: MIT
import type {
  CollectionDefinitionsResponse,
  CollectionRecord as WireCollectionRecord,
  CollectionRecordHistoryResponse,
  CollectionRecordListResponse,
  CollectionRecordWrite,
  CollectionRevision as WireCollectionRevision,
} from '@fleetless/contracts'
import { FleetlessError } from './errors.js'
import { pathSegment, type HttpClient } from './http.js'

/**
 * One record of a collection: its system fields (`id`, `robot_id`, who made
 * it and when, `revision`), `display` (the collection's display template
 * filled in for this record), `missing_required` (required fields that are
 * empty because the schema changed after the record was written; absent when
 * nothing is missing) and `values`, the record's own fields by key. A field
 * without a value is absent from `values`. With `expand`, a reference field
 * holds the referenced record in this same shape instead of its id, when the
 * caller may read that collection.
 *
 * The wire shape is contracts' `collectionRecord`; the alias exists so the
 * reference can describe it.
 */
export type CollectionRecord = WireCollectionRecord

/**
 * One change in the history of a record: `seq` (the position to page and
 * restore by), the operation (`create`, `update`, `delete` or `restore`), the
 * actor, `reason` (`schema v5`, `import`, `restore v4`, or `null` for an
 * ordinary write), the record's `revision` afterwards, `changes` (each touched
 * field with its old and new value) and, on a `delete`, the whole record.
 *
 * The wire shape is contracts' `collectionRevision`.
 */
export type CollectionRevision = WireCollectionRevision

/**
 * A collection as the caller may use it, from `collections.definitions`:
 * `key`, `label`, `description`, `binding` (`global`, `per_robot` or
 * `one_per_robot`), the `display` template, every field's definition under
 * `fields`, and `can`, what the caller may do with the records (`read`,
 * `create`, and for `update` and `delete` `'all'`, `'own'` or `false`) — the
 * answer to "which buttons do I draw".
 *
 * The wire shape is one entry of `collections` in contracts'
 * `collectionDefinitionsResponse`.
 */
export type CollectionDefinition = CollectionDefinitionsResponse['collections'][number]

/**
 * What `collections.list` reads. Every field is optional; the wire names are
 * snake_case or encoded (`filter` is JSON text, `sort` and `expand` are
 * comma-separated) and this SDK spells them the way its other options are
 * spelt, leaving out whatever the caller did not set.
 */
export interface CollectionListOptions {
  /**
   * Words that must all occur, in any letter case, in at least one searchable
   * field of the record. At most 10 words, separated by whitespace.
   */
  search?: string
  /**
   * A filter: `{ "<field>": { "<op>": value } }`, combined with
   * `{ and: [...] }` and `{ or: [...] }`. The operators are `eq`, `ne`, `lt`,
   * `lte`, `gt`, `gte`, `contains`, `in` and `empty`. A field is a field key,
   * `reference.field` to go one hop through a reference field, or one of the
   * system fields `id`, `robot_id`, `created_at`, `updated_at` and
   * `created_by`. Nested at most 3 levels, 50 conditions in all. A filter the
   * cloud cannot read rejects `validation_error` naming the part that is wrong.
   */
  filter?: Record<string, unknown>
  /**
   * Up to 3 fields to sort by, a leading `-` for descending, for example
   * `['-created_at']`. Ties are broken by `id`, so a page boundary is exact.
   */
  sort?: string[]
  /** How many records to return, 1 to 500; absent means 50. Above the cap the cloud refuses with `validation_error` rather than trimming. */
  limit?: number
  /** The previous page's `nextCursor`. Send it back rather than computing one; it stays valid while records are written. */
  cursor?: string
  /** `true` makes the page carry `total`, the number of records that match. */
  count?: boolean
  /** Reference fields to embed as records instead of ids, one hop. A record is embedded only when the caller may read its collection; otherwise the id stays. */
  expand?: string[]
  /** Only the records of this robot, in a collection that belongs to robots. */
  robot?: string
  /** `true` lists deleted records instead, newest deletion first. Needs the right to create records in the collection. */
  deleted?: boolean
}

/**
 * One page of `collections.list`.
 *
 * **Page until `nextCursor` is `null`, never until a page looks short.** The
 * cloud only knows a page is the last one when there is nothing behind it.
 */
export interface CollectionPage {
  /** The records of this page, in the requested order. */
  records: CollectionRecord[]
  /** Pass it as `cursor` to read the next page; `null` on the last page. */
  nextCursor: string | null
  /** The number of records that match the whole query. Present only when the call asked for it with `count: true`. */
  total?: number
}

/** The window of `collections.history`: both fields optional, newest revisions first. */
export interface CollectionHistoryOptions {
  /** How many revisions to return, 1 to 500. */
  limit?: number
  /** The previous page's `nextBeforeSeq`: only revisions older than this `seq`. */
  beforeSeq?: number
}

/**
 * One page of a record's history, newest revision first. `purged` is set when
 * an organization owner removed the older part of the history: it starts with
 * a note saying which revisions went, who removed them and when.
 */
export interface CollectionHistoryPage {
  /** The revisions of this page, newest first. */
  revisions: CollectionRevision[]
  /** Pass it as `beforeSeq` to read older revisions; `null` when there are none. */
  nextBeforeSeq: number | null
  /** The removal of the older history, or `null` when none happened. `by` is the owner who removed it, an actor with a `label` like a record's `created_by`. */
  purged: CollectionRecordHistoryResponse['purged']
}

/**
 * The records of an app's collections, reachable as `client.collections`: the
 * app's own data model, written by a developer as a schema in the console and
 * read and written here with the caller's role.
 *
 * Every call is checked against the caller's rights on the collection and,
 * for a collection that belongs to robots, against the robots the caller
 * reaches. A collection the caller may not read at all rejects
 * `collection_not_found`, exactly as one that does not exist; one the caller
 * may read but not write rejects `forbidden`. The refusals specific to
 * records keep the cloud's codes, with `error.details` in the shape each
 * exported schema describes:
 *
 * - `required_missing` (400): `requiredMissingDetails` — the required fields left empty.
 * - `reference_invalid` (400): `referenceInvalidDetails` — the reference field and why it was refused.
 * - `record_changed` (409): `recordChangedDetails` — the revision the record is at now.
 * - `record_referenced` (409): `recordReferencedDetails` — the collections that still point at the record, with counts.
 * - `validation_error` (400), `plan_limit` (409) and `rate_limited` (429) as elsewhere.
 */
export interface CollectionsApi {
  /**
   * The collections the caller may read, with their field definitions and
   * what the caller may do with each — what a screen needs to draw a list or
   * a form without hard-coding the schema. `[]` for an app that has
   * published none, or whose roles grant this caller none.
   *
   * The schema can change under a running app; a realtime subscription's
   * `onSchemaPublished` says when to read this again.
   */
  definitions(): Promise<CollectionDefinition[]>
  /**
   * One page of a collection's records, filtered, searched and sorted by the
   * cloud. In a collection that belongs to robots the caller sees only the
   * records of robots they reach.
   */
  list(collection: string, options?: CollectionListOptions): Promise<CollectionPage>
  /**
   * One record by id. Rejects `not_found` when there is no such record or
   * the caller may not see it. `expand` embeds reference fields, one hop.
   */
  get(collection: string, id: string, options?: { expand?: string[] }): Promise<CollectionRecord>
  /**
   * The record of one robot in a `one_per_robot` collection, which always
   * has exactly one. Rejects `not_found` when the caller reaches no such
   * record — the robot is not attached to the app, or the caller does not
   * reach it.
   */
  get(collection: string, by: { robot: string }, options?: { expand?: string[] }): Promise<CollectionRecord>
  /**
   * Creates a record. `values` holds the fields by key and must set every
   * required one. A collection that belongs to robots takes `robot`, the id
   * of the robot the record belongs to, which cannot change afterwards.
   * Rejects `required_missing`, `reference_invalid` or `validation_error`
   * for values the schema refuses, and `plan_limit` when the organization is
   * at its record or storage limit. A `one_per_robot` collection takes no
   * creates (`validation_error`): the platform keeps one record for every
   * attached robot already.
   */
  create(collection: string, values: Record<string, unknown>, options?: { robot?: string }): Promise<CollectionRecord>
  /**
   * Changes the fields in `values` and leaves the others alone; a `null`
   * clears a field. With `expectedRevision` (the `revision` you last read)
   * the write is refused with `record_changed` if the record has moved on, so
   * two editors do not silently overwrite each other.
   */
  update(
    collection: string,
    id: string,
    values: Record<string, unknown>,
    options?: { expectedRevision?: number },
  ): Promise<CollectionRecord>
  /**
   * Deletes a record; its history is kept. Rejects `record_referenced` while
   * a record of another collection points at it with `on_delete: prevent`.
   * A `one_per_robot` collection takes no deletes (`validation_error`).
   */
  delete(collection: string, id: string): Promise<void>
  /**
   * A record's history, newest revision first. Needs the right to update the
   * record.
   */
  history(collection: string, id: string, options?: CollectionHistoryOptions): Promise<CollectionHistoryPage>
}

/** The routes of the caller's own app; a developer's `/api/apps/:id` routes are not this SDK's. */
const COLLECTIONS_PATH = '/api/client/collections'

/** Options -> the wire query string, omitting whatever the caller did not set rather than sending it empty. */
function listQueryString(options: CollectionListOptions): string {
  const params = new URLSearchParams()
  if (options.search !== undefined) params.set('search', options.search)
  if (options.filter !== undefined) params.set('filter', JSON.stringify(options.filter))
  if (options.sort !== undefined && options.sort.length > 0) params.set('sort', options.sort.join(','))
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.cursor !== undefined) params.set('cursor', options.cursor)
  if (options.count) params.set('count', 'true')
  if (options.expand !== undefined && options.expand.length > 0) params.set('expand', options.expand.join(','))
  if (options.robot !== undefined) params.set('robot', options.robot)
  if (options.deleted) params.set('deleted', 'true')
  return params.toString()
}

/** The `expand` query for a single-record read; empty when there is nothing to embed. */
function expandQueryString(expand: string[] | undefined): string {
  return expand !== undefined && expand.length > 0 ? new URLSearchParams({ expand: expand.join(',') }).toString() : ''
}

function withQuery(path: string, query: string): string {
  return query ? `${path}?${query}` : path
}

export function createCollectionsApi(http: HttpClient): CollectionsApi {
  const recordsPath = (collection: string): string => `${COLLECTIONS_PATH}/${pathSegment(collection)}/records`

  async function list(collection: string, options: CollectionListOptions = {}): Promise<CollectionPage> {
    const response: CollectionRecordListResponse = await http.request(withQuery(recordsPath(collection), listQueryString(options)), {})
    const page: CollectionPage = { records: response.records, nextCursor: response.next_cursor }
    if (response.total !== undefined) page.total = response.total
    return page
  }

  return {
    async definitions() {
      const response: CollectionDefinitionsResponse = await http.request(COLLECTIONS_PATH, {})
      return response.collections
    },
    list,
    async get(collection: string, idOrBy: string | { robot: string }, options: { expand?: string[] } = {}): Promise<CollectionRecord> {
      if (typeof idOrBy === 'string') {
        const record: CollectionRecord = await http.request(
          withQuery(`${recordsPath(collection)}/${pathSegment(idOrBy)}`, expandQueryString(options.expand)),
          {},
        )
        return record
      }
      // A `one_per_robot` collection holds exactly one record per robot, so a
      // list narrowed to the robot and capped at one is the whole lookup.
      const { records } = await list(collection, { robot: idOrBy.robot, limit: 1, expand: options.expand })
      const found = records[0]
      if (!found) {
        throw new FleetlessError('not_found', `Collection '${collection}' has no record for robot '${idOrBy.robot}'.`)
      }
      return found
    },
    async create(collection, values, options = {}) {
      const body: CollectionRecordWrite = { values, robot_id: options.robot }
      const record: CollectionRecord = await http.request(recordsPath(collection), { method: 'POST', body })
      return record
    },
    async update(collection, id, values, options = {}) {
      const body: CollectionRecordWrite = { values, expected_revision: options.expectedRevision }
      const record: CollectionRecord = await http.request(`${recordsPath(collection)}/${pathSegment(id)}`, { method: 'PATCH', body })
      return record
    },
    async delete(collection, id) {
      await http.request(`${recordsPath(collection)}/${pathSegment(id)}`, { method: 'DELETE', expectEmptyBody: true })
    },
    async history(collection, id, options = {}) {
      const params = new URLSearchParams()
      if (options.limit !== undefined) params.set('limit', String(options.limit))
      if (options.beforeSeq !== undefined) params.set('before_seq', String(options.beforeSeq))
      const response: CollectionRecordHistoryResponse = await http.request(
        withQuery(`${recordsPath(collection)}/${pathSegment(id)}/history`, params.toString()),
        {},
      )
      return { revisions: response.revisions, nextBeforeSeq: response.next_before_seq, purged: response.purged }
    },
  }
}
