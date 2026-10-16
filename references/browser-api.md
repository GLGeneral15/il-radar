# Playwright原生回退与扩展API

2.8.3需要网站交互时可用 [browser.md](browser.md) 中的 `session.runSearch()`；“准备答题”使用其中的 `session.prepare()`，缓存资料并打开默认五站，不执行预检或代表查询，不需要加载本页。本页仅在流程未实现、页面结构变化或需要新增来源、详情及全文路径时读取。保留同一session和本题绑定，不重建已完成步骤。默认不截图、不逐题文件归档；原始工具结果足够就直接答复。

## 目录外官方来源

题目指定数据库时优先该库；其他题先官方发布机构或原始数据。目录外的一手官方来源，可在已有原生 `Page` 中打开官方URL并读取所需内容，核实机构身份后即可引用。只有需要helper管理和复用该Page时才登记，避免为来源登记重复开页：

```javascript
// page 是本会话已有的可复用原生 Page；不要另启浏览器。
await page.goto('已核实的实际官方URL', {waitUntil: 'domcontentloaded'});
var officialObservation = await session.observe(page, {compact: true});
// 阅读 officialObservation，确认当前内容属于所需官方机构，且非错误/验证页。
await session.addSource({
  id: 'official-source-id',
  name: '当前已观察页面的实际官方机构或数据库名称',
  url: page.url(),
  domains: [new URL(page.url()).hostname]
}, {page});
// 登记绑定当前页；session.page('official-source-id') 复用它，不再次导航。
```

第二参数 `{page}` 必须是本会话持有、当前已观察的Page，`url` 必须与其当前URL完全一致，`domains` 只允许该实际URL的精确hostname；不能扩大为父域或公共后缀，不同主机须分别观察后注册。未观察的待打开入口、其他会话页面、登录/验证码/错误页不能注册。注册复用当前Page并清理它的旧来源绑定。登记只扩充本会话来源，不自动加入启动名单，也不免除证据身份校验。`additional-sources.json` 保存来源及观察关联，以原 `sessionId` / `outputDir` 重建时恢复；不写回分发目录或加入启动名单。

## 按需开页与观察

`session.page(sourceId)` 返回原生Page，默认 `role: 'search'`。`role: 'results'` / `'detail'` 只返回已绑定本题的真实结果/详情页，未绑定或属于旧题时拒绝，不为该角色另开官网首页。

```javascript
var opened = await session.page(sourceId, {
  recipeId, withObservation: true, compact: true, focus: ['本题实体']
});
var page = opened.page;
var observed = opened.observation;
// 读取真实url/title/controls/text后，针对缺失步骤继续。
```

`withObservation`复用开页已有观察。`compact`与`focus`也用于 `session.observe(page, {...})`，输出短正文/aria、真实控件、`truncated` 与 `full_text_length`，默认材料仅在内存。相关字段完整即可据此判断；截断内容不能证明不存在，需完整范围时才追加读取。

`observe()`、`currentObservation()` 和 `page(..., {withObservation: true})` 支持 `detail: 'full'|'status'`，默认 `full`。`status` 在同一次页面读取中取得完整可见body、heading和控件，普通文字heading不生成ARIA树；复杂可访问名称或读取失败自动回退 `full`。`compact` 仍只控制返回长度。请求 `full` 时不会复用只有 `status` 的缓存，需结构定位时保留默认完整观察。

`entryUrl`只接受本来源域名内、当前会话真实URL/链接或自检快照已观察到的深链；未知或跨站入口拒绝。`recipeId`必须与来源一致，受阻流程不把临时验证URL当入口。目录外来源先按上节核实再登记。

搜索页的 `resetEntry: true` 将入口重置与开页合并，避免重复导航；导航前检查当前页授权。当前登录、验证码、密码框或HTTP 401/403页面留在原页，验证后再从断点继续，不跳过残留条件清理和模式检查。

## 原生Playwright回退与新增流程

从刚读取的页面确定搜索框、检索字段、筛选器和按钮的真实可访问名称，优先用 `getByRole` / `getByLabel`，必要时使用实际观察到的其他属性。遇到重名控件，在已观察区域内缩小定位；不要盲用 `.first()`、猜 CSS、猜接口或编造参数。

