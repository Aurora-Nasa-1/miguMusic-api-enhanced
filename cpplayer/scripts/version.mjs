/**
 * CPPlayer 音源模块版本 —— 唯一来源同样是 **git tag**。
 *
 * `manifest.json` 里的 `version` 是 tag 的落盘副本。CPPlayer 的模块管理器把它
 * 显示在「音源管理」列表里，并在 `updateUrl` 存在时用于更新检查；它如果是手填的，
 * 就会出现「导入的模块自称 1.0.0、其实对应 1.2.3」这种没法排查的错位。
 *
 * ## 为什么不写死版本号
 * 本文件用 `new URL('../manifest.json', import.meta.url)` 定位清单，
 * 因此**同一份脚本在两种布局下都能用**：
 *   - 作为 migu 仓库的子目录：`miguMusic-api-cpplayer/cpplayer/`（当前）
 *   - 独立成库后位于仓库根：`<new-repo>/`
 * 拆库时不用改任何代码，只要在新仓库根目录放 manifest.json 即可。
 *
 * ## 版本号从哪来
 * 解析优先级：
 *   1. 环境变量 `CPPLAYER_MODULE_VERSION`（CI 显式传参时用）
 *   2. HEAD 的**精确** tag（`git describe --tags --exact-match HEAD`）
 *   3. `manifest.json` 现值（本地开发态，此时只保证格式合法）
 *
 * tag 前缀接受 `v1.2.3` 与 `module-v1.2.3` 两种：
 * 合仓库共用 `v*` 时用前者；模块单独成库、想与主项目的 tag 命名空间隔离时用后者。
 *
 * CLI：
 *   node cpplayer/scripts/version.mjs                              打印 version / source / tag
 *   node cpplayer/scripts/version.mjs --check                      校验一致性（CI 用）
 *   node cpplayer/scripts/version.mjs --check --allow-untagged     HEAD 无 tag 时只校验格式
 *   node cpplayer/scripts/version.mjs --set 1.2.3                  写回 manifest.json
 *   node cpplayer/scripts/version.mjs --sync                       用解析值写回 manifest.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 相对脚本自身定位 ⇒ 子目录布局与独立仓库布局通用。 */
export const MANIFEST_URL = new URL('../manifest.json', import.meta.url);
export const MANIFEST_PATH = fileURLToPath(MANIFEST_URL);

/** 合法 tag 形态：`1.2.3` / `1.2.3-beta.1`（不带 `+build`，那是构建元数据）。 */
const VERSION_RE = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
/** 允许的 tag 前缀：主项目 `v`，模块独立成库时用 `module-v` 隔离命名空间。 */
const TAG_PREFIXES = ['module-v', 'v'];

export function git(args) {
    try {
        return execFileSync('git', args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return null;
    }
}

/** tag 名 → 版本号；不认识的形态返回 null。 */
export function versionFromTag(tag) {
    if (!tag) return null;
    for (const prefix of TAG_PREFIXES) {
        if (tag.startsWith(prefix)) {
            const core = tag.slice(prefix.length);
            return VERSION_RE.test(core) ? core : null;
        }
    }
    return null;
}

export function isValidVersion(version) {
    return typeof version === 'string' && VERSION_RE.test(version);
}

export function readManifest() {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

export function readManifestVersion() {
    return readManifest().version;
}

export function readExactTag() {
    return git(['describe', '--tags', '--exact-match', 'HEAD']);
}

/**
 * @returns {{version: string, source: 'env'|'tag'|'manifest', tag: string|null}}
 */
export function resolveVersion() {
    const fromEnv = (process.env.CPPLAYER_MODULE_VERSION || '').trim().replace(/^v/, '');
    if (fromEnv) {
        if (!isValidVersion(fromEnv)) throw new Error(`CPPLAYER_MODULE_VERSION 不是合法版本: ${fromEnv}`);
        return { version: fromEnv, source: 'env', tag: null };
    }

    const tag = readExactTag();
    const fromTag = versionFromTag(tag);
    if (fromTag) return { version: fromTag, source: 'tag', tag };

    const fromManifest = readManifestVersion();
    if (fromManifest) return { version: fromManifest, source: 'manifest', tag: null };
    throw new Error('无法确定版本：HEAD 没有精确 tag，manifest.json.version 也是空的');
}

/**
 * 写回 manifest.json 的 version（整份 JSON 重写：manifest 是本模块自己生成的、
 * 结构简单，不存在用户手工编辑要保留的注释，因此不存在 diff 噪音问题）。
 *
 * @returns {boolean} 是否真的改了
 */
export function writeManifestVersion(version) {
    if (!isValidVersion(version)) throw new Error(`不是合法版本: ${version}`);
    const manifest = readManifest();
    if (manifest.version === version) return false;
    manifest.version = version;
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 4)}\n`, 'utf8');
    return true;
}

// ------------------------------- CLI -------------------------------

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
    const args = process.argv.slice(2);
    const allowUntagged = args.includes('--allow-untagged');

    try {
        const setIndex = args.indexOf('--set');
        if (setIndex >= 0) {
            const target = (args[setIndex + 1] || '').replace(/^v/, '');
            if (!target) throw new Error('--set 后面要跟版本号，例如 --set 1.2.3');
            const changed = writeManifestVersion(target);
            console.log(changed ? `manifest.version -> ${target}` : `manifest.version 已是 ${target}`);
            process.exit(0);
        }

        const resolved = resolveVersion();

        if (args.includes('--sync')) {
            const changed = writeManifestVersion(resolved.version);
            console.log(
                changed
                    ? `manifest.version -> ${resolved.version}（来源 ${resolved.source}）`
                    : `manifest.version 已是 ${resolved.version}，无需改动`,
            );
            process.exit(0);
        }

        if (args.includes('--check')) {
            const manifestVersion = readManifestVersion();
            if (!isValidVersion(manifestVersion)) {
                console.error(`manifest.json.version 不是合法 SemVer: ${manifestVersion}`);
                process.exit(1);
            }
            // env 与 tag 同为「外部给定的权威值」，都必须与落盘副本一致；
            // 只有回落 manifest 自身时（本地开发态）没有可比对象。
            if (resolved.source !== 'manifest' && resolved.version !== manifestVersion) {
                console.error(
                    `模块版本漂移：${resolved.tag ?? `CPPLAYER_MODULE_VERSION=${resolved.version}`} ⇒ ${resolved.version}，` +
                    `但 manifest.json.version = ${manifestVersion}`,
                );
                console.error('修法：node scripts/release.mjs <version>（会同时写 manifest.json 并打 tag）');
                process.exit(1);
            }
            if (resolved.source === 'manifest' && !allowUntagged) {
                console.error(
                    'HEAD 没有精确 tag，也没有传 CPPLAYER_MODULE_VERSION，无法校验一致性；' +
                    '若这是预期，加 --allow-untagged',
                );
                process.exit(1);
            }
            console.log(
                `模块版本校验通过：${resolved.version}` +
                `（来源 ${resolved.source}${resolved.tag ? ` / ${resolved.tag}` : ''}）`,
            );
            process.exit(0);
        }

        console.log(`version=${resolved.version} source=${resolved.source} tag=${resolved.tag ?? '-'}`);
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
}
