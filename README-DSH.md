# DeepSeek Harness 适配说明

il-radar 的运行时是为**常驻 Node 环境**写的：初始化时建立全局 `session`，之后每轮对话复用同一进程，因此可见 Chrome、登录态与资料缓存能跨轮存活。

DSH 没有这种环境。DSH 暴露的执行手段是 `pwsh`，**每次调用都是新进程**，全局变量用完即失。直接照搬会导致每道题都重启浏览器、丢失登录态。

本适配层补上缺失的那一层：用一个**后台守护进程**持有长期存活的 Node 环境。

```
DSH 一轮对话
  └─ pwsh ailit.ps1 <命令>
       └─ node ailit.cjs            解析参数、确保守护进程在跑、POST 一个 JSON
            └─ (HTTP 127.0.0.1) ──► node daemon.cjs        长期存活
                                      └─ SearchSession       scripts/browser.cjs
                                           └─ Playwright ──► 可见 Chrome（持久 profile）
```

| 文件 | 职责 |
|---|---|
| `daemon.cjs` | 创建并持有唯一的 `SearchSession`，监听本机随机端口，每条 HTTP 请求对应一次会话方法调用 |
| `ailit.cjs` | 命令行 → JSON 命令；必要时拉起守护进程；把回复原样打到 stdout |
| `ailit.ps1` | DSH 入口：解析技能目录与 Playwright 运行时路径，调用客户端 |
| `setup-dsh.ps1` | 安装 / 更新：写入技能根、运行时与路径配置 |
| `verify-dsh.ps1` | 校验已安装副本与源码包逐文件一致 |

## 安装

```powershell
.\setup-dsh.ps1 -PackageRoot '<本仓库>' -ProjectRoot '<你的项目根>'
```

脚本会：

1. 把 `SKILL.md`、`scripts/`、`references/`（含题库）、`runtime/`、`tools/` 与三个适配器文件复制到 `<技能根>\il-radar\`
2. 在包根旁安装 Playwright 运行时（只装依赖，**不下载浏览器**，使用本机 Chrome）
3. 写出 `paths.json`，记录运行时与守护进程状态目录
4. 停掉在跑的守护进程，最后做一次健康检查

参数：

| 参数 | 默认 |
|---|---|
| `-PackageRoot` | 脚本所在目录 |
| `-ProjectRoot` | 最近的 `.git` 祖先目录，否则当前目录 |
| `-SkillsRoot` | `<ProjectRoot>\.dsh\skills` |
| `-RuntimeRoot` | `<包根旁>\.dsh\ai-literacy-runtime` |
| `-DaemonStateRoot` | `<包根旁>\ai-literacy-search` |
| `-User` | 装到 `$DSH_HOME\skills` 而非项目级 |
| `-WhatIf` | 只显示会写什么 |

Chrome profile 与登录态保存在运行时目录的 `profiles/chrome/<会话ID>/`，**更新不会删除它**。

## 路径配置

`paths.json` 由安装脚本写出，支持相对包根的路径：

```json
{
  "runtimeDir": "..\\.dsh\\ai-literacy-runtime",
  "daemonDir":  "..\\ai-literacy-search"
}
```

解析优先级：环境变量 `AI_LITERACY_RUNTIME_DIR` / `AI_LITERACY_DAEMON_DIR` → `paths.json` → 旧版 `runtime-path.txt` → 兜底默认。

## DSH 的技能发现与目录链接

DSH 只在固定位置发现技能（`<项目根>\.dsh\skills`、`$DSH_HOME\skills` 等），**不扫描任意目录**。若数据放在别处，需要一个目录链接接入：

```powershell
New-Item -ItemType Junction -Path '<项目根>\.dsh' -Target '<数据目录>\.dsh'
```

**注意**：`[IO.Directory]::CreateDirectory` 与大多数文件操作会**跟随**链接。因此不要在链接不存在时运行安装脚本——那会在链接位置创建真实目录，导致技能装到链接的另一侧、与链接目标分裂。安装前后都用 `Test-Path '<链接>\skills\...\SKILL.md'` 确认可达。

## 使用

装好后在 DSH 新对话输入：

```text
使用 il-radar，准备答题。
```

或直接贴题干与全部选项。

## 排障

| 现象 | 处理 |
|---|---|
| 守护进程 20 秒内未启动 | 读 `paths.json` 中 `daemonDir` 下的 `daemon.log` |
| 命令长时间无响应 | 守护进程逐条处理请求；`prepare`/`search` 可能跑几十秒到几分钟，其它命令排队，**不要重发** |
| `code_status: reload_required` | 技能文件与已加载版本不一致：执行 `shutdown`，下次调用自动加载新代码，Chrome 与登录态保留 |
| 题库报"摘要无效" | 用 `tools/build-digest.cjs` 重算 `entries_sha256`（必须由 JS 计算） |
| 技能未出现在目录 | 确认链接存在且可达：`Test-Path '<项目根>\.dsh\skills\il-radar\SKILL.md'` |

## 已知限制

- 守护进程监听 `127.0.0.1` 随机端口，仅本机可访问，无鉴权（与本地 DSH 会话权限一致）
- 同一份运行时 + 同一个会话 ID 只应有一个守护进程；客户端用裸 TCP 探测存活，避免在守护进程繁忙时误判死亡并重复拉起
- 改技能脚本后需 `shutdown` 才会加载新代码（会话内会返回 `reload_required`）
- `prepare` 可能跑几分钟，守护进程的请求超时已放宽到 15 分钟
