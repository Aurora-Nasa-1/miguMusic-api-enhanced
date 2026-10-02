/**
 * CPPlayer 标准接口适配层 —— 咪咕音源核心逻辑。
 *
 * 从 CPPlayer-KMP 内置 `MiguProvider.kt` 一比一移植（底本见
 * `reference/MiguProvider.kt.reference`）：直接调咪咕官方公开 HTTP 接口，
 * 并把响应重塑成 CPPlayer 期望的网易云标准形状（TrackJsonMapper 口径：
 * `id` / `name` / `ar[]` / `al{picUrl}` / `dt`）。
 *
 * 只用全局 fetch 与标准 JSON API，Node 18+ / Bun / Cloudflare Workers /
 * Deno / EdgeOne 全部可用，不引入本项目其余依赖。
 *
 * ### 支持的 CPPlayer 标准方法（POST body 为 JSON，参数全字符串）
 * cloudsearch / search/suggest / search/hot/detail / song/detail /
 * song/url/v1 / song/url/v1/302 / song/download/url/v1 / lyric/new /
 * playlist/detail / playlist/track/all / album / artist/detail /
 * artist/songs / artist/album / toplist / toplist_detail /
 * recommend/resource / recommend/songs / personal_fm
 */

// ======================== 常量（与 Kotlin 版 companion object 对应） ========================

const BASE_APP = 'https://app.c.nf.migu.cn';
const BASE_U = 'https://app.u.nf.migu.cn';
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CHANNEL = '014X031';
const RES_TYPE_PLAYLIST = '2021';
const IMG_BASE = 'https://d.musicapp.migu.cn';

/** 默认音质：咪咕未登录时只有标清可用，高品质拿不到地址时回落到这里。 */
const TONE_PQ = 'PQ';

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
const MAX_ARTIST_SONGS = 150;
const MAX_ARTIST_PAGES = 3;
const MAX_SUGGESTIONS = 10;
const MAX_HOT_SEARCHES = 20;

// ======================== JSON 取值扩展（对应 Kotlin 的私有扩展函数） ========================

type JObj = Record<string, unknown>;

function asObject(v: unknown): JObj | null {
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JObj) : null;
}

function asArray(v: unknown): unknown[] | null {
    return Array.isArray(v) ? v : null;
}

/** 取字符串字段，空串视为 null（与 Kotlin `str()` 口径一致）。 */
function str(o: unknown, key: string): string | null {
    const v = asObject(o)?.[key];
    return typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' ? String(v) : null;
}

function obj(o: unknown, key: string): JObj | null {
    return asObject(asObject(o)?.[key]);
}

function arr(o: unknown, key: string): unknown[] {
    return asArray(asObject(o)?.[key]) ?? [];
}

/** 咪咕把「图集」放在 `imgItems` / `imgs` / `albumImgs` / `singerImgs` 四种键里，取第一张。 */
function imgFromItems(o: unknown): string | null {
    if (!asObject(o)) return null;
    for (const key of ['imgItems', 'imgs', 'albumImgs', 'singerImgs']) {
        const first = asObject(arr(o, key)[0]);
        const img = first ? str(first, 'img') : null;
        if (img) return img;
    }
    return null;
}

/** 搜索响应统一是 `data.items[]`，每项包一层类型键（song/album/singer/...）。 */
function items(root: unknown): JObj[] {
    return arr(obj(root, 'data'), 'items').map(asObject).filter((v): v is JObj => v !== null);
}

/** 取 `data.items[]` 中包裹键为 [type] 的项（保留外层以便回退）。 */
function itemsOf(root: unknown, type: string): JObj[] {
    return items(root).filter((it) => it[type] != null);
}

/**
 * 咪咕栏目型接口（`singer/song`、`singer/index`、`singer/album`）统一是
 * `data.contents[].contents[]` 的两层结构，这里拍平成一维。
 */
function walkItems(root: unknown): JObj[] {
    const groups = arr(obj(root, 'data'), 'contents');
    return groups.flatMap((g) => arr(g, 'contents').map(asObject).filter((v): v is JObj => v !== null));
}

function isOk(root: unknown): boolean {
    const code = asObject(root)?.['code'];
    return code === '000000' || code === 200 || code === '200';
}

