#!/usr/bin/env node
/**
 * 每日自动化流程（配合 Windows 计划任务使用）
 * ---------------------------------------------------------------
 *  1. 读取主关键词文件 ci.md
 *  2. 逐个关键词抓取百度"相关搜索 / 大家还在搜"（lm=7 一周内）
 *     —— 抓取失败时自动降级使用百度联想词接口(sugrec)
 *  3. 整理(去重、累积合并)写入 fuci.md
 *  4. 为 fuci.md 中每个关键词生成一篇文章 articles/<关键词>.md
 *  5. git 提交并推送到 GitHub（token 认证，仓库不存在时自动创建）
 *
 * 用法:
 *    node auto_flow.js            # 完整流程（含 git push）
 *    node auto_flow.js --no-push  # 只抓词和生成文章，不推送
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = __dirname;
const NO_PUSH = process.argv.slice(2).includes('--no-push');
const CFG = JSON.parse(fs.readFileSync(path.join(BASE, 'config.json'), 'utf8'));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const log = (...a) => console.log(`[${new Date().toLocaleString('zh-CN')}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/* 读取可选的附加文件（不存在返回空） */
function readLinesSafe(file) {
  try {
    return fs.readFileSync(path.join(BASE, file), 'utf8')
      .split(/\r?\n/).map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
  } catch (_) { return []; }
}

/* 百度页面导航/频道标签等噪声词黑名单（不是相关关键词） */
const BLOCKLIST = new Set([
  '新闻', '网页', '贴吧', '资讯', '视频', '图片', '文库', '地图', '更多', '知道',
  '音乐', '采购', '招商', '直播', '应用', '游戏', '购物', '汽车', '财经', '体育',
  '教育', '科技', '房产', '时尚', '娱乐', '国际', '军事', '文化', '旅游', '健康',
  '笔记', '经验', '电台', '沸点', '热议', '换一换', '查看更多', '收起', '展开',
  '登录', '注册', '设置', '帮助', '反馈', '举报', '投诉', '首页', '下一页', '上一页',
  '百度', '百度首页', '百度一下', '反馈问题', '下载app', '下载App', '打开APP',
  '小程序', '大家还在搜', '相关搜索', '猜你想搜', '热搜', '换一批', '返回', '搜索',
]);

/* ============ 1. 读取主关键词 ci.md ============ */
function readMainKeywords() {
  const file = path.join(BASE, CFG.ci_file);
  const kws = fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#') && !s.startsWith('>'));
  return [...new Set(kws)];
}

/* ============ 2. 百度相关词抓取 ============ */
let cookieJar = '';

function mergeCookies(res) {
  try {
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (list.length) {
      const parts = Object.fromEntries(
        cookieJar.split('; ').filter(Boolean).map((c) => [c.split('=')[0], c])
      );
      for (const c of list) {
        const kv = c.split(';')[0];
        if (kv && kv.includes('=')) parts[kv.split('=')[0]] = kv;
      }
      cookieJar = Object.values(parts).join('; ');
    }
  } catch (_) { /* 忽略 cookie 异常 */ }
}

