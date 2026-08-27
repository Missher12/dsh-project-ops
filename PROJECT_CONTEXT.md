# dsh-project-ops 项目上下文

## 项目目标

`dsh-project-ops` 是一个独立发布、独立安装的 DeepSeek Harness Bundle。它为 Agent 提供有界的项目任务发现、执行回执和当前能力搜索，不修改 Harness 源码。

## 技术架构

- Harness Host Cordis 插件，通过 `cordis.patch.yml` 注册一个 Bundle 行。
- 只读取 Session cwd 根目录中的 `package.json`、Makefile 或 Justfile。
- 只把重新发现且摘要匹配的声明式任务分派给 Agent 可见的 `bash` 或 `pwsh`。
- 审批、沙箱、取消和工具结果仍由 Harness 主机管理。

## 文件结构

- `src/`：运行时插件、任务发现、执行回执和能力排序。
- `tests/`：单元、插件契约和打包回归测试。
- `scripts/smoke.mjs`：临时 `DSH_HOME` 下的真实打包、安装、组合、执行和卸载 smoke。
- `cordis.patch.yml`：Harness Bundle 组合入口。

## 安全不变量

1. 不接受任意 shell 文本，只执行发现到的声明式任务。
2. 执行前必须重新读取清单并校验 SHA-256 摘要。
3. 回执不保存命令、绝对路径、环境变量或审批文本。
4. 发布物不包含源码路径、source map、凭据或 Harness 主仓库文件。
5. 安装和 smoke 使用临时 `DSH_HOME`，不修改开发者的真实 `~/.dsh`。

## 发布边界

- 源码、Issue、CI 和 Release 只存放在独立的 `Missher12/dsh-project-ops` 仓库。
- 每个版本只产生一个 canonical `.tgz`，公网重新下载后必须与本地字节和 SHA-256 一致。
- DeepSeek Harness Desktop 仓库不嵌入插件源码，只通过标准 `dsh plugin` 命令安装。

## 当前进度

- `0.1.2`：从 Desktop 开发分支迁移为自包含的独立仓库；运行时功能与已验证的 `0.1.1` 保持一致。

## 已知问题

- 已对固定 Harness `0.1.1-rc.2` 完成本地 macOS 验收，以及 GitHub 托管 macOS、Windows 和 Linux 的完整包生命周期 CI。
- Windows ARM 和其他未列出架构没有稳定验收 runner，不声明支持。