```javascript
// 以下名称仅说明 API 写法，必须替换为刚观察到的真实名称。
await page.getByRole('textbox', {name: '实际搜索框名称', exact: true}).fill('检索词');
await page.getByRole('button', {name: '实际搜索按钮名称', exact: true}).click();
// 按已观察到的结果标志等待，再读取；不凭固定延时认定加载成功。
await session.observe(page, {name: 'question-001-results', compact: true, focus: ['检索词']});
```

已有证据不适用或有缺口时才执行页面操作。读过真实控件后，将填词、点击、等待结果及短观察放在同一次 Node 工具调用里串行执行，减少对话与工具往返。题目指定系统优先；静态功能题的已保存官方证据可按 [browser.md](browser.md) 核对后复用，无需重新打开页面。只记有入口而没有对应证据时，沿用深链打开并读取；产品/版本变化或问当前动态字段时更新证据。一次阅读同页相关段落可核验多个选项；证据充足即停止，存在缺口或冲突时才查其他权威页。

知网、万方等只有组合字段的记录/统计任务才进入已观察的专业或高级检索；DOI、完整题名、编号优先直达或普通精准定位，功能和匹配规则先读官方帮助。期刊评价报告、热点分析和RSS导航使用其专用入口。需要专业模式时确认面板和本库语法，再一次填写题目条件；URL不变不能证明模式已切换。万方可用实际字段按钮生成表达式。重名控件在可见区域内定位，不通过 `force` 跳过检查。

向模型只返回本题相关正文、必要控件和详情链接，避免打印全站导航或重复读取。`compact` 通过 `truncated` 标明正文、aria或控件是否裁剪，需要完整所问范围时再读取。默认artifact在内存，可选 `archive: true` 才写文本；不为文件保存重新观察同页。

操作导航、筛选或切换标签页后重新观察，等待真实结果/空结果/错误状态，不用固定延时推定加载成功。已确认打开方式后使用下述 `transition` 管理新页和结果归属；不要无证据地假定链接会弹窗。开站最多5个并发，`maxPages` 管理的任务页面最多5个，同一网站检索串行。常驻准备页独立于任务名额，登录、验证码及其弹窗保留。

当搜索明确完成时记录：

```javascript
await session.recordSearch(sourceId, {
  page,
  query: '实际检索式',
  filters: {mode: 'professional', field: '实际字段', date: '实际日期限制'},
  outcome: 'results' // 有结果；明确零结果用 empty；搜索失败用 failed。
});
```

只有正常结果或明确空结果才能证明搜索功能工作。加载中、验证码、超时和错误页不能写成 `empty`。零结果可按题意调整分词或字段再查；不能因一次零结果断言答案不存在。页面故障重新检查相关入口。

## 流程与结果页面绑定

`session.recipe(recipeId)` 按ID返回该站参数化流程；`session.findRecipes({sourceId, taskKind})` 读取指定网站相关任务，不将全部站点配置装入上下文。`session.locator(page, descriptor)` 将已确认描述转成原生Locator。描述支持 `{role, name, exact}`、`{label}`、`{text}` 或实际观察过的 `{css}`，可用 `scope` 限定区域、`frame` 定位已观察的iframe；仍须核对可见性和唯一性，重名控件不能盲取 `.first()`。

`session.transition(sourceId, options)` 在触发动作前注册监听和预留标签页名额，返回 `{page, container, observation, binding, status, outcome}`。`container` 是当前页唯一可见的原生结果/详情Locator，`status` 为 `ready` 或 `blocked`；受阻时容器为空。`outcome` 区分 `results`、`empty` 和 `failed`；正常零结果仍为 `status: 'ready'`，验证码或授权障碍不能归为空结果。由来源域名、打开来源、当前查询/记录匹配和页面新鲜度共同确认；域名匹配不能单独证明页面属于本题。

必要参数为 `questionId`、当前会话 `fromPage`、`toRole: 'results'|'detail'` 和执行实际Playwright动作的 `trigger`。`recipeId` 可提供已确认的 `transitions[toRole]`，也可显式传 `mode`、`container`、`ready`、`match`；没有实测配置时先观察再补齐，不猜默认值。结果空态由实际观察过的 `recipe.transitions.results.empty` 或 `options.empty` 确认，不能仅按未出现记录判断。`query`、`filters` 记录实际查询，`expected` 或 `recordId` 提供要核对的查询回显或记录标识，`timeoutMs` 可覆盖等待期限。

