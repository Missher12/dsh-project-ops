# dsh-project-ops 项目上下文

## 项目目标

`dsh-project-ops` 是一个独立发布、独立安装的 DeepSeek Harness Bundle。它为 Agent 提供有界 monorepo 任务地图、受影响任务规划、原生 Jobs 托管、执行回执、验证门禁和当前能力搜索，不修改 Harness 源码。

## 技术架构

- Harness Host Cordis 插件，通过 `cordis.patch.yml` 注册一个 Bundle 行。
- 读取 Session cwd 根目录任务清单，以及 `package.json#workspaces` 或 `pnpm-workspace.yaml` 明确声明的有界 package workspace。
- 根据显式相对变更文件生成稳定的受影响任务图；不会自动选择格式化或任意 other 脚本。
- 只把重新发现且摘要匹配的声明式任务分派给 Agent 可见的 `bash` 或 `pwsh`。
- 自动/后台模式复用 shell 的 `run_in_background` 和 `ctx.jobs`；插件不注册自己的 job。
- 验证门禁无状态重算计划与清单，只接受新鲜的 version-2 回执。
- 审批、沙箱、取消和工具结果仍由 Harness 主机管理。

## 文件结构

- `src/`：运行时插件、任务发现、受影响任务规划、执行回执、验证门禁和能力排序。
- `tests/`：单元、插件契约和打包回归测试。
- `scripts/smoke.mjs`：临时 `DSH_HOME` 下的真实打包、安装、组合、执行和卸载 smoke。
- `cordis.patch.yml`：Harness Bundle 组合入口。

## 安全不变量

1. 不接受任意 shell 文本，只执行发现到的声明式任务。
2. 执行前必须重新读取清单并校验 SHA-256 摘要。
3. 回执不保存命令、绝对路径、环境变量或审批文本。
4. 发布物不包含源码路径、source map、凭据或 Harness 主仓库文件。
5. 安装和 smoke 使用临时 `DSH_HOME`，不修改开发者的真实 `~/.dsh`。
6. 后台任务访问由 Harness JobRegistry 的 owner fence 决定；收集前还要核对 job 与声明式任务命令的内部绑定。
7. 验证门禁输出不重复变更路径、命令、输出或调用元数据。

## 发布边界

- 源码、Issue、CI 和 Release 只存放在独立的 `Missher12/dsh-project-ops` 仓库。
- 每个版本只产生一个 canonical `.tgz`，公网重新下载后必须与本地字节和 SHA-256 一致。
- DeepSeek Harness Desktop 仓库不嵌入插件源码，只通过标准 `dsh plugin` 命令安装。

## 当前进度

- `0.2.0`：加入 monorepo 任务地图、受影响检查规划、后台优先 auto 执行、owner-fenced 收集和确定性验证门禁。
- `0.1.2`：从 Desktop 开发分支迁移为自包含的独立仓库；运行时功能与已验证的 `0.1.1` 保持一致。

## 已知问题

- 已对固定 Harness `0.1.1-rc.2` 完成本地 macOS 验收，以及 GitHub 托管 macOS、Windows 和 Linux 的完整包生命周期 CI。
- Windows ARM 和其他未列出架构没有稳定验收 runner，不声明支持。
- Auto 是后台优先的有界等待，不是对已经启动的前台进程做提升；这是 Harness Jobs 接口的明确限制。
- 本版本不提供提示词伪装的“只读代码审查器”；通用 subagent 暂无每调用强制只读工具过滤边界。