// 预热：先访问百度首页拿 Cookie(BAIDUID 等)，提高搜索页成功率
async function warmupBaidu() {
  try {
    const res = await fetch('https://www.baidu.com/', {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    mergeCookies(res);
  } catch (e) {
    log('百度预热失败(忽略):', e.message);
  }
}

// 从搜索结果 HTML 提取"相关搜索"和"大家还在搜"
// 只取两种可靠结构，避免误抓页面导航/频道标签：
//   1) 底部"相关搜索":  <a class="rs-link_xxx"><span class="rs-text_xxx">独立相册app</span></a>
//   2) "大家还在搜"条目: <a class="...item_xxx..." data-click="..."><span>免费相册下载安装</span></a>
//      （要求带 data-click，排除左侧频道导航链接）
function extractRelated(html) {
  const out = [];
  for (const m of html.matchAll(/class="[^"]*rs-text[^"]*"[^>]*>\s*([^<]{1,40}?)\s*</g)) out.push(m[1]);
  for (const m of html.matchAll(/<a[^>]*class="[^"]*\bitem_[A-Za-z0-9_]+[^"]*"[^>]*data-click=[^>]*>([\s\S]*?)<\/a>/g)) {
    for (const t of m[1].matchAll(/<span[^>]*>\s*([^<]{1,40}?)\s*<\/span>/g)) out.push(t[1]);
  }
  return cleanKeywords(out);
}

function cleanKeywords(arr) {
  return [...new Set(arr.map((s) => s.trim()))].filter((s) => {
    if (s.length < 2 || s.length > 30) return false;
    if (/[<>{}]/.test(s) || /^[\d\s.]+$/.test(s)) return false;
    if (BLOCKLIST.has(s) || BLOCKLIST.has(s.toLowerCase())) return false; // 导航/频道噪声词
    if (!/[\u4e00-\u9fff]/.test(s) && s.length < 4) return false; // 纯英文至少4字符(如app类)
    return true;
  });
}

// 百度搜索页相关词（主方式）
async function fetchFromSearchPage(keyword) {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(keyword)}&lm=${CFG.baidu.lm}&ie=utf-8&tn=baidu`;
  const headers = {
    'User-Agent': UA,
    Referer: 'https://www.baidu.com/',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  if (cookieJar) headers.Cookie = cookieJar;
  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(CFG.baidu.timeout_ms),
  });
  mergeCookies(res);
  return extractRelated(await res.text());
}

// 百度联想词接口（备用方式，反爬较松）
async function fetchFromSugrec(keyword) {
  const url = `https://www.baidu.com/sugrec?prod=pc&wd=${encodeURIComponent(keyword)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.baidu.com/' },
    signal: AbortSignal.timeout(CFG.baidu.timeout_ms),
  });
  const data = await res.json().catch(() => ({}));
  return cleanKeywords((data.g || []).map((x) => x.q));
}

// 单个关键词：搜索页 -> 失败降级 sugrec，共重试 3 轮
async function fetchBaiduRelated(keyword) {
  for (let i = 1; i <= 3; i++) {
    try {
      const rel = await fetchFromSearchPage(keyword);
      if (rel.length) return { list: rel, from: '搜索页' };
    } catch (e) {
      log(`  [${keyword}] 搜索页第${i}次失败: ${e.message}`);
    }
    await sleep(1500 * i);
  }
  try {
    const rel = await fetchFromSugrec(keyword);
    if (rel.length) return { list: rel, from: '联想词接口' };
  } catch (e) {
    log(`  [${keyword}] 联想词接口失败: ${e.message}`);
  }
  return { list: [], from: '' };
}

/* ============ 3. 整理写入 fuci.md（累积合并去重 + 随机前后缀） ============ */
/* 前缀池：jiaci.md(年份) + jiaci2.md(修饰词)，如 "2026" + "参考" => "2026参考安装图库"
   每个关键词首次入库时随机分配一个前缀并固定，保证文章文件名稳定不重复 */
const JIACI = readLinesSafe(CFG.jiaci_file || 'jiaci.md');
const JIACI2 = readLinesSafe(CFG.jiaci2_file || 'jiaci2.md');
function randomPrefix() {
  return (JIACI.length ? pick(JIACI) : '') + (JIACI2.length ? pick(JIACI2) : '');
}
// 从 fuci.md 行解析出 {raw, prefix}，如 "2026参考安装图库" => raw="安装图库", prefix="2026参考"
function splitPrefix(line) {
  let rest = line, prefix = '';
  const y = rest.match(/^(20\d{2})/);
  if (y) { prefix += y[1]; rest = rest.slice(4); }
  const w = JIACI2.find((k) => k && rest.startsWith(k));
  if (w) { prefix += w; rest = rest.slice(w.length); }
  return { raw: rest, prefix };
}

function parseExistingFuci() {
  const file = path.join(BASE, CFG.fuci_file);
  const map = new Map(); // rawKeyword -> { prefix, src }
  if (!fs.existsSync(file)) return map;
  let cur = '其他';
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const g = line.match(/^##\s+(.+)/);
    if (g) { cur = g[1].trim(); continue; }
    const k = line.match(/^-\s+(.+?)\s*$/);
    if (!k) continue;
    const { raw, prefix } = splitPrefix(k[1]);
    if (!raw || BLOCKLIST.has(raw)) continue; // 顺带清掉历史噪声词
    map.set(raw, { prefix: prefix || randomPrefix(), src: cur });
  }
  return map;
}