`observationDetail` 默认 `full`，已实现的 `runSearch()` 传 `status`。同一轮相同的非函数 `ready`/`container` 只解析一次；授权分类按页面及frame版本复用，最多250毫秒后重读。身份匹配、可见性和自定义函数继续逐轮检查，最终重新核对当前查询、容器及明确空态；缓存不跨题或尝试。

- `popup`：点击前监听该来源页的popup，只接受真实打开来源与当前条件匹配的新页。
- `same-page`：接受原页导航或相关结果容器更新，旧列表仍可见不能算本题搜索完成。
- `reuse-target`：首次点击前监听真实命名目标页，确认后绑定；后续复用该页并确认其实际更新，不按标签序号寻找。
- `iframe`：在已确认iframe内等待结果及标识，容器描述使用实际frame选择器。

`container`/`ready`/`empty` 可用定位描述或返回本页原生Locator的函数，`ready`/`empty` 也可用返回布尔值的检查函数。唯一性只计当前可见目标，可将实测列表容器与空态容器组成union，当前应恰好一个可见；同时出现两个可见容器时仍须重新定位。`match` 推荐用描述及当前完整预期文本，默认精确匹配，只有已核实页面回显格式才用 `match: 'contains'`；亦可传读取本页真实字段并返回布尔值的函数。匹配须包含当前查询、记录ID或足以唯一识别目标的题名/作者/年份，不能只检查“结果”标题或容器存在。

```javascript
// 下列名称须替换为本网站流程或当前观察中真实确认的名称。
var sourceId = '实际来源ID';
var recipeId = '实际来源ID:实际任务类型';
var query = '由当前题目生成的实际检索式';
var filters = {mode: 'professional', sort: '题目要求的实际排序'};
var flow = session.recipe(recipeId);
var opened = await session.page(sourceId, {recipeId, role: 'search', withObservation: true, compact: true});
var page = opened.page;
// 已确认的输入控件填词；清理残留筛选并验证当前模式。
await page.getByRole('textbox', {name: '实际输入控件名称', exact: true}).fill(query);
var result = await session.transition(sourceId, {
  questionId: question.id, fromPage: page, toRole: 'results', recipeId,
  query, filters, expected: '本题完整查询的实际预期回显',
  trigger: async current => current.getByRole('button', {name: '实际提交名称', exact: true}).click()
});
// flow.transitions.results 必须已含真实 mode/container/ready/match。
// 若未确认，先观察并显式提供上述参数，不能按此例盲提交。
if (result.status === 'ready') {
  await session.recordSearch(sourceId, {page: result.page, query, filters, outcome: result.outcome});
  if (result.outcome === 'results') {
    // 在 result.container 中核对记录标识；按真实列表、分页、排序定位。
  }
}
```

明确空结果也需专用完成标志及当前查询回显，返回 `status: 'ready', outcome: 'empty'`，用返回的 `outcome` 登记本次搜索。搜索失败、加载中或验证码不写成空结果；受阻页面只能登记 `failed`。搜索到详情使用同一接口、`toRole: 'detail'` 和当前记录标识；取证传 `result.page` 及真实 `container` 或详情字段Locator。页面绑定携带题号、尝试号、操作ID、条件指纹与文档版本；开始下一题后，旧题绑定和延迟popup不得用于取证。

当前操作、人工登录及证据尚未读完的任务页受保护；名额不足优先关闭已完成旧详情页。常驻准备页、登录/验证码页及其弹窗不参与任务页名额清理。全部任务名额均受保护时先读完现有证据再开新页，不因未截图/落盘而长期保留已完成页，不关闭用户日常浏览器页面。

结果或详情页返回 `blocked` 时，用户在该可见原页完成验证后调用 `session.resumeTransition(sourceId, {role: 'results', questionId})`（详情用 `role: 'detail'`）。它重新读当前页并检查原查询/记录及完成标志，匹配后返回 `ready`；未恢复时继续标明受阻，不跳转到旧题列表。`session.recheck(sourceId, {role})` 可重新检查特定角色页，检查入口可达不等于当前查询已恢复。重建Node后先重新观察实际页面与标识，不能凭旧绑定直接取证。

## 授权与恢复

