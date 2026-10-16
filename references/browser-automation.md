# Chrome 自动化接口

本文件是可选接口参考。**充分证据可直接答复，不必经过这些接口。** 只有需要站点交互、结果页归属绑定或归档时才使用。

运行时通过 Playwright 控制**可见的 Google Chrome**，使用独立持久 profile，不读取日常 Chrome 配置。登录与验证码由使用者在原窗口完成。

## 调用方式：DSH 命令

DSH 没有常驻 Node 环境，本技能用一个后台守护进程持有唯一的 `SearchSession` 与可见 Chrome。**所有操作都通过 `ailit.ps1` 转发** —— 不要在 PowerShell 里 `require('browser.cjs')` 或直接调用 `session.*`，那样拿不到守护进程里的会话与登录态。

```powershell
$w = '<技能目录>\ailit.ps1'    # 安装脚本输出的路径

& $w health                     # 守护进程与浏览器状态
& $w start                      # 启动浏览器，不开来源站
& $w prepare                    # 启动 + 缓存资料 + 打开默认站点
& $w prepare -Sources cnki,wanfang
& $w prepare -NoSources         # 只准备缓存，不开站
& $w bank-status                # 题库计数
& $w lookup -QuestionFile q.json
& $w search -QuestionFile q.json -Recipe <recipeId> [-Params p.json]
& $w rule-card -RuleId retrieval-metrics
& $w preload-rules              # 预载全部规则卡
& $w calculate -QuestionFile calc.json
& $w pages                      # 当前会话的页面
& $w open -Url <url>
& $w call -Method <name> [-Args a.json]    # 透传，见下表
& $w close | shutdown
```

**每条命令输出一个 JSON 对象**；失败时 `ok: false`，`error` 写明原因，退出码为 2（守护进程回答了错误）或 1（客户端本身出错）。

### `call -Method` 可用的透传方法

只接受下表名称。**其余 Session 方法没有暴露**，请改用对应命令。

| `-Method` | `-Args` 字段 |
|---|---|
| `acquirePage` | — |
| `beginQuestion` | `question` |
| `finishQuestion` | `question` |
| `saveAnswer` | `question`、`proposed` |
| `findRecipes` | `question`、`options` |
| `recipe` | `recipeId` |
| `source` | `sourceId` |
| `taskPages` | — |
| `observe` | `sourceId`、`page`、`options` |
| `inspect` | `sourceId`、`page`、`options` |
| `currentObservation` | `page`、`options` |
| `pageResult` | `sourceId`、`options`、`reuseObservation` |
| `captureEvidence` | `sourceId`、`page`、`options` |
| `reuseEvidence` | `question`、`options` |
| `evidencePayload` | `record` |

命令与方法一一对应：`prepare`↔`prepare()`、`start`↔`start()`、`bank-status`↔`bankStatus()`、`lookup`↔题库查询模块、`search`↔`runSearch()`、`rule-card`↔`ruleCard()`、`preload-rules`↔`preloadRules()`、`calculate`↔`calculate()`、`pages`↔`taskPages()`、`open`↔开页、`close`↔`close()`、`shutdown`↔关闭守护进程。

## 什么时候不需要浏览器

以下情况**不启动浏览器**，直接用本地能力：

- 题内数据可推导（计算题）
- 已有适用的稳定规则卡
- 本对话已有充分原始证据
- 只查本地题库（见 [question-bank.md](question-bank.md)，无需创建 session）

## 会话

### 建立

**不要自己建会话。** 守护进程在首次调用任何命令时自动启动，并持有唯一的 `SearchSession`、可见 Chrome 和已准备的资料缓存。会话标识、运行时目录与守护进程状态目录由安装时写入的 `paths.json` 决定。

```powershell
& $w health         # 首次调用会自动拉起守护进程并返回 session_id
& $w start          # 需要浏览器但还不想开来源站时
& $w prepare        # 需要缓存资料与默认站点时
```

同一个守护进程跨轮存活，Chrome 与登录态在多次调用之间保留。

### `prepare`

`start` 只启动或复用浏览器。`prepare` 在此基础上缓存来源索引、索引内全部站点流程、已核验规则卡与证据、以及本地题库，然后打开准备名单。

```powershell
& $w prepare -Sources cnki,wanfang   # 只打开指定来源
& $w prepare -NoSources              # 只准备缓存，不开任何站
```

默认名单来自 [sources.json](sources.json) 的 `profile.preparation_source_ids`，当前为知网、万方、维普、读秀、超星汇雅。

**摘要字段**：`status`、版本、浏览器连接、资料加载数量、`failures`、`reused_live_session`，题库计数 `bank_total` / `bank_eligible` / `bank_review_required`，站点计数 `sites_total` / `sites_opened` / `sites_reused` / `sites_failed` 与逐站 `sites[]`（含 `source_id` / `name` / `requested_url` / `url` / `status`）。

