# Playwright会话与单次检索入口

2.9.0按需使用Playwright JavaScript库控制可见Google Chrome。“准备答题”启动或复用Chrome，缓存技能资料并打开默认五站，方便用户提前登录；不执行预检或代表查询。默认无截图、无逐题文件归档。复用执行函数，结构变化或未实现路径才按需读 [browser-api.md](browser-api.md)。未提前准备时，计算、题内推导、适用已有证据和本地题库查询不启动浏览器；纯题库查询使用 [question-bank.md](question-bank.md) 的独立模块，无需创建session。

本页是可选helper接口；充分原始证据按 [retrieval.md](retrieval.md) 直接支持答复，无需转换格式或补齐helper步骤。

## 持久会话

用户说“准备答题”，或题目实际需要浏览器交互时，发现并读取可用持久 `node_repl` 工具说明，在其中保留同一个 `session`。使用 `createRequire` 加载CommonJS helper，技能路径改为实际安装位置，输出目录用绝对路径。初始化与调用方法放在一次工具调用里；后续使用现成对象，避免重复读取引导代码和全部目录。

```javascript
var {createRequire} = await import('node:module');
// <技能目录> 换成实际安装位置下的 ai-literacy-search 目录绝对路径
var browserPath = '<技能目录>/scripts/browser.cjs';
var skill = createRequire(browserPath)(browserPath);
var literacySessionId = globalThis.session?.sessionId || 'ailiteracy-' + (await import('node:crypto')).randomUUID();
globalThis.session = globalThis.session || new skill.SearchSession({
  sessionId: literacySessionId,
  outputDir: '<归档目录>/' + literacySessionId,
  browser: 'chrome'
});
var session = globalThis.session;
// 用户说“准备答题”时只执行下面这行，返回简短摘要：
await session.prepare();
// 普通题确实需要浏览器时改用 await session.start()；无需求时不启动。
```

`prepare()`启动或复用可见Chrome，将来源索引、全部索引内网站流程、已核验规则卡与证据及本地题库缓存到程序内存，再打开准备名单。默认名单来自 [sources.json](sources.json) 的 `profile.preparation_source_ids`，本版为 `['cnki','wanfang','vip','duxiu','chaoxing-huiya']`（知网、万方、维普、读秀、超星汇雅）。数量从索引读取，不遍历个人目录，也不将全部正文打印给模型。名单优先级为本次 `sourceIds`、构造选项 `prepareSourceIds`、来源目录默认名单：

```javascript
await session.prepare(); // 默认五站。
await session.prepare({sourceIds: ['cnki', 'wanfang']}); // 只准备本次指定来源。
await session.prepare({sourceIds: []}); // 不打开来源网站，仅完成浏览器和资料准备。
// new skill.SearchSession({...options, prepareSourceIds: ['vip']}) 可覆盖默认名单。
```

开站最多5个并发，不做 `preflight()` 或代表查询。摘要保留 `status`、版本、浏览器连接、资料加载数量、`failures`、`reused_live_session`，包含 `bank_total/bank_eligible/bank_review_required` 题库计数、`sites_total/sites_opened/sites_reused/sites_failed` 及 `sites`；每个站点条目含 `source_id/name/requested_url/url/status`，站点 `status` 为 `opened|reused|failed`。`preflight_ran` 仍为 `false`。`ready`/`partial`反映准备完成程度，`blocked`表示浏览器受阻，`reload_required`表示代码需刷新；页面已打开或已复用均不代表已登录、具备全文权限或查询已验证。

重复或并发 `prepare()`复用同一对象及初始化任务，只补缺少的准备页，不重新导航已有准备页或登录页，不替换当前题目。常驻准备页独立于 `maxPages` 管理的任务页面，登录、验证码及其弹窗保留，不作为任务页名额清理对象。`isBrowserConnected()`检查真实连接；`start()`在已连接时直接复用，关闭后恢复同一独立profile，不关闭已有非空页面。`codeStatus()`返回 `status: 'current'|'reload_required'`、实际已加载及安装版本与原因；版本不符时 `start()`抛出 `code: 'RELOAD_REQUIRED'`，保留现有对象和页面，明确告诉用户需刷新运行时，不自动杀daemon或Chrome。