// ======================== 模型构造（对应 Kotlin 的 buildJsonObject 段） ========================

/** 咪咕歌曲对象 → CPPlayer 曲目形状（`id/name/ar[]/al{picUrl}/dt`）。 */
function songToTrack(src: JObj): JObj {
    const id = str(src, 'contentId') ?? str(src, 'songId') ?? str(src, 'id') ?? '';
    const name = str(src, 'songName') ?? str(src, 'name') ?? '';
    const durationSec = Number(str(src, 'duration') ?? '0') || 0;
    let artists = arr(src, 'singerList')
        .map(asObject)
        .filter((s): s is JObj => s !== null && str(s, 'name') != null)
        .map((s) => ({ id: Number(str(s, 'id') ?? '0') || 0, name: str(s, 'name') ?? '' }));
    if (artists.length === 0) {
        const single = str(src, 'singer') ?? str(src, 'artist') ?? '';
        if (single) {
            artists = [{ id: Number(str(src, 'singerId') ?? '0') || 0, name: single }];
        }
    }
    return {
        id,
        name,
        dt: durationSec * 1000,
        ar: artists,
        al: {
            id: Number(str(src, 'albumId') ?? '0') || 0,
            name: str(src, 'album') ?? str(src, 'albumName') ?? '',
            picUrl:
                normalizeImg(
                    str(src, 'img1') ?? str(src, 'img2') ?? str(src, 'img3') ?? imgFromItems(src) ?? str(src, 'img'),
                ) ?? '',
        },
    };
}

/** 栏目型条目（`txt/txt2/resId/img`，见于歌手歌曲、榜单、推荐）→ 曲目形状。 */
function genericToTrack(item: JObj): JObj | null {
    const id = str(item, 'resId') ?? str(item, 'contentId');
    const name = str(item, 'txt') ?? str(item, 'songName');
    if (!id || !name) return null;
    // songData 是内嵌的 JSON 字符串，里面才有专辑名/时长
    let embedded: JObj | null = null;
    const raw = str(item, 'songData');
    if (raw) {
        try {
            embedded = asObject(JSON.parse(raw));
        } catch {
            embedded = null;
        }
    }
    const durationSec =
        Number(str(embedded, 'duration') ?? str(item, 'duration') ?? '0') || 0;
    const artistName = str(item, 'txt2') ?? str(embedded, 'singer') ?? '';
    return {
        id,
        name,
        dt: durationSec * 1000,
        ar: [{ id: 0, name: artistName }],
        al: {
            id: Number(str(embedded, 'albumId') ?? '0') || 0,
            name: str(item, 'txt3') ?? str(embedded, 'album') ?? '',
            picUrl: normalizeImg(str(item, 'img') ?? str(embedded, 'img1')) ?? '',
        },
    };
}

function playlistSummary(id: string, name: string, cover: string | null, trackCount: number, creatorName: string | null): JObj {
    return {
        id: Number(id) || 0,
        name,
        picUrl: cover ?? '',
        coverImgUrl: cover ?? '',
        trackCount,
        creator: { nickname: creatorName ?? '' },
    };
}

function albumSummary(
    id: string,
    name: string,
    cover: string | null,
    artistName: string | null,
    artistId: string | null = null,
    trackCount: number | null = null,
): JObj {
    const artist = { id: Number(artistId) || 0, name: artistName ?? '' };
    return {
        id: Number(id) || 0,
        name,
        picUrl: cover ?? '',
        size: trackCount ?? 0,
        artist,
        artists: [artist],
    };
}

function rankingSummary(id: string, name: string, cover: string | null, trackCount: number): JObj {
    return {
        id: Number(id) || 0,
        name,
        coverImgUrl: cover ?? '',
        picUrl: cover ?? '',
        trackCount,
        updateFrequency: '',
    };
}

/** 榜单组里既有纯榜单条目，也有「榜单 + 前几首」的复合条目，两种都要展开。 */
function rankItemToRanking(rank: JObj): JObj[] {
    const rankId = str(rank, 'rankId');
    if (!rankId) return [];
    const tracks = arr(rank, 'contents');
    return [rankingSummary(rankId, str(rank, 'rankName') ?? '', normalizeImg(str(rank, 'imageUrl')), tracks.length)];
}