| `status` | 含义 |
|---|---|
| `ready` | 全部准备完成 |
| `partial` | 部分站点失败（超时、验证码、需登录属常见情况，页面通常已打开并停在登录页） |
| `blocked` | 浏览器未能连接 |
| `reload_required` | 已加载代码与安装版本不符 |

**页面已打开或已复用，都不代表已登录、有全文权限或查询已验证。**

### 状态查询

```powershell
& $w health    # ok、browser_connected、code_status、session_id、runtime_dir、daemon_dir
```

`code_status` 为 `current` 或 `reload_required`。版本不符时**不自动杀进程**：执行一次 `shutdown`，下次调用会加载新代码，Chrome 与登录态由持久 profile 保留。

### 关闭

```powershell
& $w close       # 关闭浏览器，保留守护进程
& $w shutdown    # 停止守护进程（Chrome 与登录态仍在持久 profile 中）
```

二者都只应在用户明确要求时执行。

### 页名额与串行

任务页默认最多 5 个，开站最多 5 个并发，**同一网站串行**。常驻准备页不占任务页名额；登录页与验证码页受保护，不作为清理对象。

## 绑定当前题

需要结果页归属绑定或归档时，提供本题完整文字与当前选项：

```powershell
# question 含 id / question / type / options
& $w call -Method beginQuestion   -Args begin.json
& $w call -Method finishQuestion  -Args question.json
& $w call -Method saveAnswer      -Args answer.json   # 需 question 与 proposed
```

`question` 的形状：

```json
{
  "id": "q-001",
  "question": "用户的完整题干",
  "type": "single",
  "options": { "A": "当前A项文字", "B": "当前B项文字" }
}
```

`type` 为 `single` / `multiple` / `judge` / `unknown`。未完成的题以相同完整题目恢复原尝试；题干或选项改变时使用新题号。题目、选项与尝试指纹用于隔离旧列表和延迟弹窗。

## 复用已有证据

检索前先读本对话已有证据，避免重复查询：

```powershell
& $w call -Method reuseEvidence -Args reuse.json
# reuse.json: { "question": {...}, "options": { "source": {...}, "freshness": "versioned", "scope": "..." } }
```

`freshness` 取 `stable`（稳定事实）或 `versioned`（固定对象/版本的记录或全文）。核对对象、字段、条件、版本和适用时点后再关联。

**`live` 类数据不允许跨题复用**：当前计数、排名、状态按所问时点取证。题内推导使用本题输入，不复用另一题数值。

同一守护进程重启后仍可用原 `sessionId` 恢复已归档证据；**内存记录会随进程结束消失**，不能声称已恢复未归档内容。

## 执行已实现的站点流程

先按来源和任务找流程，再读取其中一个：

```powershell
& $w call -Method findRecipes -Args find.json   # { "question": {...}, "options": { "sourceId": "...", "taskKind": "..." } }
& $w call -Method recipe      -Args recipe.json # { "recipeId": "npc-laws:record-lookup" }
```

流程的 `execution` 声明可执行步骤与参数。**三个前置条件缺一即返回 `needs_observation`**：

1. `recipe.status === 'query_verified'`
2. `recipe.execution.version === 1`
3. 流程有已验证的 `entry_url`

执行器支持的动作只有 `fill` / `select` / `check` / `click`，提交动作为 `click` 或 `press`。

```powershell
& $w search -QuestionFile q.json -Recipe npc-laws:record-lookup -Params params.json
```

`params.json`：

```json
{
  "parameters": { "query": "从题干原文提取的名称" },
  "parameterQuotes": { "query": "题干中包含该名称的原文摘录" },
  "expected": "题干中的结果标识",
  "extract": { "limit": 5, "maxChars": 6000 },
  "capture": true
}
```

**参数约束**：`parameters` 的值必须出现在**本题题干**中，且每个参数都要有来自题干的 `parameterQuotes`。只允许该流程 `execution` 声明的键。`expected` 默认取 `query`，也须来自题干。

`search` 在一次调用里完成开入口、检查控件与模式、清残留、填参数、提交、绑定结果页、等待结果或空态、读取必要内容。

### 返回状态

| `status` + `outcome` | 含义与后续动作 |
|---|---|
| `ready` + `results` | 当前查询结果已确认，可核验字段。列表**不能**代替题目要求的详情、全文或完整名单 |
| `ready` + `empty` | 出现明确正常空态且条件一致。不单凭未见记录证明"不存在" |
| `blocked` | 登录、验证码或权限障碍。保留原页面，用户验证后按断点恢复 |
| `needs_observation` | 流程未实现或当前结构不满足。读取返回的观察结果，用下表方法继续，**不重做已完成步骤** |

**`outcome: 'failed'` 不等于零结果。** 截断、加载中、语法错误、超时都不能作为否定事实的证据。

返回数据含 `data: {text, truncated, links, conditions}`、`sources`、`artifact`。**即使返回 `ready`，也要按 `data.conditions` 与实际界面核对完整口径**（日期、类型、排序、分页）。

