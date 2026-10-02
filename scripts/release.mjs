/**
 * 发版 —— 一次命令完成「版本写回 + 提交 + 打 tag + 推送」。
 *
 *   node scripts/release.mjs 1.2.3            # 正常发版
 *   node scripts/release.mjs 1.2.3 --dry-run  # 只做检查，不改文件不推
 *   node scripts/release.mjs 1.2.3 --no-push  # 只在本地提交 + 打 tag
 *
 * 为什么不让 CI 去猜版本：tag 是发布动作的**结果**，不是输入。
 * 由本地先写 package.json、再用同一个 commit 打 tag，两者天然一致；
 * CI 只负责校验（`version.mjs --check`）和构建产物。
 *
 * 前置条件（缺一条就中止，不做「半发布」）：
 *   1. 工作区干净（没有已跟踪文件的改动）；
 *   2. 本地与远端都不存在同名 tag；
 *   3. 版本号合法，且比当前版本高（除非 --allow-downgrade）。
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isValidVersion, readPackageVersion, writePackageVersion } from './version.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REMOTE = process.env.MIGU_REMOTE || 'origin';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const noPush = argv.includes('--no-push');
const allowDowngrade = argv.includes('--allow-downgrade');
const target = (argv.find((a) => !a.startsWith('--')) || '').replace(/^v/, '');

function git(args, { allowFail = false } = {}) {
    try {
        return execFileSync('git', args, {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
    } catch (e) {
        if (allowFail) return null;
        const detail = (e.stderr || e.stdout || e.message || '').toString().trim();
        throw new Error(`git ${args.join(' ')} 失败：${detail}`);
    }
}

function fail(message) {
    console.error(`✗ ${message}`);
    process.exit(1);
}

function step(message) {
    console.log(`→ ${message}`);
}

// ------------------------------- 校验 -------------------------------

if (!target) {
    fail('用法：node scripts/release.mjs <version> [--dry-run] [--no-push] [--allow-downgrade]');
}
if (!isValidVersion(target)) {
    fail(`版本号不合法：${target}（期望形如 1.2.3 或 1.2.3-beta.1）`);
}

const tag = `v${target}`;
const current = readPackageVersion();

if (!allowDowngrade && compare(target, current) <= 0) {
    fail(`版本必须高于当前：${current} → ${target}（确实要回退就加 --allow-downgrade）`);
}

// 工作区必须干净：否则 tag 会指向一个「和仓库内容不一致」的 commit，
// 之后谁按 tag 构建出来的产物都不是你眼前这份代码。
const dirty = git(['status', '--porcelain', '--untracked-files=no']);
if (dirty) {
    fail('工作区有未提交的改动，先提交或 git stash：\n' + dirty);
}

if (git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { allowFail: true })) {
    fail(`本地已存在 tag ${tag}`);
}
const remoteTags = git(['ls-remote', '--tags', REMOTE, `refs/tags/${tag}`], { allowFail: true });
if (remoteTags === null) {
    console.warn(`! 无法访问 ${REMOTE}，跳过远端 tag 查重（继续）`);
} else if (remoteTags) {
    fail(`${REMOTE} 上已存在 tag ${tag}`);
}

console.log(`当前版本 ${current} → 目标版本 ${target}（tag ${tag}）`);

// ------------------------------- 执行 -------------------------------

if (dryRun) {
    console.log('\n[dry-run] 检查通过，未做任何改动。将执行：');
    console.log(`  1. package.json.version := ${target}`);
    console.log(`  2. git commit -m "chore(release): ${tag}"`);
    console.log(`  3. git tag -a ${tag} -m "Release ${tag}"`);
    if (!noPush) console.log(`  4. git push ${REMOTE} HEAD && git push ${REMOTE} ${tag}`);
    process.exit(0);
}

if (writePackageVersion(target)) {
    step(`package.json.version -> ${target}`);
} else {
    step(`package.json.version 已是 ${target}`);
}

git(['add', 'package.json']);
git(['commit', '-m', `chore(release): ${tag}`]);
step(`已提交 chore(release): ${tag}`);

git(['tag', '-a', tag, '-m', `Release ${tag}`]);
step(`已打 tag ${tag}`);

if (noPush) {
    console.log(`\n完成（未推送）。手动推送：git push ${REMOTE} HEAD && git push ${REMOTE} ${tag}`);
    process.exit(0);
}

git(['push', REMOTE, 'HEAD']);
git(['push', REMOTE, tag]);
step(`已推送 ${REMOTE} HEAD 与 ${tag}`);

console.log(
    `\n✓ ${tag} 已发布。CI 会跑版本一致性校验并构建 Release 产物。\n` +
    `  查看进度：gh run watch（需 gh CLI）\n` +
    `  发布错了要撤：git push ${REMOTE} :${tag} && git push ${REMOTE} HEAD~1`,
);

/** 比较两个 SemVer 核心（忽略预发布后缀的精细比较，只比主版本号）。 */
function compare(a, b) {
    const pa = a.split('-')[0].split('.').map(Number);
    const pb = b.split('-')[0].split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
}
