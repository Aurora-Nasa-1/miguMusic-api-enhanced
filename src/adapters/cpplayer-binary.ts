/**
 * CPPlayer binary 模块入口（桌面端）。
 *
 * 由 `bun build src/adapters/cpplayer-binary.ts --compile` 编译为单文件
 * 可执行程序，CPPlayer 宿主以 `entry --port N` 拉起，然后对
 * `http://127.0.0.1:{port}/api/{method}` 发标准请求（见 BinaryProvider.kt）。
 *
 * 只挂 CPPlayer 标准路由（/api/{method}、/{method}、/health），
 * 不挂主 app 的 CORS / 缓存 / 文档中间件 —— 本地回环服务不需要。
 */
import { serve } from '@hono/node-server';
import cpplayerApp from '../cpplayer/routes';

const PORT_DEFAULT = 32123;

const portIdx = process.argv.indexOf('--port');
const portArg = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : NaN;
const port = Number.isFinite(portArg) && portArg > 0 ? Math.trunc(portArg) : PORT_DEFAULT;

// 宿主只访问 127.0.0.1，绑定回环地址即可，不对外网开放
const hostname = '127.0.0.1';

console.log(`[cpplayer-migu] listening on http://${hostname}:${port}`);

serve({ fetch: cpplayerApp.fetch, hostname, port });
