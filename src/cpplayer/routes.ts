/**
 * CPPlayer 标准接口路由（咪咕音源）。
 *
 * 契约（与 CPPlayer-KMP 宿主的 HttpProvider / BinaryProvider 对齐）：
 * - **binary 模式**（本仓库 `bun build --compile` 出的单文件）：
 *   宿主以 `entry --port N` 拉起进程，然后 `POST http://127.0.0.1:{port}/api/{method}`；
 * - **http 模式**（托管实例，Workers / Node / Deno 均可）：
 *   宿主对 `POST {entryPoint}/{method}` 发请求，manifest 的 `entryPoint`
 *   填部署地址（如 `https://host/cpplayer`）。
 *
 * 两种模式参数一致：JSON body（或 query），全字符串；响应即
 * `dispatchCpPlayerMethod` 返回的网易云标准形状 JSON。
 */
import { Hono, type Context } from 'hono';
import { dispatchCpPlayerMethod, type CpPlayerParams } from './migu';

const app = new Hono();

/** 支持的方法清单，给 /health 用，也方便宿主侧排查。 */
const SUPPORTED_METHODS = [
    'cloudsearch',
    'search/suggest',
    'search/hot/detail',
    'song/detail',
    'song/url/v1',
    'song/url/v1/302',
    'song/download/url/v1',
    'lyric/new',
    'playlist/detail',
    'playlist/track/all',
    'album',
    'artist/detail',
    'artist/songs',
    'artist/album',
    'toplist',
    'toplist_detail',
    'recommend/resource',
    'recommend/songs',
    'personal_fm',
] as const;

// 健康检查（宿主 isReady 轮询 / 人工排查用）
app.get('/health', (c) =>
    c.json({
        code: 200,
        ready: true,
        provider: 'migu',
        version: '1.0.0',
        methods: SUPPORTED_METHODS,
    }),
);

async function handleCall(c: Context): Promise<Response> {
    const method = c.req.param('method') ?? '';
    // 宿主传 JSON body（全字符串）；query 作为调试补充，body 优先
    const params: CpPlayerParams = {};
    let body: unknown = null;
    try {
        body = JSON.parse(await c.req.text());
    } catch {
        body = null;
    }
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
        for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
            params[k] = String(v);
        }
    }
    const result = await dispatchCpPlayerMethod(method, params);
    return Response.json(result);
}

// binary 模式入口：POST /api/{method}
app.post('/api/:method{.+}', handleCall);
// http 模式入口：POST /{method}（子应用挂载前缀不影响 param 提取）
app.post('/:method{.+}', handleCall);

export default app;
