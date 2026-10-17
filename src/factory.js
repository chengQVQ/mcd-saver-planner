/**
 * 规划器工厂
 *
 * 从 CLI 入口中抽离，避免 src/index.js ↔ src/workflow/testSuite.js 之间形成循环依赖。
 */

import { McpClient } from './mcp/client.js';
import { McdTools } from './mcp/tools.js';
import { SaverPlanner } from './workflow/mainFlow.js';
import { createMockFetch } from '../mock/transport.js';

/**
 * 构建规划器实例
 * @param {Object} options
 * @param {boolean} [options.offline] 离线模式，使用内置 mock 数据
 * @returns {SaverPlanner}
 */
export function createPlanner({ offline = false } = {}) {
  const client = offline
    ? new McpClient({ fetchImpl: createMockFetch() })
    : new McpClient();
  const tools = new McdTools({ client });
  return new SaverPlanner({ tools, offline });
}

export default { createPlanner };