function buildSearchResult(
    songs: JObj[] = [],
    albums: JObj[] = [],
    artists: JObj[] = [],
    playlists: JObj[] = [],
): JObj {
    return {
        code: 200,
        result: {
            songs,
            albums,
            artists,
            playlists,
            songCount: songs.length,
        },
    };
}

function unsupported(method: string): JObj {
    return { code: -1, msg: `咪咕音源不支持该接口: ${method}` };
}

function errorJson(message: string): JObj {
    return { code: 500, msg: message };
}

// ======================== 网络（对应 Kotlin 的 getJson / getText） ========================

async function getJson(url: string, extraHeaders: Record<string, string> = {}): Promise<JObj | null> {
    try {
        const resp = await fetch(url, {
            headers: {
                'User-Agent': USER_AGENT,
                Channel: CHANNEL,
                Referer: 'https://music.migu.cn/',
                ...extraHeaders,
            },
        });
        const text = await resp.text();
        return asObject(JSON.parse(text));
    } catch {
        return null;
    }
}

async function getText(url: string): Promise<string | null> {
    try {
        const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
        return await resp.text();
    } catch {
        return null;
    }
}

// ======================== 音质 ========================

function toneFlagOf(level: string | undefined): string {
    switch ((level ?? '').toLowerCase()) {
        case 'lq':
        case 'standard':
            return 'PQ';
        case 'higher':
        case 'exhigh':
            return 'HQ';
        case 'lossless':
            return 'SQ';
        case 'hires':
        case 'jymaster':
        case 'sky':
            return 'ZQ24';
        case 'dolby':
            return 'Z3D';
        default:
            return TONE_PQ;
    }
}

function brOf(format: string): number {
    switch (format) {
        case 'LQ':
            return 64_000;
        case 'PQ':
            return 128_000;
        case 'HQ':
            return 320_000;
        case 'SQ':
            return 999_000;
        case 'ZQ24':
            return 2_304_000;
        case 'ZQ32':
            return 4_608_000;
        default:
            return 128_000;
    }
}

function formatExt(format: string): string {
    switch (format) {
        case 'SQ':
        case 'ZQ24':
            return 'flac';
        case 'ZQ32':
        case 'Z3D':
        case '3D60':
            return 'wav';
        case 'I3D':
            return 'm4a';
        default:
            return 'mp3';
    }
}

// ======================== 编码 / 杂项 ========================

const HEX = '0123456789ABCDEF';

/** 咪咕的图片字段有时只给 `/data/oss/...` 相对路径，补上 CDN 域名。 */
function normalizeImg(raw: string | null | undefined): string | null {
    const value = (raw ?? '').trim();
    if (!value) return null;
    return value.startsWith('http') ? value : IMG_BASE + value;
}

/** 与 Kotlin 版自写的 urlEncode 一致（RFC 3986 unreserved 之外的字节全部转义）。 */
function urlEncode(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let out = '';
    for (const byte of bytes) {
        const ch = String.fromCharCode(byte);
        if (/[a-zA-Z0-9\-_.~]/.test(ch)) {
            out += ch;
        } else {
            out += '%' + HEX[byte >> 4] + HEX[byte & 0x0f];
        }
    }
    return out;
}

const enc = urlEncode;

/** 咪咕 `recommend-song` 要求 deviceId；格式就是随机 UUID 字符串。 */
function randomDeviceId(): string {
    const chars = '0123456789abcdef';
    let out = '';
    for (let i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
        else if (i === 14) out += '4';
        else out += chars[Math.floor(Math.random() * 16)];
    }
    return out;
}

// ======================== 方法实现（与 Kotlin 版逐函数对应） ========================

async function songSearch(keywords: string): Promise<JObj> {
    const root = await getJson(`${BASE_APP}/bmw/search/song/v1.0?pageNo=1&text=${enc(keywords)}`);
    const songs = itemsOf(root, 'song')
        .map((it) => obj(it, 'song'))
        .filter((s): s is JObj => s !== null)
        .map(songToTrack);
    return buildSearchResult(songs);
}

