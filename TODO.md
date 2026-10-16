# TODO

Assembly status.

## Done

- [x] 题库合并：1017 条（多选 400 / 单选 312 / 判断 305），运行时校验通过
- [x] 全部 1017 条可直接作答（`needs review: 0`）
- [x] 命中即答改造：`POLICIES` 加入 `trusted`；判断题守卫按来源收窄；旧政策分档不再拦 trusted 库
- [x] 删除 5 条无法确定性判定的旧库判断题（`O23` `O27` `O41` `O47` `O48`）
- [x] 19 条旧库判断题按"字母→选项文字"链路重建 `judge_answer`，冲突留痕于 `issue_details`
- [x] `tools/` 六件套：`build-digest` / `validate-bank` / `list-flagged` / `match-regression` / `stamp-release` / `package-audit`
- [x] `SKILL.md` / `README.md` / `README-DSH.md` / `references/question-bank.md` 重写
- [x] `LICENSE`（MIT，含上游署名）/ `.gitignore`
- [x] DSH 适配层整理进仓库（`daemon.cjs` / `ailit.cjs` / `ailit.ps1` / `setup-dsh.ps1` / `verify-dsh.ps1`）
- [x] **端到端安装验证**：装出 299 个文件、Playwright 就位、健康检查通过、`bank-status` 报 1017 条全可用、`prepare` 报 252/252 站点流程
- [x] **补注册表缺口**：新增 5 个档案（Connected Papers / Semantic Scholar / OpenAlex / 港科大机构库 / 人大复印报刊资料）；运行时 `preload` **252/252 加载成功**、311 条流程
- [x] **`retrieval_channels` 落地**：为 OpenAlex、Semantic Scholar、Connected Papers 登记机器可读渠道（文档链接、实测时间、实测结果、覆盖范围、不覆盖范围、障碍）
      - 字段必须放在 **recipe 对象里**，不能放 profile 顶层：`recipes.cjs` 的 `recipe()` 返回 `clone(recipe)`、`find()` 返回 `recipes.map(clone)`，profile 顶层字段对 agent 不可见（实测放顶层时 `channels=0`）
      - 核准计数：原有 7 个档案已登记渠道（arxiv / cnki / crossref / pubmed / quiz-data-worldbank-org / vip / wanfang），本次新增 3 个，共 **10 个档案 / 17 条渠道**
- [x] **API 表补充**：`retrieval.md` 官方 API 表新增 OpenAlex、Semantic Scholar、Connected Papers 三行，含端点、实测结果与口径差异说明
- [x] **三条检索硬规则**：新增"全文与页面核对"一节（`references/retrieval.md`）+ `SKILL.md` 摘要
      1. 扫描件 PDF 无文本层时改用页面图像识别
      2. 按题目页码定位前验证印刷页码与 PDF 序的偏移
      3. 题目指定工具时以该工具口径为准
- [x] **题库相似度阈值 0.12 → 0.3**：实测题库外问题在 0.12 下 14/14 都返回候选（中位相似度仅 0.147），0.3 下只剩 1/14；题干相同的近似题走 `sameStem` 分支不受影响（120/120 保留）
- [x] **429 退避与搜索降级**：写入 `references/retrieval.md`（Semantic Scholar 无 key 实测 4 次仅 1 次成功；搜索引擎转人机验证页时改官网直连）
- [x] **Connected Papers 流程定稿（结论：不做 `execution`）**：实测可复现的通路是 **URL 直达** `/search?q=<query>&p=1`（两次独立查询成功读到 5825 / 834 引文数，正文回显查询词）。站内搜索框 `#searchbar-input` 计算样式为 `display:inline-block` 但 `offsetParent` 为 `null`；两种执行器形态（`click+fill+Enter`、`click+fill+press`）经 `runSearch` 实测均返回 “No fresh result/detail page matched this question”。执行器没有"直接导航 `entry_url`"的形态，因此**有意不提供 `execution`**，改由 agent 直接导航 URL 取证；档案标记 `query_verified` 并记录 `blockers: no-executable-flow`
      - 相关约束：`runSearch` 要求 `recipe.status === 'query_verified'` **且** recipe 有 `execution.version === 1` 与已验证的 `entry_url`；三者缺一即返回 `needs_observation`

- [x] **打包前最终检查通过**（297 个文本文件审计 + 题库 + 运行时 + 安装闭环）
      - 审计发现并修复一处**真实凭据泄露**：`references/sites/quiz-oalib.json` 的 `form_action` 带 Tomcat URL 重写会话标识（`;jsessionid=` + 32 位十六进制 + `.tomcatN`），共 3 处。已剥离会话参数并重跑运行时 `preload`（252/252 正常）
      - 新增 `tools/package-audit.cjs`（整仓审计，关键项为零才通过），取代只扫指定文件的 `privacy-scan.cjs`；无残留引用
      - 修复 `setup-dsh.ps1` / `verify-dsh.ps1` 的命名与结构假设：技能名改由 `SKILL.md` frontmatter 读取（原写死 `ai-literacy-search`，导致 il-radar 装到错目录名）、payload 路径改为平铺结构；安装→校验闭环报 **303 文件全部匹配**

## Assembly notes（踩过的坑，改结构前先读）

- **`runtime/` 必须在包根**，不能放 `references/` 下：`scripts/preparation.cjs` 硬编码读取 `<包根>/runtime/package.json`，放错位置会在 require 阶段直接崩
- **adapter 三个文件与 `SKILL.md` 必须在技能根**，与 `scripts/`、`references/` 同级；`ailit.ps1` 按 `<adapterDir>/../scripts/browser.cjs` 定位技能
- **`entries_sha256` 必须用 JS 计算**：Python 的 `json.dumps` 与 JS 的 `JSON.stringify` 对非 ASCII 的字节输出不同
- **`source_kind` 受运行时白名单限制**，只能是 `user_supplied_official_sample` / `user_supplied_platform_report`；精确来源另存字段
- **`retrieval_channels` 放在 recipe 内**，放 profile 顶层时 agent 读不到
- **不要删链接后立刻跑安装**：`[IO.Directory]::CreateDirectory` 会跟随链接，链接不存在时会在链接位置创建真实目录，导致数据分裂到两侧
- **查字段是否存在要按运行时返回路径验证**，只 `grep` 文件文本或只看一层结构都会误判

## Next

- [ ] **为其余 API 型来源登记 `retrieval_channels`**：Crossref、PubMed、arXiv、World Bank 已有渠道条目，可对照 `retrieval.md` 的实测记录补齐或更新实测时间
- [ ] **港科大与人大复印的会话内取证封装**：前者需复用已验证会话下载 PDF（直连必被重定向到验证码页），后者需区分公开排名页与需机构权限的查询库

## Known limitations

- 题库 819 条来自内部表格，**无解析、无来源链接**；命中时只能给答案与出处，无法给出推导过程
- 题库匹配是精确匹配：题干被改写的"同考点不同问法"不会命中，会走检索
- 题库答案未经独立核验；`references/question-bank.md` 已如实声明
- 判断题必须能从"字母→选项文字"链路确定布尔值，否则会被运行时排除
- Connected Papers 只能由 agent 直接导航 URL 取证，不能通过 `runSearch()` 执行
