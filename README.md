# Piko

使用 **TypeScript + Bun** 开发的 Windows x64 命令行包管理器，当前为 **0.4.0 预览版**。统一管理便携程序、Node 等运行时和 npm CLI；Piko 的 EXE 不需要预装 Node/Bun。

替代目标与待办见 [替代 Scoop 与 mise 的功能差距](docs/replacement-gaps.md)（仅用户级软件与全局版本管理，不包含 mise 项目功能）。

## 已实现

- 单文件/ZIP 下载、SHA-256 校验与可信下载缓存。HTTPS 静态清单源、Git 清单源和 npm registry。
- 所有软件多版本共存；安装不选默认。`use` 选择已安装版本，`current` 为 junction，EXE shims 供 CMD、PowerShell 和普通子进程调用。
- 按精确版本或主/次版本系列更新，保留旧版本；支持逐包批量更新。
- 显式命令归属、释放、可执行别名和 PATH 遮蔽诊断，不接管外部安装。
- manifest env、声明式持久化目录、数据预览和确认清理。
- 安装晋升、默认切换、卸载、数据清理、npm 重建与自升级的日志恢复。
- npm CLI 按包/版本隔离，运行时使用当前默认受管理 Node；安装和更新始终禁用生命周期。内容绑定批准后显式重建，依赖逐项批准。
- 受校验的 Piko 自升级、备份和兼容性回退；本地 ZIP 发行包、安装入口和 CI 配置。

0.3.0 已完成 **62 条实际 Windows Sandbox 检查，0 失败**。0.4.0 本机 **49 项测试、309 次断言通过**，验证及限制见 `docs/verification/README.md` 与 `docs/stage-4.md`；新的完整 Sandbox 验收尚待运行。Windows 10 清洁环境仍未认证。

## 开发与构建

固定 Bun **1.4.4**；测试需要开发机 Node/npm，当前受测 Node 26.12.1 / npm 11.20.0。测试使用项目依赖和独立临时安装，不修改宿主用户 PATH。

```powershell
bun install --frozen-lockfile --ignore-scripts
bun run verify                 # 类型检查、EXE 构建、回归
bun run format:check
bun run sandbox:check          # 脚本和文件锁测试，不启动沙盒
bun run source:check
bun run benchmark
```

只有 Node/npm 时，在仓库中引导本地 Bun：

```powershell
npm install --ignore-scripts --package-lock=false
node scripts/bootstrap-bun.cjs
.\.tools\bun.exe run verify
```

构建输出为 `dist/piko.exe`。开发脚本可用本地 Bun 替换 `bun`。

## 安装

```powershell
.\dist\piko.exe setup          # 默认 %LOCALAPPDATA%\piko，不改 PATH
.\dist\piko.exe setup --path   # 显式加入用户 PATH，不改系统 PATH
```

完成后重开终端或 IDE。EXE 不能修改已有父终端环境。也可设置 `$env:PIKO_HOME = 'D:\piko-test'` 使用独立根目录。重复 setup 不会覆盖现有另一份 Piko 或删除状态，升级使用单独命令。

发行包生成与检查：

```powershell
bun run release                 # 生成 dist/piko-0.4.0-windows-x64.zip
bun run release:check            # 解包、核对摘要、实际安装到临时根目录
# 解压发行包后，使用独立可信渠道核对的 EXE 摘要：
.\install.ps1 -Sha256 <EXE_SHA256> -PikoHome D:\piko -Path
```

发行物当前未签名；ZIP、EXE 各有摘要。打包不会上传，CI 配置不会自行发布；已有同版本发行目录时拒绝覆盖。

## 安装软件

内附固定版本 Node **26.12.1**、ripgrep **15.2.0**，不是自动追踪上游最新版本。`examples/source/` 或发行包中的 `source/` 可以作为 HTTPS 静态目录托管，不需要用户本地持续运行服务器。开发试用可在仓库运行 `bun run source:serve`，然后：

```powershell
piko source add main http://127.0.0.1:8765/
piko info main/node
piko install main/node@26.12.1
piko use main/node@26
node --version

piko install main/ripgrep@15.2.0
piko use main/ripgrep@15
rg --version

piko install npm:prettier@3.9.10
piko use npm:prettier@3
prettier --version

piko install npm:@mariozechner/pi-coding-agent@0.73.1
piko use npm:@mariozechner/pi-coding-agent@0.73.1
pi --version
```

只有回环 HTTP 允许作测试源。HTTPS 不降级，Git 使用已有 Git 和认证，不修改用户 Git 配置。