async function albumSearch(keywords: string): Promise<JObj> {
    const root = await getJson(`${BASE_APP}/bmw/search/album/v1.0?pageNo=1&text=${enc(keywords)}&typeOrder=0`);
    const albums = items(root)
        .map((item) => obj(item, 'album') ?? obj(item, 'dalbum'))
        .filter((src): src is JObj => src !== null)
        .flatMap((src) => {
            // 搜索结果混排普通专辑（`album`，带 albumId）与数字专辑（`dalbum`，只有 contentId）
            const id = str(src, 'albumId') ?? str(src, 'contentId');
            const name = str(src, 'title');
            if (!id || !name) return [];
            const tcRaw = str(src, 'totalCount');
            const trackCount = tcRaw != null && Number.isFinite(Number(tcRaw)) ? Math.trunc(Number(tcRaw)) : null;
            return [
                albumSummary(
                    id,
                    name,
                    normalizeImg(imgFromItems(src) ?? str(src, 'img')),
                    str(src, 'singer'),
                    str(src, 'singerId'),
                    trackCount,
                ),
            ];
        });
    return buildSearchResult([], albums);
}

async function artistSearch(keywords: string): Promise<JObj> {
    const root = await getJson(`${BASE_APP}/bmw/search/singer/v2.0?pageNo=1&text=${enc(keywords)}`);
    const artists = itemsOf(root, 'singer')
        .map((item) => obj(item, 'singer'))
        .filter((s): s is JObj => s !== null)
        .flatMap((src) => {
            const id = str(src, 'singerId') ?? str(src, 'id');
            if (!id) return [];
            return [
                {
                    // 解析侧按 img1v1Url → picUrl → avatarUrl 取头像
                    id: Number(id) || 0,
                    name: str(src, 'singer') ?? str(src, 'name') ?? '',
                    picUrl: normalizeImg(imgFromItems(src) ?? str(src, 'img')) ?? '',
                    albumSize: Number(str(src, 'albumNum') ?? '0') || 0,
                    musicSize: Number(str(src, 'songNum') ?? '0') || 0,
                },
            ];
        });
    return buildSearchResult([], [], artists);
}

async function playlistSearch(keywords: string): Promise<JObj> {
    const root = await getJson(`${BASE_APP}/bmw/search/music-list/v1.0?pageNo=1&text=${enc(keywords)}&typeOrder=0`);
    const playlists = itemsOf(root, 'musicList')
        .map((item) => obj(item, 'musicList'))
        .filter((s): s is JObj => s !== null)
        .flatMap((src) => {
            const id = str(src, 'musicListId');
            if (!id) return [];
            return [
                playlistSummary(
                    id,
                    str(src, 'title') ?? '',
                    normalizeImg(obj(src, 'imgItem') ? str(obj(src, 'imgItem'), 'img') : str(src, 'originalImgUrl')),
                    Number(str(src, 'musicNum') ?? '0') || 0,
                    str(src, 'ownerName'),
                ),
            ];
        });
    return buildSearchResult([], [], [], playlists);
}

async function search(params: Record<string, string>): Promise<JObj> {
    const keywords = (params['keywords'] ?? '').trim();
    if (!keywords) return buildSearchResult();
    const type = Number(params['type'] ?? '') || 1; // SEARCH_TYPE_SONG = 1
    switch (type) {
        case 10: // SEARCH_TYPE_ALBUM
            return albumSearch(keywords);
        case 100: // SEARCH_TYPE_ARTIST
            return artistSearch(keywords);
        case 1000: // SEARCH_TYPE_PLAYLIST
            return playlistSearch(keywords);
        default:
            return songSearch(keywords);
    }
}

async function searchSuggest(params: Record<string, string>): Promise<JObj> {
    const keywords = (params['keywords'] ?? '').trim();
    if (!keywords) return { code: 200, result: {} };
    const root = await getJson(`${BASE_APP}/bmw/search/suggest/v1.0?text=${enc(keywords)}`);
    const words = items(root)
        .map((item) => {
            const text = obj(item, 'text');
            return (text ? str(text, 'text') : null) ?? str(item, 'keyword') ?? str(item, 'word') ?? str(item, 'name');
        })
        .map((w) => (w ?? '').trim())
        .filter((w) => w.length > 0)
        .filter((w, i, a) => a.indexOf(w) === i)
        .slice(0, MAX_SUGGESTIONS);
    return {
        code: 200,
        result: {
            allMatch: words.map((keyword) => ({ keyword })),
        },
    };
}

