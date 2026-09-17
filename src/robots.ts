// SPDX-License-Identifier: MIT
import type { ClientRobotListItem, ClientRobotListResponse, McpRobotDatasheet } from '@fleetless/contracts'
import { pathSegment, type HttpClient } from './http.js'

/**
 * Discovery, reachable as `client.robots`: which robots may I name at all,
 * and what may I do on one. The two calls every app screen starts from;
 * every other namespace takes a `robotId` that came from here.
 *
 * The answers are the caller's role made visible — the same rows and the
 * same datasheet the MCP tools `robots_list` and `robot_describe` answer,
 * from the same code on the server. There is no client-side filtering to
 * do and nothing to cache: a role change shows at the next call.
 */
export interface RobotsApi {
  /**
   * The robots this caller reaches, in name order with the id as the tiebreak.
   *
   * An app user reaches the robots their app attaches on which their role
   * grants at least one slug or capability; a server key reaches every robot
   * its app attaches. A robot the role grants nothing on is absent rather
   * than listed empty — reach is a grant, not an attachment — so a new app
   * whose built-in roles grant nothing yet resolves `[]`, and that is the
   * console's Roles tab talking, not a broken login.
   */
  list(): Promise<ClientRobotListItem[]>
  /**
   * Everything the caller's role lets them do on one robot: every granted
   * datapoint (with `unit` and `decimals`), action, service and publisher
   * (with the parameter JSON Schema under `input_schema`) and camera, plus
   * the two capabilities that gate whole features, `action_history` and
   * `assets`. A robot with nothing published resolves an empty `exposures`
   * list. One the caller does not reach rejects `not_found`, exactly as a
   * robot that does not exist — never `forbidden`, which would say it exists.
   *
   * The type is `McpRobotDatasheet` because the MCP server answered it first;
   * the prefix is history, not scope.
   */
  describe(robotId: string): Promise<McpRobotDatasheet>
}

export function createRobotsApi(http: HttpClient): RobotsApi {
  return {
    async list() {
      const response: ClientRobotListResponse = await http.request('/api/client/robots', {})
      return response.robots
    },
    async describe(robotId) {
      const sheet: McpRobotDatasheet = await http.request(`/api/robots/${pathSegment(robotId)}/datasheet`, {})
      return sheet
    },
  }
}
