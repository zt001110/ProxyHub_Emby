# 定制版维护入口

此分支基于 [MakkaPakka518/ProxyHub_Emby](https://github.com/MakkaPakka518/ProxyHub_Emby)，保留作者核心，并维护独立定制模块。作者原始说明仍在根目录 README.md；**定制版请按本文和 custom/README.md 操作，不要直接用根目录单文件覆盖现有定制部署。**

## 仓库与分支

- `origin`：本账号的 fork `zt001110/ProxyHub_Emby`。
- `upstream`：作者仓库 `MakkaPakka518/ProxyHub_Emby`；仅用于读取和同步，禁止向其推送。
- `main`：保持纯作者代码，不混入定制功能。
- `codex/rex-custom`：定制维护主分支。
- `codex/upstream-<提交前缀>`：同步作者更新时产生的临时整合分支，通过测试和审查后合并回定制分支。

上游文件 `worker.js` 在仓库根目录；定制代码位于 `custom/`。`custom/upstream.lock.json` 记录审核过的作者提交、版本和文件 SHA-256；构建时从根目录生成带回源观察补丁的 `custom/src/worker.js`，生成文件不另行提交。作者核心不会出现两个各自漂移的已提交副本。

## 已保留的功能

- 面板内下载测速、预设/阈值、实时进度、分组排序及单节点重测。
- 临时测速 DNS 的租约、失败项清理及过期清理；正式 DNS 保持手动提交。
- 固定分享入口、地区图标、回源观察与播放请求计时。
- 私聊 Telegram 管家、所有者限制、回调鉴权。
- 线路下载统计与账号 Worker 用量查询。
- 独立更新检查器：更新前代码/配置快照、关键检查、异常回滚及后台重试。
- 持久多模块网页更新：更换作者核心时仍保留定制适配器和更新器。

## 为什么公开源码里用示例域名

这是公开 fork。仅提交源码、测试、配置模板和维护说明；不提交实际节点、账号/区域/数据库 ID、Token、密码、备份、验证报告及截图。示例域名 `*.rex-custom.invalid` 不能直接部署使用。

本机 `custom/site.local.json`（Git 忽略）保存域名/机器人名称映射和私有部署目录位置。`site:materialize` 将维护代码还原到一个全新的私有发布目录，并沿用原有 Wrangler 配置；不会覆盖当前部署目录或自动部署。详见 [定制版使用与更新](custom/README.md)。

## 命令行维护

```sh
git clone https://github.com/zt001110/ProxyHub_Emby.git
cd ProxyHub_Emby
git remote add upstream https://github.com/MakkaPakka518/ProxyHub_Emby.git
git remote set-url --push upstream DISABLED
git switch codex/rex-custom
cd custom
npm ci
npm test
npm run upstream:status
```

`npm run upstream:sync` 会在工作区干净时同步作者 `main`，创建整合分支、合并作者提交、更新锁定记录并跑测试。没有更新时直接退出。冲突、补丁不匹配或测试失败时停止，保留整合分支供检查；不使用强制推送、硬重置或自动生产部署。

需要提交到本账号 fork 进行审查时运行 `npm run upstream:pr`，它在上述检查通过后推送整合分支并创建草稿 PR，目标是定制分支，**不是向作者仓库发 PR**。这些是按需命令；定时云端自动流程见下文。

普通 CI 在定制分支推送和 PR 时仅测试及检查私密文件路径。独立的自动更新 workflow 才能使用受限 production-automatic 环境中的发布凭据。CLI 执行同步脚本若创建了 PR，应保存返回的 PR 链接；后续用 `gh pr checks`、`gh pr diff` 审查。

## 发布规则

“合并作者更新”和“发布到 Cloudflare”是两步。先审查、测试，再发布。仅更新作者核心时，可在私有发布目录使用 `npm run update:protected`，通过现有受保护更新接口执行备份、发布、检查和回滚。

修改定制适配器或独立检查器时，需要维护部署，不能仅调用原版核心更新接口；维护部署前先保存当前代码、配置和版本。详情见 [更新保护与故障修复](custom/docs/更新保护与故障修复.md)。

本仓库保持作者原有归属与上游文件；没有给上游代码另行添加或替换许可证。

## 全自动更新

已配置 `.github/workflows/automatic-update.yml`：每小时检查作者更新，隔离环境整合并测试，通过现有独立保护接口备份、发布和检查，成功后原子同步 fork 两个分支。冲突或失败创建仓库故障 Issue，并暂停同一作者提交的自动重试。电脑无需开机。

详见 [全自动更新与故障处理](custom/docs/全自动更新与故障处理.md)。自动更新只更换作者核心，保留线上定制模块；普通 CI 和手动同步命令仍不部署。