function writeFuci(kwMap, mains) {
  const lines = [
    '# 相关关键词库 (fuci)',
    '',
    `> 最近更新: ${new Date().toLocaleString('zh-CN')}`,
    `> 主词来源: ${CFG.ci_file}（${mains.length} 个主词）`,
    `> 关键词总数: ${kwMap.size}`,
    '',
  ];
  const display = (raw, v) => v.prefix + raw;
  for (const m of mains) {
    const items = [...kwMap.entries()].filter(([, v]) => v.src === m).map(([k, v]) => display(k, v));
    if (!items.length) continue;
    lines.push(`## ${m}`, '', ...items.map((i) => `- ${i}`), '');
  }
  const others = [...kwMap.entries()].filter(([, v]) => !mains.includes(v.src));
  if (others.length) lines.push('## 其他', '', ...others.map(([k, v]) => `- ${display(k, v)}`), '');
  fs.writeFileSync(path.join(BASE, CFG.fuci_file), lines.join('\n'), 'utf8');
}

/* ============ 4. 关键词 -> 文章 ============ */
function sanitizeFilename(kw) {
  return kw.replace(/[\\/:*?"<>|]/g, '_');
}

/* 文章开头固定插入 guding.md 的全部内容 */
const GUDING = (() => {
  try {
    return fs.readFileSync(path.join(BASE, CFG.guding_file || 'guding.md'), 'utf8').trim();
  } catch (_) { return ''; }
})();

function buildArticle(kw, source) {
  const d = new Date();
  const date = fmtDate(d);
  const year = d.getFullYear();
  const L = [];

  if (GUDING) L.push(GUDING, '');
  L.push(`# ${kw}完全指南（${year}最新整理）`, '');
  L.push(`> 关键词：${kw} ｜ 关联主词：${source} ｜ 更新日期：${date}`, '');

  // 引言
  L.push(pick([
    `如果你正在了解或寻找${kw}相关的信息，这篇文章应该能帮到你。本文围绕${kw}整理了实用介绍、选择建议和常见问题解答，帮你少走弯路。`,
    `最近有很多人在搜索和关注${kw}。为了方便快速了解，本文把关于${kw}的常见问题、使用建议和注意事项做了系统整理。`,
    `${kw}是近期不少用户关注的热点话题。本文将从"是什么、为什么、怎么选、怎么用"几个角度，带你全面认识${kw}。`,
  ]), '');

  // 一、是什么
  L.push(`## 一、什么是${kw}？`, '');
  L.push(pick([
    `简单来说，${kw}是与"${source}"密切相关的一个具体需求方向。随着大家对${source}的关注度不断提高，${kw}作为其中一个细分场景，搜索量也在持续上升。`,
    `${kw}可以理解为"${source}"需求下的一个具体应用场景。很多人在了解${source}的过程中，会自然延伸到${kw}这个更具体的问题上。`,
    `从用户搜索行为来看，${kw}通常代表着一类明确的需求：用户希望通过它，更快、更省心地解决与${source}相关的问题。`,
  ]), '');

  // 二、为什么受关注
  L.push(`## 二、为什么越来越多人关注${kw}？`, '');
  const reasons = [
    `**需求更具体**：用户不再满足于泛泛地了解${source}，而是希望直接找到${kw}的解决方案。`,
    `**选择变多**：市面上与${kw}相关的产品和服务越来越多，对比、筛选的成本上升了。`,
    `**信息分散**：关于${kw}的资料散落在各处，系统化的整理反而成了稀缺品。`,
    `**决策成本高**：选错了${kw}相关方案，往往要花费额外的时间和精力来弥补。`,
    `**口碑传播快**：好的${kw}方案，很容易通过口碑被更多人知道。`,
  ];
  const n1 = 3 + Math.floor(Math.random() * 2);
  L.push(pick([
    `总结下来，主要有下面几个原因：`,
    `归纳起来，${kw}受到关注不外乎以下几点：`,
    `之所以${kw}的热度持续上升，主要有：`,
  ]), '');
  reasons.slice(0, n1).forEach((r) => L.push(`- ${r}`));
  L.push('');

  // 三、选择要点
  L.push(`## 三、选择${kw}的 5 个关键点`, '');
  const points = [
    `**明确自身需求**：先想清楚你要${kw}解决什么问题，是图省心、图便宜还是图效果。`,
    `**对比多个方案**：不要只看一家，多收集几份关于${kw}的方案再做决定。`,
    `**关注口碑评价**：真实用户的反馈，往往比宣传文案更有参考价值。`,
    `**评估长期成本**：除了眼前的投入，也要算一算${kw}方案后续的维护成本。`,
    `**先试用再决定**：条件允许的话，先小范围试用，验证合适后再全面采用。`,
  ];
  points.forEach((p, i) => L.push(`${i + 1}. ${p}`));
  L.push('');

  // 四、步骤
  L.push(`## 四、${kw}上手步骤`, '');
  [
    `第一步，做好功课：围绕"${kw}"把基础概念和常见方案了解一遍，建立整体印象。`,
    `第二步，列出清单：把候选的${kw}方案按需求匹配度排序，圈出前 2~3 个。`,
    `第三步，逐个验证：分别试用或深入了解，记录各自的优缺点。`,
    `第四步，做出选择：结合预算和实际体验，确定最终的${kw}方案。`,
    `第五步，持续优化：使用一段时间后复盘，必要时调整。`,
  ].forEach((s) => L.push(`- ${s}`));
  L.push('');

  // 五、FAQ
  L.push(`## 五、${kw}常见问题（FAQ）`, '');
  const faqs = [
    [`${kw}难不难上手？`, `只要按步骤来，${kw}的整体上手门槛并不高，关键是先明确自己的需求。`],
    [`新手选择${kw}最容易踩什么坑？`, `最常见的坑是只看价格不看匹配度，以及没有预留后续的调整空间。`],
    [`关于${kw}，去哪里找可靠信息？`, `建议交叉参考多个来源，并结合真实用户的评价综合判断，避免只听一面之词。`],
    [`${kw}相关的方案多久需要更新一次？`, `一般建议每隔一段时间重新评估一次，市场变化快，过去的优选未必长期有效。`],
    [`有没有省心的${kw}做法？`, `可以先从口碑好、案例多的方案入手，降低试错成本。`],
    [`预算有限怎么做${kw}？`, `优先满足核心需求，砍掉可有可无的附加项，把钱花在刀刃上。`],
  ];
  const n2 = 4 + Math.floor(Math.random() * 2);
  faqs.slice(0, n2).forEach(([q, a]) => {
    L.push(`**${q}**`, '', `${a}`, '');
  });

  // 六、总结
  L.push('## 六、总结', '');
  L.push(pick([
    `总的来说，${kw}并不复杂：先弄清需求，再对比方案，最后小步验证。希望这篇关于${kw}的整理能帮你更快做出合适的选择。本文会不定期更新，欢迎收藏备用。`,
    `关于${kw}，记住三件事——需求先行、多方对比、先试后定。如果这篇文章对你有帮助，可以分享给同样在关注${kw}的朋友。`,
    `${kw}的关键在于匹配自己的实际需求，而不是盲目跟风。有更多关于${kw}的问题，欢迎继续关注后续更新。`,
  ]), '');

  L.push('---', '', `*本文由自动化流程生成于 ${new Date().toLocaleString('zh-CN')}，关键词来源：百度相关搜索（主词：${source}）。*`);
  return L.join('\n');
}

function genArticles(kwMap) {
  const dir = path.join(BASE, CFG.articles_dir);
  fs.mkdirSync(dir, { recursive: true });
  let created = 0;
  for (const [raw, v] of kwMap) {
    const name = v.prefix + raw; // 完整关键词（含前后缀，如 2026参考安装图库）
    const file = path.join(dir, sanitizeFilename(name) + '.md');
    if (fs.existsSync(file)) continue; // 已生成的文章不覆盖
    fs.writeFileSync(file, buildArticle(name, v.src), 'utf8');
    created++;
  }
  return created;
}

/* ============ 5. git 提交并推送 GitHub ============ */
function git(args) {
  return execFileSync('git', args, { cwd: BASE, encoding: 'utf8' }).toString().trim();
}
function gitTry(args) {
  try { return git(args); } catch (e) { return null; }
}

async function githubLogin() {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${CFG.git.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'auto-flow',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GitHub 认证失败(HTTP ${res.status})，请检查 config.json 中的 git.token`);
  return (await res.json()).login;
}

async function ensureRepo(login) {
  const { repo_name, token, private: isPrivate } = CFG.git;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'auto-flow',
  };
  const res = await fetch(`https://api.github.com/repos/${login}/${repo_name}`, { headers, signal: AbortSignal.timeout(20000) });
  if (res.ok) return true;
  if (res.status === 404) {
    const create = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: repo_name,
        private: !!isPrivate,
        description: 'auto-flow 每日自动更新：相关关键词与文章',
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (create.ok) { log(`已创建新仓库: ${login}/${repo_name}`); return true; }
    if (create.status === 422) return true; // 已存在
    throw new Error(`创建仓库失败(HTTP ${create.status})`);
  }
  return true; // 403 等情况直接尝试 push
}

function gitStageAndCommit() {
  if (gitTry(['rev-parse', '--is-inside-work-tree']) === null) {
    git(['init', '-b', 'main']);
    log('已初始化 git 仓库');
  }
  git(['add', '-A']);
  let hasChange = false;
  try { git(['diff', '--cached', '--quiet']); } catch (_) { hasChange = true; }
  if (!hasChange) return false;
  git([
    '-c', `user.name=${CFG.git.author_name}`,
    '-c', `user.email=${CFG.git.author_email}`,
    'commit', '-m', `auto: ${fmtDate(new Date())} 更新相关关键词与文章`,
  ]);
  return true;
}

function gitPush(login) {
  const cleanUrl = `https://github.com/${login}/${CFG.git.repo_name}.git`;
  if (gitTry(['remote', 'get-url', 'origin']) === null) git(['remote', 'add', 'origin', cleanUrl]);
  else git(['remote', 'set-url', 'origin', cleanUrl]);
  // 凭据只出现在一次性 push 命令里，不写入 .git/config
  const authUrl = `https://x-access-token:${CFG.git.token}@github.com/${login}/${CFG.git.repo_name}.git`;
  git(['push', authUrl, 'HEAD:main']);
}

/* ============ 主流程 ============ */
(async () => {
  let failed = false;
  try {
    log('========== 自动流程开始 ==========');
    // 1. 主关键词
    const mains = readMainKeywords();
    if (!mains.length) throw new Error(`主关键词文件 ${CFG.ci_file} 为空`);
    log(`主关键词 ${mains.length} 个: ${mains.join('、')}`);

    // 2. 百度相关词
    await warmupBaidu();
    const kwMap = parseExistingFuci();
    for (const kw of mains) {
      log(`抓取百度相关词: ${kw} ...`);
      const { list, from } = await fetchBaiduRelated(kw);
      log(`  [${from}] 获得相关词 ${list.length} 个`);
      if (!list.length) failed = true;
      for (const r of list) {
        if (!kwMap.has(r)) kwMap.set(r, { prefix: randomPrefix(), src: kw }); // 新词随机分配前后缀
      }
      await sleep(800 + Math.random() * 1500); // 随机间隔，降低被封概率
    }

    // 3. 写 fuci.md
    writeFuci(kwMap, mains);
    log(`fuci.md 已更新（累计 ${kwMap.size} 个关键词）`);

    // 4. 生成文章
    const created = genArticles(kwMap);
    log(`文章生成完成：本次新增 ${created} 篇（目录 ${CFG.articles_dir}/，已存在的不覆盖）`);

    // 5. git push
    if (NO_PUSH || !CFG.git.enabled) {
      log('已跳过 git 推送');
    } else {
      const login = await githubLogin();
      log(`GitHub 认证成功，用户: ${login}`);
      await ensureRepo(login);
      if (gitStageAndCommit()) {
        gitPush(login);
        log(`已推送到 GitHub: ${login}/${CFG.git.repo_name}`);
      } else {
        log('git: 无变更需要提交');
      }
    }
  } catch (e) {
    log('流程出错:', e.message);
    failed = true;
  } finally {
    log('========== 自动流程结束 ==========');
    if (failed) process.exitCode = 1; // 便于计划任务监控失败
  }
})();