```powershell
piko source add tools https://example.com/owner/piko-source.git --type git --ref main
piko source refresh tools
piko source list
piko source remove tools          # 有安装引用时拒绝
piko source remove tools --force  # 只移除配置，软件与来源记录保留
```

源是 Piko 清单格式，不兼容 Scoop bucket。Git 从固定 commit 读取，不 checkout 或运行仓库代码。源刷新失败直接报错，不使用过期缓存；移除源后更新需要恢复同一来源。

## 版本与更新

```powershell
piko list
piko info main/node
piko which node
piko use main/node@26.12.1       # 精确版本固定
piko update main/node           # 沿用 use 保存的请求
piko update --all --dry-run     # 列出默认包与请求，不预测远程新版本
piko update --all               # 串行逐包处理，输出成功/失败明细
piko unuse main/node
piko uninstall main/node@26.12.1
```

支持精确版本、`latest` 和语义主/次版本简写；预发布需显式指定，非标准版本仅精确匹配。安装不改变 default/current，更新成功后切换并保留旧版；普通卸载默认版本会拒绝，`--force` 会清除该默认和相关入口，不自动选替代版本。批量更新不是全包原子事务；失败继续其他包，总退出码为 1，失败包保留旧默认。

## 命令归属与别名

```powershell
piko use other/tool@1 --no-commands
piko command claim tool other/tool
piko command release tool
piko command alias format-code npm:prettier prettier
format-code --version
piko command list
piko command unalias format-code
piko doctor
```

claim 需要目标已选择默认且提供该真实命令；不静默覆盖别名。别名跟随默认版本，不支持递归或 Shell 命令字符串。已转移/释放的命令不会因原包 use/update 被抢回。`--no-commands` 释放该包的普通命令，保留 current 和别名。

`doctor` 列出文件查找顺序、实际命中及预期 shim；`use` 对遮蔽告警。外部文件不改变。PowerShell 别名/函数须额外用 `Get-Command <name> -All` 检查；诊断不会替父 Shell 改 PATH。

## 环境变量与数据

平台分发项支持声明式 env：

```json
{
  "env": {
    "TOOL_HOME": "{root}",
    "TOOL_DATA": "{persist}",
    "TOOL_VERSION": "{version}"
  }
}
```

所有默认包的变量合并到受管理程序及其子进程；只支持上述占位符。冲突值、大小写重名、PATH、PIKO_*、NPM_CONFIG_*、NODE_OPTIONS 等受保护变量会拒绝。不会更改父 Shell 或注册表，也不自动建立 env 中提到的数据目录。

普通卸载保留清单声明的 persist 数据，回退程序不回退数据。

```powershell
piko cleanup main/example --data --dry-run
piko cleanup main/example --data          # 交互输入 DELETE
piko cleanup main/example --data --yes   # 非交互显式确认永久删除
```

所有安装版本卸载后才能清理，只删除记录的目录，保留同层未知文件；链接漂移或非预期 junction 会拒绝。旧版已经卸载且没有留下所有权记录的数据不自动接管；不扫描外部 Documents/AppData。

## npm 脚本

安装前必须显式选择受管理 Node/npm，不能回退系统 npm 或自动装 Node。安装要求 npm >=11.20.0，**执行脚本仅开放已受测的 npm 11.20.0**；不声称其他版本均兼容。registry 依赖交给 npm，Git/本地目录/文件/任意远端 tarball spec 拒绝；不同 scoped registry 暂不支持。`PIKO_NPM_REGISTRY` 记录并约束来源。

```powershell
piko scripts list npm:example-cli@1.2.3
piko scripts approve npm:example-cli@1.2.3  # 展示内容并输入 APPROVE
piko scripts rebuild npm:example-cli@1.2.3
piko scripts revoke npm:example-cli@1.2.3
# 依赖必须逐项批准，路径取自 list：
piko scripts approve npm:example-cli@1.2.3 --package-path node_modules/example-dependency
# 自动化绑定预先审查指纹，内容变化即拒绝：
piko scripts approve npm:example-cli@1.2.3 --binding <hash> --yes
```

approve 本身不执行，rebuild 才从已校验原始快照构建暂存副本；依赖默认为 false，版本/来源/快照/脚本绑定，升级不继承批准。失败不替换工作安装；撤销不删除已生成文件或撤销外部影响。0.4.0 支持批准后的显式 prepare 和私有依赖 .bin，不自动触发 prepare 的前后事件，也不公开传递依赖命令。相同 tarball 重复安装的路径粒度批准仍拒绝。