题目要求日期、资源类型、排序或分页，而 `execution` 没有对应步骤时，用观察类方法补齐——**不能为了调用函数而省略题目限制**。

## 观察与取证

`search` 不覆盖或页面结构变化时使用。

```powershell
& $w open -Url https://example.org/            # 打开或复用页面
& $w pages                                    # 列出当前会话页面
& $w call -Method observe            -Args o.json   # { "sourceId": "...", "page": {...}, "options": { "detail": "full" } }
& $w call -Method currentObservation -Args c.json   # { "page": {...}, "options": {...} }
& $w call -Method inspect            -Args i.json
& $w call -Method pageResult         -Args p.json
& $w call -Method source             -Args s.json   # { "sourceId": "..." }
& $w call -Method taskPages
& $w call -Method acquirePage
```

`observe` 默认返回完整观察；`options.detail` 设为 `status` 时只取可见正文、标题与控件，适合只需确认状态时。

### 证据捕获

```powershell
& $w call -Method captureEvidence -Args ev.json
& $w call -Method evidencePayload -Args pl.json
```

`captureEvidence` 默认只登记本题短摘录到内存，不截图、不落盘。**截断的文本不能证明"没有/不包括"。**

### 目标页归属

新标签页、原页更新与 iframe 必须与当前查询或记录标识绑定后才能作为证据。

**不要按"最后一个标签页"猜测目标。** 旧题的延迟弹窗不作当前证据；结果页验证完成后重新观察，从原步骤继续。

### 目录外来源

目录外的一手官方来源在当前页读取并核实身份后即可支持答复。当前适配器**未暴露** `addSource`，因此不要试图登记新来源；直接在已打开的页面读取并引用其 URL。

## 本地计算与规则卡

题内能推出结论时直接推导，**不要求浏览器**。需要复算证明时：

```powershell
& $w calculate -QuestionFile calc.json
```

`calc.json`：

```json
{
  "question": { "id": "q-001", "question": "完整题干", "type": "single", "options": {} },
  "operation": "retrieval-metrics",
  "inputs": { "relevantTotal": 160, "retrieved": 80, "relevantRetrieved": 40 },
  "inputQuotes": {
    "relevantTotal": "共有相关文献160篇",
    "retrieved": "检出80篇",
    "relevantRetrieved": "其中相关40篇"
  }
}
```

| `operation` | `inputs` 与 `inputQuotes` 的键 |
|---|---|
| `retrieval-metrics` | `relevantTotal`、`retrieved`、`relevantRetrieved` |
| `ratio-percent` | `part`、`whole` |

输入摘录必须来自题干并包含对应数值。**计数与比例须满足范围约束且分母非零**，不接受任意表达式。返回 `{source, proof, artifact}`；`proof.results` 是实际结果，`proof.steps` 是代入过程。

规则卡按 ID 读取，无需整份加载 [rules.json](rules.json)：

```powershell
& $w rule-card -RuleId retrieval-metrics
& $w preload-rules
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

默认不归档：证据留在会话内存，不为每题生成文件。归档在守护进程启动时确定，由安装配置控制；日常答题不需要更改。

视觉判断可以只读取相关页面或图像，不必启用整题归档。**浏览器持久 profile 始终保留登录状态**，与归档设置无关。

## 未暴露的原生能力

`SearchSession` 本身还有若干方法**没有接到 DSH 适配器**（例如 `transition` / `resumeTransition` 页面迁移、`recordSearch` 检索登记、`addSource` 来源登记、`useRule` 规则引用、`validateWebEvidence` / `validateLocalEvidence` 证明校验）。调用它们会返回 `Method not exposed by the DSH adapter`。

遇到这种情况：用上表已有命令完成同一目标，或如实说明该步骤在 DSH 下不可执行、改用等效证据。**不要假设文档里没写的接口可用。**

## 排障

| 现象 | 处理 |
|---|---|
| `Method not exposed by the DSH adapter` | 该原生方法未接入。改用命令表里的等效命令，或换等效证据 |
| 页面可达但查询无结果 | 页面可达**不等于**查询已验证。检查条件回显、控件唯一性与空态标志 |
| `code_status: reload_required` | 执行 `shutdown`，下次调用会加载新代码；Chrome 与登录态由持久 profile 保留 |
| 登录或验证码挡住 | 保留原页面，请用户在可见窗口完成后按断点恢复。**不索取密码、不绕过验证** |
| 普通网络故障 | 最多重试两次。正常零结果不是故障 |
| 定位失败 | 重新观察页面，修复本会话流程后继续；不猜测选择器 |
| 命令长时间无响应 | 守护进程**逐条**处理请求，`prepare` / `search` 可能跑几十秒到几分钟。**不要重发** |
| 题库报"摘要无效" | 题库文件被改动后未重算摘要，用 `tools/build-digest.cjs` 重算 |
