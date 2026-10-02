/**
 * 把咪咕音源打包成 CPPlayer 可导入的模块 zip（两种模式）。
 *
 *   node cpplayer/pack.mjs                       → http 型：cpplayer/migu-cpplayer-http-v{ver}.zip
 *   node cpplayer/pack.mjs --mode binary         → binary 型：cpplayer/migu-cpplayer-binary-win-v{ver}.zip
 *   node cpplayer/pack.mjs --out dist/x.zip      → 指定输出路径
 *   CPPLAYER_BASE_URL=https://host/cpplayer node cpplayer/pack.mjs
 *                                                → 把部署地址写进 http 型 manifest 的 entryPoint
 *
 * **http 型**（Android / 任何平台）：zip 里只有 manifest.json，`type: "http"`，
 * entryPoint 指向一个已部署的本服务实例（Workers / Node / Deno 均可，路由挂在
 * `/cpplayer` 前缀）。宿主对 `POST {entryPoint}/{method}` 发标准请求。
 *
 * **binary 型**（桌面端）：zip 里带 manifest.json + `lib/x86_64/cpplayer-server.exe`
 * （`pnpm build:cpplayer` 用 bun --compile 产出的单文件服务，宿主以
 * `entry --port N` 拉起，对 `POST http://127.0.0.1:{port}/api/{method}` 发请求）。
 * 注意 bun 没有 Android 目标，binary 型只覆盖桌面。
 *
 * 版本号来自 git tag（见 scripts/version.mjs），同时打进**文件名**与包内 manifest：
 * 用户导入后「音源管理」里显示的版本，与 release 的 tag 必然一致。
 *
 * 为什么自己写 zip：包里最多只有 manifest + 一个二进制，为了它装 archiver / jszip
 * 不值得。这里用 STORE（不压缩）方式写最小合法 zip，Java 的 ZipInputStream 与
 * python zipfile 都能读。
 */
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_URL, writeManifestVersion, resolveVersion } from './scripts/version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = fileURLToPath(MANIFEST_URL);

if (!existsSync(manifestPath)) {
    console.error('缺少 manifest.json');
    process.exit(1);
}

// ---- 模式解析 ----

const modeIndex = process.argv.indexOf('--mode');
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : 'http';
if (mode !== 'http' && mode !== 'binary') {
    console.error(`未知模式: ${mode}（可选 http / binary）`);
    process.exit(1);
}

const { version, source, tag } = resolveVersion();
if (writeManifestVersion(version)) {
    console.log(`manifest.version 已同步到 ${version}（来源 ${source}${tag ? ` / ${tag}` : ''}）`);
}

// ---- 组装 zip 条目：[{ zipPath, data }] ----

const baseManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entries = [];

if (mode === 'http') {
    const manifest = { ...baseManifest, type: 'http' };
    // CPPLAYER_BASE_URL：把实际部署地址写进 entryPoint（宿主 POST {entryPoint}/{method}）
    const baseUrl = (process.env.CPPLAYER_BASE_URL || '').replace(/\/+$/, '');
    if (baseUrl) manifest.entryPoint = baseUrl;
    entries.push({ zipPath: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 4)) });
    if (!baseUrl) {
        console.log('提示：未设置 CPPLAYER_BASE_URL，entryPoint 保留 manifest 现值 ' + manifest.entryPoint);
    }
} else {
    const exeSource = resolve(here, '..', 'dist-bun', 'cpplayer-server.exe');
    if (!existsSync(exeSource)) {
        console.error('缺少二进制: ' + exeSource);
        console.error('先执行: pnpm build:cpplayer');
        process.exit(1);
    }
    // binary 型 manifest：宿主按 lib/<平台ABI>/<entryPoint> 解析（桌面 ABI 是 x86_64）
    const manifest = { ...baseManifest, type: 'binary', entryPoint: 'cpplayer-server' };
    delete manifest.supportedAbis; // 交由宿主按自身 ABI 顺序探测 lib/ 目录
    entries.push({ zipPath: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 4)) });
    entries.push({ zipPath: 'lib/x86_64/cpplayer-server.exe', data: readFileSync(exeSource) });
}

// ---- 输出路径 ----

const outIndex = process.argv.indexOf('--out');
const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : null;
const defaultName =
    mode === 'http'
        ? `migu-cpplayer-http-v${version}.zip`
        : `migu-cpplayer-binary-win-v${version}.zip`;
const output = explicitOut ? resolve(explicitOut) : join(here, defaultName);
if (explicitOut) mkdirSync(dirname(output), { recursive: true });

// ---- 最小合法 zip 写入（STORE） ----

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) {
        c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
    }
    return (c ^ -1) >>> 0;
}

const chunks = [];
const central = [];
let offset = 0;

for (const entry of entries) {
    const name = Buffer.from(entry.zipPath.replace(/\\/g, '/'), 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const now = new Date();
    const dosTime = (((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() / 2) & 0x1f)) & 0xffff;
    const dosDate = ((((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0xf) << 5) | (now.getDate() & 0x1f)) & 0xffff;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    chunks.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(Buffer.concat([cd, name]));

    offset += local.length + name.length + data.length;
}

const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(central.length, 8);
end.writeUInt16LE(central.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

writeFileSync(output, Buffer.concat([...chunks, centralBuf, end]));
console.log(`已生成 ${basename(output)}（${mode} 型，版本 ${version}，来源 ${source}${tag ? ` / ${tag}` : ''}）`);
