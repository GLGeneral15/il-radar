# Chrome 自动化接口

本文件是可选接口参考。**充分证据可直接答复，不必经过这些接口。** 只有需要站点交互、结果页归属绑定或归档时才使用。

运行时通过 Playwright 控制**可见的 Google Chrome**，使用独立持久 profile，不读取日常 Chrome 配置。登录与验证码由使用者在原窗口完成。

## 什么时候不需要浏览器

以下情况**不启动浏览器**，直接用本地能力：

- 题内数据可推导（计算题）
- 已有适用的稳定规则卡
- 本对话已有充分原始证据
- 只查本地题库（见 [question-bank.md](question-bank.md)，无需创建 session）

## 会话

### 建立

```javascript
var {createRequire} = await import('node:module');
var browserPath = '<技能目录>/scripts/browser.cjs';
var skill = createRequire(browserPath)(browserPath);

globalThis.session = globalThis.session || new skill.SearchSession({
  sessionId: 'ailiteracy-' + (await import('node:crypto')).randomUUID().slice(0, 8),
  outputDir: '<归档目录>/<sessionId>',   // 绝对路径
  browser: 'chrome'                        // 只支持 chrome
});
var session = globalThis.session;
```

### `start()` 与 `prepare()`

```javascript
await session.start();                        // 启动或复用浏览器，不打开来源站
await session.prepare();                      // 启动 + 缓存资料 + 打开默认站点
await session.prepare({sourceIds: ['cnki']}); // 只打开指定来源
await session.prepare({sourceIds: []});       // 只准备浏览器与缓存，不开站
```

`prepare()` 会缓存来源索引、索引内全部站点流程、已核验规则卡与证据、以及本地题库，然后打开准备名单。默认名单来自 [sources.json](sources.json) 的 `profile.preparation_source_ids`，当前为知网、万方、维普、读秀、超星汇雅。名单优先级：本次 `sourceIds` → 构造选项 `prepareSourceIds` → 来源目录默认值。

**摘要字段**：`status`、版本、浏览器连接、资料加载数量、`failures`、`reused_live_session`，题库计数 `bank_total` / `bank_eligible` / `bank_review_required`，站点计数 `sites_total` / `sites_opened` / `sites_reused` / `sites_failed` 与逐站 `sites[]`（含 `source_id` / `name` / `requested_url` / `url` / `status`）。

| `status` | 含义 |
|---|---|
| `ready` | 全部准备完成 |
| `partial` | 部分站点失败（超时、验证码、需登录属常见情况，页面通常已打开并停在登录页） |
| `blocked` | 浏览器未能连接 |
| `reload_required` | 已加载代码与安装版本不符 |

**页面已打开或已复用，都不代表已登录、有全文权限或查询已验证。**

### 状态查询

```javascript
session.isBrowserConnected();  // 真实连接状态
session.codeStatus();          // {status: 'current' | 'reload_required', ...}
```

版本不符时 `start()` 抛 `code: 'RELOAD_REQUIRED'`，**不自动杀进程**；明确告知需要刷新运行时，Chrome 与登录态由持久 profile 保留。

### 其他会话级方法

```javascript
await session.close();   // 关闭浏览器（仅用户明确要求时）
session.trackPage(page);
session.taskPages();
session.preserveVerificationPage(page);   // 保留登录/验证码页，不参与名额清理
session.serial(key, fn);                  // 同站串行
```

**页名额**：任务页默认最多 5 个（`maxPages` 可设 1–5），开站最多 5 个并发，同站串行。常驻准备页独立于任务页名额，登录页与验证码页受保护。

## 绑定当前题

需要结果页归属绑定或归档时，提供本题完整文字与当前选项：

```javascript
var question = {
  id: 'q-001',
  question: '用户的完整题干',
  type: 'single',                                  // multiple / judge / unknown
  options: {A: '当前A项文字', B: '当前B项文字'}
};
await session.beginQuestion(question);
```

未完成的题以相同完整题目恢复原尝试；题干或选项改变时使用新题号。题目、选项与尝试指纹用于隔离旧列表和延迟弹窗。

```javascript
session.finishQuestion(question);
session.saveAnswer(question, proposed);
```

## 复用已有证据