遇到登录、验证码、机构权限页面，记录阻碍并提醒用户到可见窗口完成。用户可操作原页面，Codex保留 `session` 和 `page`。验证后 `session.observe(page)`，检查最终URL、正文和权限状态；搜索页尚未恢复时通过观察到的入口继续。不要删除 profile、导出 cookies、重启新会话或声称已有校园网就有全文权限。

普通网络错误初次失败后最多重试两次，仍受阻如实说明障碍并继续独立缺口。授权等待、正常零结果不属于网络重试。只有用户明确要求关闭浏览器会话时才调用 `session.close()`，不关闭用户其他浏览器。

## 可选证据与答案记录

在正确详情页、官方帮助或授权全文中只读相关字段，足够即答。`locator.innerText()`、`page.evaluate()` 读取已打开页面，不能捏造已执行的搜索。截断文本不能证明“没有/不包括”。需要helper登记来源时可调用下列接口，默认仅内存；截图不是事实核验门槛。

```javascript
var captured = await session.captureEvidence(page, {
  questionId: 'question-001',
  name: '官方详情页',
  query: '实际检索式与筛选',
  field: '题目所问字段',
  locator: '章节、字段或观察到的定位说明',
  evidence: '从实际页面读取的短证据'
  // target 可传已观察到的原生 Locator，针对特定区域或 iframe 读取。
});
```

返回 `{source, artifact}`：`captured.source` 可直接引用或放入可选 `answer.sources`，默认artifact为内存材料，无文件路径。`archive: true` 保存文本，需要视觉归档再显式启用 `screenshots: true`（要求archive）。`evidence` 是目标区域真实摘录，helper检查文本是否出现；定位说明填入 `locator`，原生Locator填入可选 `target`。使用返回实际URL和时间，不手写“已到达”记录。

需要记录同页多个摘录时，一次批量读取，不按选项重复观察：

```javascript
var captured = await session.captureEvidenceBatch(page, {
  questionId: 'question-001',
  name: '官方帮助页',
  query: '实际检索式与筛选',
  field: '本题相关功能',
  locator: '实际章节或定位说明',
  excerpts: ['页面中的真实短摘录A', '页面中的真实短摘录B']
  // target 同 captureEvidence，可传已观察到的原生 Locator。
});
// 返回 {sources, artifact}；每个 source 的结构与单条接口相同。
answer.sources = captured.sources;
```

批量接口逐一检查摘录真实性，共用一次观察与artifact；默认不截图或落盘，不缓存旧答案。多个选项可共同引用一条摘录，无需为凑选项数重复捕获。材料已经充分时也不必调用本接口。

可选 `session.saveAnswer(question, answer)` 接收完整规范化题目；无选项判断题使用 `options: {}`：

```javascript
answer.confidence = {
  score: 95, // 0..100 的整数；本数值仅示例，按本题实际证据评估。
  basis: '简短说明原始证据及尚存缺口'
};
var saved = await session.saveAnswer(question, answer);
// saved: {answer, jsonPath, markdownPath}；默认路径为null，archive:true才写文件。
// 中文答复读取 saved.answer.status 与 saved.answer.confidence。
```

helper答案记录按 [answer.schema.json](answer.schema.json) 填写；网站sources用实际捕获或 `reuseEvidence()` 返回值，本地计算/卡片用对应接口返回值。直接答复无需此结构；官方API、网页工具或子代理充分材料按 [retrieval.md](retrieval.md) 验收即可，不为登记、截图或JSON重复取证。采用helper记录时读取最终状态与置信度；其他路径按真实材料评估，不声称helper通过。

PDF文字、参考文献或页数可由实际文件文字/元数据支持时，不渲染。图表、版式或文字提取不足时才查看所需页，区分物理页码和正文页码；搜索列表不能代替全文。只问录像时长，读取初始化后的播放器总时长或对应官方元数据，确认对象和单位即可，不播放整段录像。

同一会话连续发题及最后答复后保持 `session`和浏览器，不自动关闭；只有用户明确要求关闭时才 `await session.close()`。持久 profile 留待后续授权复用，账号信息不进入分发包。

浏览器关闭后可 `await session.start()` 恢复同一profile，不关闭已有非空页；Node重置用原 `sessionId` / `outputDir` 恢复归档。默认内存证据不跨Node重置恢复，已有对话工具材料可继续引用。不为重建对象启动预检。

题目答复只显示答案、关键依据、来源和置信度。开启archive时才保存诊断与证据文件，不展示或要求每题落盘。
