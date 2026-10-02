/**
 * 版本 —— 全仓唯一来源：**git tag**。
 *
 * `package.json` 里的 `version` 是 tag 的「落盘副本」，不是独立来源。
 * 理由：构建产物会把 package.json 内联进去（`/migu/status` 直接读它），
 * 而 CI 是按 tag 构建并发布的。两处一旦漂移，发出去的包会「报着一个版本、
 * 挂在另一个 tag 下」，且没有任何编译期提示。
 *
 * 规则：
 *   1. 版本号由 tag 决定（`v1.2.3`，可带 `-beta.1` 预发布后缀）；
 *   2. `release.mjs` 在打 tag **之前**把版本写回 package.json，并让两者落在
 *      同一个 commit 上 ⇒ 「HEAD 带 tag」时两处必然一致；
 *   3. CI 用 `--check` 强制校验这条不变量（tag 触发时不一致直接 fail）。
 *
 * 解析优先级：`MIGU_VERSION` 环境变量 → HEAD 的精确 tag → package.json 现值。
 *
 * CLI：
 *   node scripts/version.mjs                                打印 version / source / tag
 *   node scripts/version.mjs --check                        校验一致性（CI 用）
 *   node scripts/version.mjs --check --allow-untagged       HEAD 无 tag 时只校验格式
 *   node scripts/version.mjs --set 1.2.3                    写回 package.json
 *   node scripts/version.mjs --sync                         用解析出的版本写回 package.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH = join(ROOT, 'package.json');

/** tag 形态：`v1.2.3` / `v1.2.3-beta.1`。不带 `+build`，那是构建元数据不是版本。 */
const TAG_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export function git(args) {
    try {
        return execFileSync('git', args, {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return null;
    }
}

/** tag 名 → 版本号（`v` 可选）；形态不认返回 null。 */
export function versionFromTag(tag) {
    if (!tag) return null;
    const m = TAG_RE.exec(tag.trim());
    return m ? m[1] : null;
}

export function isValidVersion(version) {
    return typeof version === 'string' && TAG_RE.test(`v${version}`);
}

export function readPackageVersion() {
    return JSON.parse(readFileSync(PKG_PATH, 'utf8')).version;
}

export function readExactTag() {
    return git(['describe', '--tags', '--exact-match', 'HEAD']);
}

/**
 * @returns {{version: string, source: 'env'|'tag'|'package', tag: string|null}}
 */
export function resolveVersion() {
    const fromEnv = (process.env.MIGU_VERSION || '').trim().replace(/^v/, '');
    if (fromEnv) {
        if (!isValidVersion(fromEnv)) throw new Error(`MIGU_VERSION 不是合法版本: ${fromEnv}`);
        return { version: fromEnv, source: 'env', tag: null };
    }

    const tag = readExactTag();
    const fromTag = versionFromTag(tag);
    if (fromTag) return { version: fromTag, source: 'tag', tag };

    const fromPkg = readPackageVersion();
    if (fromPkg) return { version: fromPkg, source: 'package', tag: null };
    throw new Error('无法确定版本：HEAD 没有精确 tag，package.json.version 也是空的');
}

/**
 * 写回 package.json。
 * 只替换**顶层** `"version"` 那一行（两空格缩进），不重新序列化整个文件 ——
 * 重写会打乱键顺序、制造巨大 diff，还会顺手改掉用户正在编辑的其它字段。
 *
 * @returns {boolean} 是否真的改了
 */
export function writePackageVersion(version) {
    if (!isValidVersion(version)) throw new Error(`不是合法版本: ${version}`);
    const raw = readFileSync(PKG_PATH, 'utf8');
    if (readPackageVersion() === version) return false;

    const line = /^ {2}"version": "[^"]*",?$/m;
    if (!line.test(raw)) throw new Error('package.json 里找不到顶层 "version" 字段');
    const next = raw.replace(line, `  "version": "${version}",`);
    if (next === raw) return false;
    writeFileSync(PKG_PATH, next, 'utf8');
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
            const target = args[setIndex + 1];
            if (!target) throw new Error('--set 后面要跟版本号，例如 --set 1.2.3');
            const changed = writePackageVersion(target.replace(/^v/, ''));
            console.log(changed ? `package.json.version -> ${target}` : `package.json.version 已是 ${target}`);
            process.exit(0);
        }

        const resolved = resolveVersion();

        if (args.includes('--sync')) {
            const changed = writePackageVersion(resolved.version);
            console.log(
                changed
                    ? `package.json.version -> ${resolved.version}（来源 ${resolved.source}）`
                    : `package.json.version 已是 ${resolved.version}，无需改动`,
            );
            process.exit(0);
        }

        if (args.includes('--check')) {
            const pkgVersion = readPackageVersion();
            if (!isValidVersion(pkgVersion)) {
                console.error(`package.json.version 不是合法 SemVer: ${pkgVersion}`);
                process.exit(1);
            }
            // env 与 tag 同为「外部给定的权威值」，都必须与落盘副本一致；
            // 只有回落 package.json 自身时（本地开发态）没有可比对象。
            if (resolved.source !== 'package' && resolved.version !== pkgVersion) {
                console.error(
                    `版本漂移：${resolved.tag ?? `MIGU_VERSION=${resolved.version}`} ⇒ ${resolved.version}，` +
                    `但 package.json.version = ${pkgVersion}`,
                );
                console.error('修法：node scripts/release.mjs <version>（会同时写 package.json 并打 tag）');
                process.exit(1);
            }
            if (resolved.source === 'package' && !allowUntagged) {
                console.error(
                    'HEAD 没有精确 tag，也没有传 MIGU_VERSION，无法校验一致性；' +
                    '若这是预期（例如 tag 在别处打好），加 --allow-untagged',
                );
                process.exit(1);
            }
            console.log(
                `版本校验通过：${resolved.version}` +
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