检索前先读本对话已有证据，避免重复查询：

```javascript
var found = session.findEvidence({text: '关键词', url: 'https://...', limit: 10});
// 只读当前 session 内存与已有归档，不打开页面；结果含 source 与原题号，不含旧答案字母
```

核对对象、字段、条件、版本和时点后关联当前题：

```javascript
var reused = session.reuseEvidence(question, {
  source: found[0].source,
  freshness: 'versioned',   // stable = 稳定事实；versioned = 固定对象/版本的记录或全文
  scope: '说明该原始记录的对象、字段和版本如何覆盖当前题目'
});
```

`live` 类数据**不允许跨题复用**：当前计数、排名、状态按所问时点取证。题内推导使用本题输入，不复用另一题数值。

Node 重置后可用原 `sessionId` / `outputDir` 恢复归档，不创建新标识。**内存记录会随重置消失**，不能声称已恢复未归档内容。

## 执行已实现的站点流程

```javascript
var recipes = session.findRecipes({sourceId: 'npc-laws', taskKind: 'record-lookup'});
var recipe = session.recipe('npc-laws:record-lookup');
```

流程的 `execution` 声明可执行步骤与参数。**前置条件**（三者缺一即返回 `needs_observation`）：

1. `recipe.status === 'query_verified'`
2. `recipe.execution.version === 1`
3. 流程有已验证的 `entry_url`

执行器支持的步骤动作只有 `fill` / `select` / `check` / `click`，提交动作为 `click` 或 `press`。

```javascript
var retrieved = await session.runSearch(question, {
  recipeId: 'npc-laws:record-lookup',
  parameters: {query: '从题干原文提取的名称'},
  parameterQuotes: {query: '题干中包含该名称的原文摘录'},
  extract: {limit: 5, maxChars: 6000},
  capture: true
});
```

**参数约束**：`parameters` 的值必须出现在**本题题干**中，且每个参数都要有来自题干的 `parameterQuotes`。只允许该流程 `execution` 声明的键。`expected` 默认取 `query`，也须来自题干。

`runSearch()` 在一次调用里完成开入口、检查控件与模式、清残留、填参数、提交、绑定结果页、等待结果或空态、读取必要内容。

### 返回状态

| `status` + `outcome` | 含义与后续动作 |
|---|---|
| `ready` + `results` | 当前查询结果已确认，可核验字段。列表**不能**代替题目要求的详情、全文或完整名单 |
| `ready` + `empty` | 出现明确正常空态且条件一致。不单凭未见记录证明"不存在" |
| `blocked` | 登录、验证码或权限障碍。保留原页面，用户验证后按断点恢复 |
| `needs_observation` | 流程未实现或当前结构不满足。读取返回的观察结果，按原生 API 继续，**不重做已完成步骤** |

**`outcome: 'failed'` 不等于零结果。** 截断、加载中、语法错误、超时都不能作为否定事实的证据。

返回数据含 `data: {text, truncated, links, conditions}`、`sources`、`artifact`，以及原生 `page` / `container` / `observation`。**即使返回 `ready`，也要按 `data.conditions` 与实际界面核对完整口径**（日期、类型、排序、分页）。

题目要求日期、资源类型、排序或分页，而 `execution` 没有对应步骤时，用原生 API 补齐——**不能为了调用函数而省略题目限制**。

## 原生 API

`runSearch()` 不覆盖或结构变化时使用。

```javascript
var page = await session.page(sourceId);       // 按需开页或复用
await session.observe(page, {name, compact, focus: [], detail: 'full'});
await session.inspect(source, page, options);
await session.currentObservation(page, options);
await session.observationRevision(page);
await session.documentState(page);
```

`observe()` 默认返回完整观察；`detail: 'status'` 只取可见正文、标题与控件，适合只需确认状态时。

### 页面与角色

```javascript
session.bindRole(page, role);
session.rolePage(role);
session.clearPageRole(page);
session.forgetPage(page);
session.releasePage(page);
session.acquirePage();
session.locate(page, descriptor);   // 定位控件
session.resolveTarget(page, ...);
```

### 状态迁移

新标签页、原页更新、复用目标页与 iframe 需要与当前查询或记录标识绑定：