**这不是安全沙盒。** 获准代码以当前用户权限执行，可读写用户文件、联网和调用依赖。offline 只约束 npm 自己。真实原生模块和 pi 登录/模型调用尚未全面验证；运行时只检查顶层 engines.node，不保证所有 ABI 兼容。

## 缓存与恢复

```powershell
piko cache list
piko cache clean --dry-run
piko cache clean --yes
piko maintenance orphans
piko maintenance quarantine --dry-run
piko maintenance quarantine --yes
piko recover
piko recover --force
```

缓存清理保留已安装版本依赖的原始 npm 快照。绕过校验只对本次指定便携版本有效，不使用或写入可信下载缓存，后续仍校验；npm 不接受绕过。缓存损坏明确失败。

安装提交中断后按 journal **继续完成登记但不选默认**；未写入合法 journal 的目录不自动删除。maintenance 只隔离具有合法收据的未登记安装，不自动采纳或删除未知目录，持久化数据保留。恢复写锁需要原 owner 已退出，不按超时抢锁。

## Piko 自升级

```powershell
piko self update D:\downloads\piko.exe --sha256 <可信摘要> --yes
piko self status
piko self rollback --yes
```

旧版没有 self update 时，可从可信新版 EXE 对目标 PIKO_HOME 发起。候选先匹配可信摘要，再检查状态兼容，父进程退出后由独立 helper 替换程序并重绑已有 shims。state.json 不重写，Piko 仍不分版本、不设自身 current，固定 backup.exe 只供兼容回退。升级/回退是异步操作，用 self status 查看终态。

占用或中断时保留 journal、旧程序和 helper；使用返回路径中的 **helper.exe self recover** 继续，`--force` 恢复旧程序并仅在 owner 已死亡时清理锁。不要终止活 owner 或修改 schemaVersion。旧版无法读新状态时拒绝回退。升级 staging 工作目录保留作诊断，cache clean 不会扫描删除它。

## 布局

```text
<PIKO_HOME>/
  apps/piko/piko.exe
  apps/piko/state.json
  apps/piko/backup.exe           # 完成过升级后才有
  apps/<package-key>/<version>/ # 程序文件或 npm 私有项目，含 .piko-install.json
  apps/<package-key>/current/   # 指向默认版本的 junction
  shims/
  persist/
  sources/
  cache/                       # artifacts + npm-input + npm 缓存
  staging/
  operations/
  quarantine/                  # 仅显式隔离后创建
  mutation.lock/
```

0.4.0 可读 schema 1–4；env 和 Git 提交元数据使用 schema 4，npm 内容批准使用 schema >=3。旧版会拒绝不支持的状态；没有原始快照的遗留 npm 安装需明确卸载重装才能批准，不把任意当前目录当可信输入。

## 验收与边界

```powershell
bun run smoke:real -- --pi
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\prepare-sandbox.ps1 -IncludePi
```

每轮生成独立 `.sandbox/<时间与随机标识>/piko.wsb`，双击启动自动验收。默认准备不启动；显式 `-Launch` 才启动。输入映射只读，结果目录单独可写，不映射仓库、用户目录或凭据，剪贴板关闭；安装与 PATH 修改仅在沙盒内。

最终以 `results/report.json` 的 `status=passed`、结束时间和退出码为准，窗口打印 PASS 不等于报告已发布。报告写入有短暂文件占用重试；旧报告和 pending 内容保留，不为绕过锁截断文件。沙盒内辅助脚本可双击检查网络或重跑，不需复制命令。结果作为不可信数据读取，不自动执行。

本机已测试 Git HTTP 安装/刷新、参数与标准流、退出码、隔离 Ctrl+C、内容批准、恢复、自升级和安装入口。尚缺 Windows 10 清洁 VM、所有交互 TUI/原生模块和新版完整沙盒认证。性能由 `docs/verification/performance.json` 记录。延迟加载避免 shim 初始化安装分支，完整快照文件摘要采用 16 路有界并发且保持旧批准指纹兼容；仍有 Bun 启动开销。

**待外部条件**：签名证书、正式发布仓库/权限和正式 HTTPS 软件源托管未提供。当前本地未签名包、固定目录和 CI 配置不等于已正式发布；远端 CI 尚未运行。macOS/Linux、原生 ARM64、系统 EXE/MSI 安装器、任意非 npm 源码构建、项目级环境和接管外部安装不属于本轮 Windows 首发范围。

设计与交付记录见 `CONTEXT.md`、`docs/design.md`、`docs/technical-plan.md`、`docs/stage-4.md`。当前支持范围以代码、实际验收和本 README 为准。