async function hotSearch(): Promise<JObj> {
    const root = await getJson(`${BASE_U}/bmw/hot-search/search-rank-list/v1.0`);
    const tabs = arr(root, 'data');
    const words = tabs
        .flatMap((tab) => arr(tab, 'searchRankList'))
        .map(asObject)
        .filter((o): o is JObj => o !== null)
        .flatMap((o) => {
            const word = (str(o, 'word') ?? '').trim();
            if (!word) return [];
            return [{ searchWord: word, content: str(o, 'note') ?? '', score: str(o, 'note') ?? '' }];
        })
        .filter((w, i, a) => a.findIndex((x) => x.searchWord === w.searchWord) === i)
        .slice(0, MAX_HOT_SEARCHES);
    return { code: 200, data: words };
}

async function songDetail(params: Record<string, string>): Promise<JObj> {
    const ids = (params['ids'] ?? '')
        .split(/[,|]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    if (ids.length === 0) return errorJson('song/detail: ids 为空');
    // 咪咕用 `|` 分隔多个 contentId
    const root = await getJson(`${BASE_APP}/resource/song/by-contentids/v2.0?contentId=${enc(ids.join('|'))}`);
    const songs = arr(root, 'data')
        .map(asObject)
        .filter((o): o is JObj => o !== null)
        .map(songToTrack)
        .filter((t) => String(t.id ?? '').length > 0);
    return { code: 200, songs };
}

async function fetchListen(contentId: string, toneFlag: string): Promise<JObj | null> {
    const url =
        `${BASE_APP}/MIGUM3.0/strategy/pc/listen/v1.0` +
        `?contentId=${enc(contentId)}&copyrightId=&resourceType=2&toneFlag=${toneFlag}`;
    const root = await getJson(url);
    if (!isOk(root)) return null;
    const data = obj(root, 'data');
    if (!data || !str(data, 'url')) return null;
    return data;
}

async function songUrl(params: Record<string, string>): Promise<JObj> {
    const id = (params['id'] ?? '').trim();
    if (!id) return errorJson('song/url: id 为空');
    const wanted = toneFlagOf(params['level']);
    let data = await fetchListen(id, wanted);
    if ((!data || !str(data, 'url')) && wanted !== TONE_PQ) {
        // 高品质（HQ/SQ…）多数需要登录；拿不到就回落到标清，宁可低码率也不要播不了
        data = (await fetchListen(id, TONE_PQ)) ?? data;
    }
    const url = data ? str(data, 'url') : null;
    if (!url || !url.startsWith('http')) {
        return errorJson('咪咕未返回播放地址（版权受限或需登录）');
    }
    const format = (data ? str(data, 'audioFormatType') : null) ?? wanted;
    // `data.song.audioFormats[]` 里挑 formatType 匹配的那条，取它的 asize 当字节数
    const fmtEntry =
        arr(obj(data, 'song'), 'audioFormats')
            .map(asObject)
            .filter((f): f is JObj => f !== null && str(f, 'formatType') === format)[0] ?? null;
    const size = fmtEntry ? Number(str(fmtEntry, 'asize') ?? '0') || 0 : 0;
    return {
        code: 200,
        level: format,
        size,
        data: [
            {
                id,
                url,
                br: brOf(format),
                size,
                type: formatExt(format),
                level: format,
                md5: '',
            },
        ],
    };
}

async function lyric(params: Record<string, string>): Promise<JObj> {
    const id = (params['id'] ?? '').trim();
    if (!id) return errorJson('lyric/new: id 为空');
    const root = await getJson(`${BASE_U}/MIGUM2.0/v1.0/content/resourceinfo.do?resourceId=${enc(id)}&resourceType=2`);
    const res = arr(root, 'resource').map(asObject).filter((o): o is JObj => o !== null)[0] ?? null;
    const lrcUrl = res ? str(res, 'lrcUrl') : null;
    const trcUrl = res ? str(res, 'trcUrl') : null;
    const lrc = lrcUrl && lrcUrl.startsWith('http') ? (await getText(lrcUrl)) ?? '' : '';
    const trc = trcUrl && trcUrl.startsWith('http') ? (await getText(trcUrl)) ?? '' : '';
    return {
        code: 200,
        lrc: { lyric: lrc },
        tlyric: { lyric: trc },
        yrc: { lyric: '' },
        sgc: false,
        sfy: false,
        qfy: false,
    };
}

async function fetchPlaylistSongs(id: string, page: number, size: number): Promise<JObj[]> {
    const root = await getJson(
        `${BASE_APP}/MIGUM3.0/resource/playlist/song/v2.0?pageNo=${page}&pageSize=${size}&playlistId=${enc(id)}`,
    );
    return arr(obj(root, 'data'), 'songList')
        .map(asObject)
        .filter((o): o is JObj => o !== null)
        .map(songToTrack)
        .filter((t) => String(t.id ?? '').length > 0);
}

async function playlistDetail(params: Record<string, string>): Promise<JObj> {
    const id = (params['id'] ?? '').trim();
    if (!id) return errorJson('playlist/detail: id 为空');
    const data = obj(await getJson(`${BASE_APP}/resource/playlist/v2.0?playlistId=${enc(id)}`), 'data');
    const tracks = await fetchPlaylistSongs(id, 1, DEFAULT_PAGE_SIZE);
    const cover = normalizeImg((data && obj(data, 'imgItem') ? str(obj(data, 'imgItem'), 'img') : null) ?? (data ? str(data, 'originalImgUrl') : null));
    const summary = playlistSummary(
        id,
        (data ? str(data, 'title') : null) ?? '',
        cover,
        Number(str(data, 'musicNum') ?? 'NaN') || tracks.length,
        data ? str(data, 'ownerName') : null,
    );
    return {
        code: 200,
        playlist: {
            ...summary,
            description: (data ? str(data, 'summary') : null) ?? '',
            tracks,
        },
    };
}

async function playlistTracks(params: Record<string, string>): Promise<JObj> {
    const id = (params['id'] ?? '').trim();
    if (!id) return errorJson('playlist/track/all: id 为空');
    const limit = clampInt(params['limit'], 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
    const offset = Math.max(0, Number(params['offset'] ?? '0') || 0);
    const page = Math.floor(offset / limit) + 1;
    const root = await getJson(
        `${BASE_APP}/MIGUM3.0/resource/playlist/song/v2.0?pageNo=${page}&pageSize=${limit}&playlistId=${enc(id)}`,
    );
    const data = obj(root, 'data');
    const songs = arr(data, 'songList')
        .map(asObject)
        .filter((o): o is JObj => o !== null)
        .map(songToTrack)
        .filter((t) => String(t.id ?? '').length > 0);
    const total = Number(str(data, 'totalCount') ?? '0') || 0;
    const more = data ? (str(data, 'hasNext') === 'true' ? true : str(data, 'hasNext') === 'false' ? false : total > offset + songs.length) : total > offset + songs.length;
    return { code: 200, songs, more, hasMore: more };
}

async function albumDetail(params: Record<string, string>): Promise<JObj> {
    const id = (params['id'] ?? '').trim();
    if (!id) return errorJson('album: id 为空');
    const data = obj(await getJson(`${BASE_APP}/MIGUM3.0/resource/album/v2.0?albumId=${enc(id)}`), 'data');
    const songRoot = await getJson(`${BASE_APP}/MIGUM3.0/resource/album/song/v2.0?albumId=${enc(id)}&pageNo=1`);
    const songs = arr(obj(songRoot, 'data'), 'songList')
        .map(asObject)
        .filter((o): o is JObj => o !== null)
        .map(songToTrack)
        .filter((t) => String(t.id ?? '').length > 0);
    const album = {
        id: Number(id) || 0,
        name: (data ? str(data, 'title') : null) ?? '',
        picUrl: normalizeImg(data ? imgFromItems(data) : null) ?? '',
        artist: {
            id: Number(data ? str(data, 'singerId') : null) || 0,
            name: (data ? str(data, 'singer') : null) ?? '',
        },
        size: Number(str(data, 'totalCount') ?? 'NaN') || songs.length,
        company: (data ? str(data, 'publishCorp') : null) ?? '',
        description: (data ? str(data, 'summary') : null) ?? '',
        songs,
    };
    return { code: 200, album, songs };
}

async function artistDetail(params: Record<string, string>): Promise<JObj> {
    const id = (params['id'] ?? '').trim();
    if (!id) return errorJson('artist/detail: id 为空');
    // 歌手主页接口只给简介与相似歌手，名字/头像从「歌手歌曲」首条反查
    const songRoot = await getJson(`${BASE_APP}/bmw/singer/song/v1.0?pageNo=1&singerId=${enc(id)}&type=1`);
    const firstSong = walkItems(songRoot)[0] ?? null;
    const indexRoot = await getJson(`${BASE_APP}/bmw/singer/index/v1.0?singerId=${enc(id)}`);
    const summaryItem = walkItems(indexRoot).find((it) => str(it, 'view') === 'ZJ-Singer-Intro-Item');
    const summary = summaryItem ? str(summaryItem, 'txt2') : null;
    const picUrl = normalizeImg(firstSong ? str(firstSong, 'img') : null) ?? '';
    const artist = {
        id: Number(id) || 0,
        name: (firstSong ? str(firstSong, 'txt2') : null) ?? '',
        cover: picUrl,
        picUrl,
        briefDesc: summary ?? '',
        alias: [],
        albumSize: 0,
        musicSize: 0,
    };
    return { code: 200, data: { artist, user: { followeds: 0 } } };
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
    const n = Number(raw ?? 'NaN');
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

async function artistSongs(params: Record<string, string>): Promise<JObj> {
    const id = (params['id'] ?? '').trim();
    if (!id) return errorJson('artist/songs: id 为空');
    const limit = clampInt(params['limit'], 1, MAX_ARTIST_SONGS, DEFAULT_PAGE_SIZE);
    const songs: JObj[] = [];
    for (let page = 1; page <= MAX_ARTIST_PAGES; page++) {
        const root = await getJson(`${BASE_APP}/bmw/singer/song/v1.0?pageNo=${page}&singerId=${enc(id)}&type=1`);
        const itemsFlat = walkItems(root);
        const converted = itemsFlat.flatMap((item) => {
            const songItem = obj(item, 'songItem') ?? obj(item, 'song');
            const t = songItem ? songToTrack(songItem) : genericToTrack(item);
            return t ? [t] : [];
        });
        if (converted.length === 0) break;
        songs.push(...converted);
        if (songs.length >= limit) break;
    }
    const result = songs
        .filter((s, i, a) => a.findIndex((x) => x.id === s.id) === i)
        .slice(0, limit);
    return { code: 200, songs: result, more: false };
}

async function artistAlbums(params: Record<string, string>): Promise<JObj> {
    const id = (params['id'] ?? '').trim();
    if (!id) return errorJson('artist/album: id 为空');
    const limit = clampInt(params['limit'], 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
    const root = await getJson(`${BASE_APP}/bmw/singer/album/v1.0?pageNo=1&singerId=${enc(id)}`);
    const albums = walkItems(root)
        .flatMap((item) => {
            const albumId = str(item, 'resId');
            const name = str(item, 'txt');
            if (!albumId || !name) return [];
            return [
                albumSummary(
                    albumId,
                    name,
                    normalizeImg(str(item, 'img')),
                    str(item, 'txt2'),
                    id,
                ),
            ];
        })
        .slice(0, limit);
    return { code: 200, hotAlbums: albums };
}

async function toplist(): Promise<JObj> {
    const root = await getJson(`${BASE_APP}/pc/bmw/rank/rank-index/v1.0`);
    const groups = arr(obj(root, 'data'), 'contents');
    const ranking = groups.flatMap((group) =>
        arr(group, 'contents')
            .map(asObject)
            .filter((o): o is JObj => o !== null)
            .flatMap(rankItemToRanking),
    );
    return { code: 200, list: ranking };
}

/** 榜单详情：取排行榜首页的第一个榜单展开（宿主不带 id 参数，按「首个榜单」语义返回一页曲目）。 */
async function toplistDetail(): Promise<JObj> {
    const root = await getJson(`${BASE_APP}/pc/bmw/rank/rank-index/v1.0`);
    const first = arr(obj(root, 'data'), 'contents')
        .flatMap((g) => arr(g, 'contents'))
        .map(asObject)
        .filter((o): o is JObj => o !== null)
        .find((o) => str(o, 'rankId') != null);
    const rankId = first ? str(first, 'rankId') : null;
    if (!rankId) return toplist();
    const info = obj(await getJson(`${BASE_APP}/bmw/rank/rank-info/v1.0?pageNo=1&rankId=${enc(rankId)}`), 'data');
    const tracks = arr(info, 'contents')
        .map(asObject)
        .filter((o): o is JObj => o !== null)
        .flatMap(genericToTrack)
        .filter((t): t is JObj => t !== null);
    const entry = rankingSummary(
        rankId,
        (info ? str(info, 'title') : null) ?? (first ? str(first, 'rankName') : null) ?? '',
        normalizeImg((info ? str(info, 'titlePic') : null) ?? (first ? str(first, 'imageUrl') : null)),
        Number(str(info, 'totalCount') ?? 'NaN') || tracks.length,
    );
    return { code: 200, list: [{ ...entry, tracks }] };
}

async function recommendPlaylists(): Promise<JObj> {
    const root = await getJson(`${BASE_APP}/bmw/index-show/recommend-playlist/v3.0`);
    const playLists = arr(obj(root, 'data'), 'playLists')
        .map(asObject)
        .filter((o): o is JObj => o !== null && str(o, 'resType') === RES_TYPE_PLAYLIST);
    const ranking = playLists.flatMap((item) => {
        const id = str(item, 'resId');
        if (!id) return [];
        return [playlistSummary(id, str(item, 'txt') ?? '', normalizeImg(str(item, 'img')), 0, null)];
    });
    return { code: 200, recommend: ranking, result: ranking };
}

async function fetchSceneSongs(scene: string, size: number | null): Promise<JObj[]> {
    const query =
        size === null ? `scene=${scene}&algorithm=v1&action=1` : `scene=${scene}&action=1&size=${size}`;
    const root = await getJson(`${BASE_APP}/pc/resource-dataloader/recommend-song/v1.0?${query}`, {
        deviceId: randomDeviceId(),
    });
    return arr(obj(root, 'data'), 'songItemList')
        .map(asObject)
        .filter((o): o is JObj => o !== null)
        .map(songToTrack)
        .filter((t) => String(t.id ?? '').length > 0);
}

async function recommendSongs(): Promise<JObj> {
    const songs = await fetchSceneSongs('TODAY_RECOMMEND', DEFAULT_PAGE_SIZE);
    return { code: 200, data: { dailySongs: songs, songs } };
}

async function personalFm(): Promise<JObj> {
    // PRIVATE_FM 固定返回 5 条且不接受 size 参数
    const songs = await fetchSceneSongs('PRIVATE_FM', null);
    return { code: 200, data: songs };
}

// ======================== 方法分发（与 Kotlin dispatch 对应） ========================

export type CpPlayerParams = Record<string, string>;

/**
 * CPPlayer 标准方法分发入口。
 *
 * @param method CPPlayer 标准方法名（如 `cloudsearch`、`song/url/v1`）
 * @param params 全字符串参数（宿主 callApi 的 body 原样透传）
 */
export async function dispatchCpPlayerMethod(method: string, params: CpPlayerParams): Promise<unknown> {
    try {
        switch (method) {
            case 'cloudsearch':
                return await search(params);
            case 'search/suggest':
                return await searchSuggest(params);
            case 'search/hot/detail':
                return await hotSearch();
            case 'song/detail':
                return await songDetail(params);
            case 'song/url/v1':
            case 'song/url/v1/302':
            case 'song/download/url/v1':
                return await songUrl(params);
            case 'lyric/new':
                return await lyric(params);
            case 'playlist/detail':
                return await playlistDetail(params);
            case 'playlist/track/all':
                return await playlistTracks(params);
            case 'album':
                return await albumDetail(params);
            case 'artist/detail':
                return await artistDetail(params);
            case 'artist/songs':
                return await artistSongs(params);
            case 'artist/album':
                return await artistAlbums(params);
            case 'toplist':
                return await toplist();
            case 'toplist_detail':
                return await toplistDetail();
            case 'recommend/resource':
                return await recommendPlaylists();
            case 'recommend/songs':
                return await recommendSongs();
            case 'personal_fm':
                return await personalFm();
            default:
                return unsupported(method);
        }
    } catch (e) {
        return errorJson(`咪咕请求失败: ${e instanceof Error ? e.message : '未知错误'}`);
    }
}
