# 咪咕音乐 × CPPlayer 音源模块

把本仓库的咪咕接口能力，做成 **CPPlayer-KMP 的外部模块**（`manifest.json` + zip）。
**不改 CPPlayer 本体任何代码** —— 宿主内置的 `MiguProvider` 已移除，本模块是其替代品，
接口行为一比一对齐（移植底本见仓库根 `reference/MiguProvider.kt.reference`）。

## 1. 两种形态，按平台选

| | **http 型**（默认） | **binary 型** |
|---|---|---|
| zip 内容 | 只有 `manifest.json` | `manifest.json` + `lib/x86_64/cpplayer-server.exe` |
| 适用 | **Android / 桌面**（只要能访问部署实例） | **仅桌面**（Windows x86_64） |
| 依赖 | 一个已部署的本服务实例（见 §3） | 无，宿主自动拉起单文件进程 |
| 宿主行为 | `POST {entryPoint}/{method}` | `entry --port N` 拉起后 `POST http://127.0.0.1:{port}/api/{method}` |

> bun 没有 Android 目标，且 Android 10+ 限制 exec 私有目录二进制 —— 所以 Android 走 http 型。

## 2. 安装

应用内 **设置 → 音源管理 → 导入模块**，选择对应 zip：

- `cpplayer/migu-cpplayer-http-v{ver}.zip`
- `cpplayer/migu-cpplayer-binary-win-v{ver}.zip`

## 3. 部署服务实例（http 型需要）

本仓库本来就是多端服务，任意一种方式起一个实例即可，CPPlayer 标准路由挂在
**`/cpplayer`** 前缀下（实现见 `src/cpplayer/routes.ts`）：

```bash
pnpm install
pnpm dev                     # Node 本机调试，http://127.0.0.1:6200/cpplayer
pnpm deploy:cf               # Cloudflare Workers
pnpm deploy:vercel           # Vercel Edge
```

打包 http 型模块时把部署地址写进 manifest：

```bash
CPPLAYER_BASE_URL=https://your-instance.example.com/cpplayer pnpm pack:cpplayer
```

## 4. 打包 / 构建

```bash
pnpm pack:cpplayer           # http 型 zip（CPPLAYER_BASE_URL 可注入 entryPoint）
pnpm build:cpplayer          # bun --compile 出 dist-bun/cpplayer-server.exe
pnpm pack:cpplayer:binary    # binary 型 zip（需先 build:cpplayer）
```

版本号来自 git tag（`scripts/version.mjs`），打进文件名与包内 manifest。

## 5. 已实现的接口

CPPlayer 标准方法 → 咪咕上游接口（实现见 `src/cpplayer/migu.ts`）：

| CPPlayer | 咪咕接口 |
|---|---|
| `cloudsearch`(type=1/10/100/1000) | `/bmw/search/{song,album,singer,music-list}/...` |
| `search/suggest` | `/bmw/search/suggest/v1.0` |
| `search/hot/detail` | `/bmw/hot-search/search-rank-list/v1.0` |
| `song/detail` | `/resource/song/by-contentids/v2.0` |
| `song/url/v1`、`song/url/v1/302`、`song/download/url/v1` | `/MIGUM3.0/strategy/pc/listen/v1.0`（`Channel: 014X031`） |
| `lyric/new` | `/MIGUM2.0/v1.0/content/resourceinfo.do` → `lrcUrl` / `trcUrl` |
| `playlist/detail` | `/resource/playlist/v2.0` + `/MIGUM3.0/resource/playlist/song/v2.0` |
| `playlist/track/all` | 同上（`limit/offset` → `pageNo/pageSize`） |
| `album` | `/MIGUM3.0/resource/album/v2.0` + `album/song/v2.0` |
| `artist/detail` | `/bmw/singer/index/v1.0`（简介）+ `/bmw/singer/song/v1.0`（名字/头像） |
| `artist/songs` | `/bmw/singer/song/v1.0` |
| `artist/album` | `/bmw/singer/album/v1.0` |
| `toplist` / `toplist_detail` | `/pc/bmw/rank/rank-index/v1.0`（+ `/bmw/rank/rank-info/v1.0`） |
| `recommend/resource` | `/bmw/index-show/recommend-playlist/v3.0` |
| `recommend/songs` | `/pc/resource-dataloader/recommend-song/v1.0?scene=TODAY_RECOMMEND` |
| `personal_fm` | 同上 `scene=PRIVATE_FM`（需随机 `deviceId` 请求头） |

音质映射：`standard→PQ(128k)`、`higher/exhigh→HQ(320k)`、`lossless→SQ(flac)`、
`hires/jymaster/sky→ZQ24`、`dolby→Z3D`。**未登录时咪咕只下发标清**；
请求高品质拿不到地址会自动回落 `PQ`。若连标清 url 都未下发（版权 / 风控 / 出口 IP 限制），
返回 `{"code":500,"msg":"咪咕未返回播放地址…"}`，与原内置版行为一致。

## 6. 数据口径

- **歌曲 id = 咪咕 `contentId`**（如 `600902000006889366`）。
- 曲目对象输出网易云风格：`id` / `name` / `ar[].name` / `al.name` / `al.picUrl` / `dt`(ms)。
- 咪咕 `duration` 是**秒**，`dt` 已乘 1000。
- 相对路径图片统一补全 `https://d.musicapp.migu.cn` 前缀。
- 未实现（登录体系、用户歌单/云盘、评论、MV 等）返回 `{"code":-1}`，
  UI 显示「该音源不支持此功能」。

## 7. 本地验证

```bash
pnpm dev
curl -s http://127.0.0.1:6200/cpplayer/health
curl -s -X POST http://127.0.0.1:6200/cpplayer/cloudsearch \
     -H 'Content-Type: application/json' -d '{"keywords":"周杰伦","type":"1"}'
```