缓存复用前检查相关文件变化，发生变化才重新读取、验证；规则证据失败停用该卡，其余资料继续可用。每题只通过 `recipe()`、`findRecipes()`、`ruleCard()`及题库查询模块读取相关信息，不重新执行全部准备。准备后的缓存是程序数据，不等于模型已阅读全部文件或网站已验证，遵循[技能渐进加载机制](https://learn.chatgpt.com/docs/build-skills)。

现有本机持久daemon也可使用安装器提供的 `~/.ailiteracy-runtime/repl/snippets/prepare.js`（准备）或 `bootstrap.js`（按需启动）。它们用于已配置的daemon上下文，不代替持久Node工具；安装器只同步片段，不安装新的daemon。已准备后直接向同一Node上下文发送本题代码，不逐题执行片段。旧daemon仍加载旧模块时片段会明确要求刷新，不冒充已升级。

依赖由安装器配置在 `~/.ailiteracy-runtime`，helper自行解析；默认 `channel: 'chrome'` 和独立持久profile，不读取日常Chrome配置、不混用Edge授权。运行时、Chrome或持久Node工具缺失时报告缺项，不改回CLI。升级后加载新版helper；恢复原会话时用原 `sessionId` / `outputDir`，保留profile及已归档证据，未归档的内存证据不跨Node重置恢复。

`archive`、`screenshots` 默认均为 `false`：证据留在session内存，不为每题写JSON/Markdown/PNG。`archive: true` 可保存文本及答案；需要视觉归档再显式设置 `screenshots: true`，该选项要求 `archive: true`。视觉判断也可只读取相关页面/图像，不必启用整题归档。浏览器持久profile仍保留登录状态。

`preflight()` 是用户要求时才用的可选工具，与仅开站和缓存的 `prepare()` 分开。`preflightSourceIds` 默认 `[]`，可用 `preflight({sourceIds: [...]})` 检查本次指定来源，不要求固定8库。例如需要时传 `['cnki','wanfang','vip','duxiu','chaoxing-huiya','nstl','cssci','cscd']`；ID须与 [sources.json](sources.json) 一致。空列表不导航，旧报告可复用而不阻塞答题。最多5个网站并行，同站串行；任务页 `maxPages` 可设1至5，常驻准备页不占该名额。访问成功不表示查询能力或全文权限，`search_status: 'untested'` 不宣称已能检索。

## 绑定当前题

需要结果页归属绑定或helper归档时，提供本题完整文字和当前选项；无预检门槛，`runSearch(question, ...)` 会自动绑定，原生transition可按需先调用：

```javascript
var question = {
  id: 'question-001',
  question: '用户的完整题干',
  type: 'single', // multiple / judge / unknown
  options: {A: '当前A项文字', B: '当前B项文字'}
};
await session.beginQuestion(question);
```

未完成题以相同完整题目恢复原尝试；题干或选项改变用新题号。已保存题明确重新核验时再次 `beginQuestion(question)`。本题、选项和尝试指纹用于隔离旧列表及延迟弹窗；已保存的适用原始证据可通过下述接口正式关联新题。

## 先复用已保存证据

检索前先阅读本对话已有证据。需要定位helper记录时调用 `session.findEvidence({text, url, limit: 10})`；`text`、`url` 可省略，只读当前session内存及已有归档，不打开页面。结果含 `source` 和原题号，不含旧答案字母；不能把第一个匹配当作已证明本题。

核对对象、字段、条件、版本和适用时点后，将选定记录记作 `priorEvidence`，关联当前已绑定的完整题目：

```javascript
var reused = session.reuseEvidence(question, {
  source: priorEvidence.source,
  freshness: 'versioned', // stable / versioned
  scope: '说明该原始记录的对象、字段和版本如何覆盖当前题目'
});
answer.sources.push(reused.source);
```

稳定事实用 `stable`，固定对象/版本的记录和全文用 `versioned`。接口检查原始内存材料或已有文件及hash，保留原取得时间；语义适用性仍由答题者核对。`live` 不允许跨题复用，当前计数、排名、状态按所问时点取证；本题已有足够实时证据直接答复，不再次提交同一查询。题内推导使用本题输入，不复用另一题数值。

所有选项按当前文字重新判断并映射字母，证据足够直接答复；仅缺失、变化、过时、冲突或明确要求重查时继续检索。Node重置后用原 `sessionId` / `outputDir` 恢复已有归档，不创建新标识。只读保存记录、卡片或本地复算时，可用 `new SearchSession({sessionId: 原标识, outputDir: 原目录})`，不启动浏览器；需要页面交互才 `await session.start()`。默认内存记录随Node重置消失，不能声称已恢复未归档内容；本对话已有原始工具材料仍可直接引用。

## 优先一次调用执行已实现流程

按来源和任务查找 `session.findRecipes({sourceId, taskKind})`，只加载相关 `session.recipe(recipeId)`。流程的 `execution` 声明可执行步骤及参数；没有可用实现或当前定位失效时返回 `needs_observation`，不能当作搜索成功。

```javascript
var retrieved = await session.runSearch(question, {
  recipeId: 'npc-laws:record-lookup',
  parameters: {query: '从当前题目原文提取的法规名称'},
  parameterQuotes: {query: '题干中包含该法规名称的原文摘录'},
  extract: {limit: 5, maxChars: 6000},
  capture: true // 默认仅登记本题短摘录到内存，不截图或文件归档。
});
// 向模型返回本题所需短数据，不打印Page对象或整站导航。
({status: retrieved.status, outcome: retrieved.outcome,
  data: retrieved.data, sources: retrieved.sources});
```

以上值为写法示意，实际 `parameters.query` 必须是本题原文中的名称；每个提供参数均须有来自题干、包含该值的 `parameterQuotes`。仅允许当前流程 `execution` 声明的键。专业检索式按该流程已核验语法生成，检索实体须来自本题原文；例如维普 `T=实体` 的摘录须包含完整实体，不能把模板运算符当题干原文要求，也不能带入样题实体或多加限制。`expected` 默认query且必须来自题干；专业式含字段前缀/运算符时，显式传题干中的完整实体作为 `expected`，并核对实际回显。

本题要求日期、资源类型、排序或分页，而当前 `execution` 没有对应步骤且检索式不能完整表达时，使用原生API补齐条件；不能为了调用函数省略限制。即使 `runSearch()` 返回ready，也按 `data.conditions` 和实际界面核对完整口径再判断。

函数在一次调用中完成开入口、检查控件与模式、清残留、填参数、提交、绑定结果页、等待结果/空态及读取必要内容；`capture: false` 可只返回读取结果。同站仍串行，页名额与验证页保护不变。输出包括原生 `page` / `container`、当前 `observation` / `binding`、`status` / `outcome`，以及 `data: {text, truncated, links, conditions}`、`sources` 和 `artifact`。默认artifact标为内存存储，不含文件路径。

`execution.resetEntry` 由开页统一处理，避免重复导航；重置前检查当前页授权，登录、验证码或权限障碍时返回 `blocked` 并保留原页。已实现流程使用 `detail: 'status'`：一次读取完整可见body、heading和控件，普通文字heading不取ARIA树；复杂可访问名称或读取失败回退 `full`。手工 `observe()` 默认仍为 `full`；需要页面结构时再请求完整观察，`status` 缓存不能代替它。

- `ready` + `results`：当前查询结果已确认，可核验字段；列表不能代替题目要求的详情、全文或完整名单。
- `ready` + `empty`：出现明确正常空态且当前条件一致；不单凭未见记录证明不存在。
- `blocked`：登录、验证码或权限等障碍，保留原可见页面，用户验证后按原断点恢复。
- `needs_observation`：流程未实现或当前结构/定位/模式不满足；读取返回观察与本题缺口，再按 [browser-api.md](browser-api.md) 原生API继续，不重做已完成步骤。

`outcome: 'failed'` 不等于零结果。截断、加载中、语法错误或超时不能作为否定事实证据。`capture: true` 返回当前摘录sources，可直接引用或放入可选答案记录，无需重复观察、截图。需要详情或全文时只补对应步骤，保留查询条件、排序、分页与记录标识。

维普统计、法库记录与标准全文的可执行状态以对应流程的 `execution` 为准；入口可达与代表查询验证是不同状态。未验证的知网/万方等路径不宣称具备完整执行函数，按实际页面继续。

## 本地计算与规则卡

题内能推出结论时直接计算/推导，不要求session。可选的 `session.calculate(question, {operation, inputs, inputQuotes})` 生成本题复算证明，不接受任意表达式；默认仅内存，需要归档才启用 `archive`。输入摘录来自题干，含对应数值，不能从选项反推或猜数据。

| operation | inputs及inputQuotes键 |
| --- | --- |
| `retrieval-metrics` | `relevantTotal`、`retrieved`、`relevantRetrieved` |
| `ratio-percent` | `part`、`whole` |

计数/比例须满足范围约束且分母非零。返回 `{source, proof, artifact}`；`proof.results` 为实际结果，`proof.steps` 为代入过程。归档模式才有证明文件路径。先按结果核对当前选项，可直接答复或将 `source` 放入可选答案记录。

```javascript
// 示例摘录必须按当前题目替换，不能沿用这些数字。
var calculated = session.calculate(question, {
  operation: 'retrieval-metrics',
  inputs: {relevantTotal: 160, retrieved: 80, relevantRetrieved: 40},
  inputQuotes: {relevantTotal: '共有相关文献160篇', retrieved: '检出80篇', relevantRetrieved: '其中相关40篇'}
});
answer.sources.push(calculated.source);
```

用 `session.ruleCard(ruleId)` 按ID读取范围、排除条件、claims、权威出处和核验日期，无需整份加载 [rules.json](rules.json)。当前卡片：

| ruleId | 通用考点 |
| --- | --- |
| `retrieval-metrics` | 查全/查准率及比例公式 |
| `boolean-operators` | AND/OR/NOT集合语义 |
| `isbn-basics` | ISBN对象、版本与产品形式 |
| `issn-basics` | ISSN对象、格式和质量边界 |
| `doi-basics` | DOI对象、持久标识与解析 |
| `inverted-index` | 倒排索引、词典与倒排列表 |

确认适用即可按卡片出处答复，需要helper来源关联时再调用：

```javascript
var used = session.useRule(question, {
  ruleId: 'boolean-operators', claims: ['and', 'or'],
  application: '本题要求比较通用交集与并集，逐项按集合关系判断。'
});
answer.sources.push(used.source);
```

只选实际存在的claims，使用卡片所记真实核验日期；准备时检查的是本地证据完整性，不声称刚访问网站。卡片不能证明动态数量、作者机构、完整人数、平台当前功能或卡片范围外的厂商语法。缺少适用卡时先检查已有适用网页证据，再补官方说明，不能把记忆称为已核验。

## 可选答案记录

```javascript
answer.confidence = {score: 95, basis: '按本题实际证据说明完整性与缺口'}; // 分数仅示例
var saved = await session.saveAnswer(question, answer);
// saved.answer供读取；默认jsonPath、markdownPath为null，启用archive才写文件。
```

答案结构见 [answer.schema.json](answer.schema.json)。网站sources用实际捕获或 `reuseEvidence()` 的返回结果，计算/规则sources用本地接口返回值；helper检查本题指纹、文件和选项映射，缺证据时降级并封顶置信度。不能因函数完成或控件校验通过就声称语义已核验。答复格式只按 [SKILL.md的默认答复](../SKILL.md#默认答复) 执行。

`saveAnswer()` 及关联校验仅用于helper记录，不是答复门槛。默认内存来源可核验并保存为内存答案；旧文件来源仍检查实际材料。充分的原始工具证据不必迁移格式；文件归档失败不触发重新检索，不伪造快照或helper通过记录。

连续题及最后答复后保留session和浏览器，不自动调用 `session.close()`；只有用户明确要求关闭时才执行 `await session.close()`。浏览器关闭后可 `await session.start()` 恢复同一profile并保留已有非空页；Node重置后用原标识与目录恢复已归档证据，未归档内存不冒充已恢复。登录、网络重试、目录外来源、原生transition与取证接口见 [browser-api.md](browser-api.md)。