```javascript
await session.transition(sourceId, {questionId, fromPage, toRole: 'results', ...});
await session.resumeTransition(...);
session.finishTransition(...);
session.matchesTransition(...);
```

**不要按"最后一个标签页"猜测目标**；新页面必须与本题的记录标识或条件回显一致。旧题的延迟弹窗不作当前证据。

### 证据捕获

```javascript
await session.captureEvidence(page, {evidence, ...options});
await session.captureEvidenceBatch(page, {...});
session.rememberEvidence(record, payload);
session.evidencePayload(record);
session.validateWebEvidence(...);
session.validateLocalEvidence(...);
```

`captureEvidence` 默认只登记本题短摘录到内存，不截图、不落盘。截断的文本不能证明"没有/不包括"。

### 记录检索

```javascript
await session.recordSearch(sourceId, {questionId, page, query, filters, outcome, ...});
```

用返回的 `outcome` 登记，不要自行推断成功或失败。

### 目录外来源

目录外的一手官方来源在当前页读取并核实身份后即可支持答复。需要 helper 管理该页时登记：

```javascript
await session.addSource({id, name, url: page.url(), domains}, {page});
```

**不登记未打开的入口。**

## 本地计算与规则卡

题内能推出结论时直接推导，**不要求 session**。需要复算证明时：

```javascript
var calculated = session.calculate(question, {
  operation: 'retrieval-metrics',
  inputs: {relevantTotal: 160, retrieved: 80, relevantRetrieved: 40},
  inputQuotes: {
    relevantTotal: '共有相关文献160篇',
    retrieved: '检出80篇',
    relevantRetrieved: '其中相关40篇'
  }
});
```

| `operation` | `inputs` 与 `inputQuotes` 的键 |
|---|---|
| `retrieval-metrics` | `relevantTotal`、`retrieved`、`relevantRetrieved` |
| `ratio-percent` | `part`、`whole` |

输入摘录必须来自题干并包含对应数值。**计数与比例须满足范围约束且分母非零**，不接受任意表达式。返回 `{source, proof, artifact}`；`proof.results` 是实际结果，`proof.steps` 是代入过程。

规则卡按 ID 读取，无需整份加载 [rules.json](rules.json)：

```javascript
session.ruleCard(ruleId);
session.useRule(question, {ruleId, claims, application});
session.preloadRules();
```

| `ruleId` | 覆盖范围 | 不能证明什么 |
|---|---|---|
| `retrieval-metrics` | 查全率/查准率及相关比例的公式 | 实际数据库的数量 |
| `boolean-operators` | 通用布尔检索模型的集合与逻辑语义 | 某库的实际语法、优先级与默认匹配 |
| `doi-basics` | DOI 的标识、持久性与解析定义 | 由 DOI 字符串猜测具体文献事实 |
| `inverted-index` | 倒排索引、词典与倒排列表的基本定义 | 具体引擎的实现与性能 |
| `isbn-basics` | ISBN 的识别粒度、版本与格式区别 | 具体图书的编目记录 |
| `issn-basics` | ISSN 的识别对象、编码形式与质量边界 | 具体刊物或文章 |

## 归档选项

默认 `archive: false`、`screenshots: false`：证据留在 session 内存，不为每题生成文件。

```javascript
new skill.SearchSession({..., archive: true});                  // 保存文本与答案
new skill.SearchSession({..., archive: true, screenshots: true}); // 再启用视觉归档
```

`screenshots: true` 要求 `archive: true`。视觉判断也可只读取相关页面或图像，不必启用整题归档。**浏览器持久 profile 始终保留登录状态**，与归档选项无关。

## 排障

| 现象 | 处理 |
|---|---|
| 页面可达但查询无结果 | 页面可达**不等于**查询已验证。检查条件回显、控件唯一性与空态标志 |
| `code: 'RELOAD_REQUIRED'` | 重启守护进程加载新代码；Chrome 与登录态由持久 profile 保留 |
| 登录或验证码挡住 | 保留原页面，请用户在可见窗口完成后按断点恢复。**不索取密码、不绕过验证** |
| 普通网络故障 | 最多重试两次。正常零结果不是故障 |
| 定位失败 | 重新观察页面，修复本会话流程后继续；不猜测选择器 |
