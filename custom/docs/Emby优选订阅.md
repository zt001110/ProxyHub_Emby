# Emby 专用优选订阅（Surge）

仅对现有 Emby 反代域名分流。Rex/Emby 客户端继续使用原反代链接；不修改 Surge 文件、不生成整份覆盖配置、不添加 FINAL 规则。服务端只接受该反代域名的 TCP 443，拒绝其他目标和 UDP。

## 与教程和 DNS 的关系

byJoey/yx-tools 是测速与上传工具，cfnew 才提供代理协议与客户端订阅。教程里的 yx 保存优选入口，p 指定 ProxyIP/中转；把它们放在环境变量不会自动让一个 HTTP Emby Worker 获得这些功能。

| 方式 | 生效范围 | 端口与选路 |
| --- | --- | --- |
| 原来的手动 DNS 优选 | 使用该域名的所有客户端，受 DNS 缓存影响 | A/AAAA 不存端口，多条记录不会自动选择最快 |
| 本功能的订阅 | 用户在 Surge 中明确分流到 Emby 策略组的流量 | 每条线路保留 IP/域名和 TLS 端口，可手动切换，不改正式 DNS |

本功能采用 Trojan WebSocket TLS 作为传输，订阅使用 Surge 官方支持的策略列表格式。与直接访问 Emby 反代相比增加了传输层，不能宣称必然更快；需要在用户实际网络测量。这里不是完整 cfnew 部署，不支持任意网站代理，也不提供 VLESS/xhttp/UDP。

## 面板操作

测速与 DNS 页面展开 **Emby 专用优选订阅 · Surge**：

1. 填写多行 IP/域名，可带端口；默认 443。支持 TLS 端口 443、2053、2083、2087、2096、8443，最多 32 条。也可填入勾选的已通过网页下载测速结果；这些结果当前为 IPv4:443。
2. 出站中转选择“绑定所选入口同一 IP:端口”或“使用单独的固定中转”。单独中转填一个可用地址。两种模式均不自动回落。
3. 点 **保存到订阅**，再点 **复制订阅地址**。Surge 更新策略列表后生效。
4. 按面板显示的两段配置，加入自己现有配置对应的 `[Proxy Group]`、`[Rule]` 段；Emby DOMAIN 规则放在可能先匹配到的广泛规则前。不要用这两段替换整份配置。

```ini
[Proxy Group]
Emby优选 = select, policy-path=面板复制的完整订阅地址, update-interval=86400

[Rule]
DOMAIN,你的Emby反代域名,Emby优选
```

策略列表不含 DIRECT/FINAL 等全局路由规则。订阅域名通过 `EMBY_SUB_DOMAIN` 配置，应与 Emby 分流域名不同，避免策略资源下载依赖其自身节点；现有部署使用独立订阅 Worker 的自定义域名承载订阅和 WebSocket，原反代域名继续仅承载反代；无需创建优选 DNS 记录。若该入口在某网络不可达，订阅刷新会失败，应使用可达且独立的订阅域名。

## 同址与真实出口

同址模式只保证本服务尝试连接的中转地址与该线路入口的 IP:端口一致，失败则断开，不换备用地址。普通 CF 入站地址可能不能做中转，ProxyIP 也可能不能从本机作为入口访问。因此同一地址写进两处不代表线路可用。

目标最终观察到的出口还受中转实现、Cloudflare 任播和现有 Emby Worker 回源路径影响，**不能保证等于所选 IP**。独立中转模式会明确使用不同的固定中转地址，也不会假称入口出口一致。网页下载测速通过、保存配置、生成订阅均不等于订阅转发实测通过。

## 独立架构、安全与维护

- 原反代 Worker 只增加面板控件和管理员接口 `/api/emby-subscription`。它通过 `EMBY_SUBSCRIPTION` 服务绑定调用独立订阅 Worker，超时或异常返回局部错误。首页、反代、测速、Telegram 和更新流程不请求订阅服务；原反代不包含 TCP/WebSocket 传输代码。
- 独立 Worker 的 `subscription/worker.js` 静态导入 Cloudflare `connect`，受限传输和订阅在 `subscription/core.js`。独立 D1 保存 `app_config.rex_emby_subscription_v1`，无原反代数据库、DNS 或更新器权限。只允许目标 `CF_DOMAIN:443`，SNI/Host 使用独立的 `TUNNEL_DOMAIN`，两者不能混用。
- 面板读取/保存需要现有管理员会话；服务间请求使用管理员认证。订阅路径用独立随机口令，Trojan 使用另一随机密码。订阅含认证信息，不得公开。
- 独立服务 Secret：`ADMIN_TOKEN`、`EMBY_SUB_TOKEN`、`EMBY_TROJAN_PASSWORD`、`EMBY_TROJAN_HASH`。最后一项为密码 SHA-224；更换密码时同步更新哈希，更换订阅口令会使旧链接失效。原反代不需要订阅密码。
- 编辑节点列表只写入订阅数据库，不发布代码、不改 DNS。测速通过不等于订阅链路通过，需实际验证。
- 原作者更新仍通过原有多模块保护层，保留面板管理入口和服务绑定，不更新独立订阅代码。只有用户点更新才启动，没有每小时自动执行。
- 独立服务后续更新使用 `npm run deploy:subscription`：先记录当前部署版本、代码、绑定设置并导出独立数据库，然后发布并重复检查健康和管理接口；失败自动切回旧代码并检查恢复。数据库配置保持当前值，避免代码回滚覆盖用户近期编辑。
- 单独备份：`npm run backup:subscription`；回滚：`node scripts/manage-subscription.mjs rollback 私有备份目录`。需配套私有 `subscription/wrangler.jsonc` 和现有 Wrangler 登录。初次安装先配置数据库和 Secret，不能对未配置实例使用维护部署命令。数据库 SQL 仅在确认需要恢复配置时单独导入，绝不导入原反代数据库。
- 单元测试覆盖认证、稳定节点 ID、目标/端口限制及服务失败隔离。私有实际链路脚本验证 WebSocket/Trojan/内层 TLS 和非 Emby 目标拒绝，不改 Surge；脚本会保存测试节点配置，应在维护时使用并恢复用户列表。
- 实测仅证明该网络下测试线路能通过内层 TLS 访问 Emby 域名，未代替真实 Surge 导入和视频播放验收。

参考：[yx-tools](https://github.com/byJoey/yx-tools)、[cfnew](https://github.com/byJoey/cfnew)、[Surge Trojan](https://manual.nssurge.com/policies/trojan.html)、[Surge 外部策略列表](https://manual.nssurge.com/policy-groups/policy-including.html)。

## 教程变量与本实现的对应关系（2026-10-16 核对）

本实现是 Emby 专用的独立订阅/受限传输服务，不是完整 cfnew。yx-tools README 明确负责测速并上传 cfnew；其 internal/app/upload.go 使用 /{UUID或路径}/api/preferred-ips。这里没有声称兼容该上传 API；用户继续在反代面板内测速和提交选中结果，不需要本地程序。

- `yx`：独立 Worker 的初始优选入口列表，逗号或换行分隔 IP/域名:TLS端口；环境变量允许忽略 # 后的备注。面板中的“yx · 优选订阅入口”管理同一用途。
- `p`：独立 Worker 的初始固定 ProxyIP，仅一个 IP/域名:TLS端口。面板固定中转对应该用途。未设置 p 时环境模式使用同址模式，不自动选择其他地址。
- 优先级：面板 D1 > Workers p/yx；与 cfnew 推荐的持久化配置优先原则一致，但这里使用独立 D1。修改环境变量不会偷偷覆盖已保存节点。需要切回变量时，在面板点击“使用 Workers 的 p / yx 变量”，验证变量有效后才删除面板覆盖。切换后刷新 Surge 订阅，节点 ID 可能改变。
- `CF_DOMAIN` 是被允许访问的原反代域名；`TUNNEL_DOMAIN` 是独立订阅服务的 TLS SNI/WS Host；`EMBY_SUB_DOMAIN` 提供订阅列表地址。这三个字段用途不同，不应都换成同一域名。
- `u`、`dkby`、`qj` 等属于 cfnew 的配置约定。这里认证用独立 Secret，协议只生成 TLS Trojan/WS，目标只允许 Emby 域名443且不回落，不需要假填这些变量。

面板现在默认展开订阅区，直接显示订阅更新地址、配置来源、实际流量路径、Workers p/yx 备用值和接入规则，并分别提供复制订阅及复制规则按钮。订阅是 Surge 外部策略列表，不能当完整配置导入覆盖其他规则。

## 实际接入边界与验证

服务端链路：Rex/Emby -> 用户手动配置的 Surge Emby 分流 -> 所选优选入口 -> 独立订阅 Worker -> 固定/同址 ProxyIP -> 原反代域名 -> 原 Emby 源站。不使用 Surge 时仍为原访问路径；保存优选列表不会自动让所有客户端生效，也不会自动改 DNS。

只读脚本 scripts/verify-subscription-emby-readonly.mjs 使用已保存的真实订阅，通过外层 WebSocket/Trojan 和校验证书的内层 TLS 请求现有各条私有反代链接的 System/Info/Public，核对服务器身份；不改配置、不写 DNS、不改 Surge、不播放视频。2026-10-16 已验证 7/7 节点及非 Emby 目标拒绝。此前只验证面板接口的报告不能代替这项结果；真实 Surge 导入和播放仍需在用户设备验收。

源码参考：[yx-tools README](https://github.com/byJoey/yx-tools)、[上传接口实现](https://github.com/byJoey/yx-tools/blob/main/internal/app/upload.go)、[cfnew README](https://github.com/byJoey/cfnew)。仓库指向的文字教程 https://joeyblog.net/yuanchuang/1146.html 本次请求返回404，未声称已经阅读其不可访问内容。

## 当前简化入口

常用界面仅显示订阅地址、节点列表，以及“复制订阅 / 使用测速结果 / 保存节点”。中转、p/yx、配置来源和连接诊断位于默认折叠的高级设置。首次接入说明独立折叠，后续不用重复复制配置。

用户选择的独立域名为 sub.tli.li，归属 preferred-ip-subscription 的 Custom Domain。当前完整订阅链接为 https://sub.tli.li/<订阅密钥>，需要从面板复制；裸域名不含认证，不能作为订阅。旧 workers.dev 的 /__emby-sub/<密钥>/surge.list 路径仍可读取同一节点列表。原反代域名、节点 ID、认证密码和数据库保持原有值。

Surge 外部资源中的 POLICY-GROUP 下载的是代理节点列表。首次将远程地址加入 Emby 策略组，并设置 Emby 域名使用该组后，日常只需在外部资源中更新；本功能不改用户现有 Surge 文件。参考 https://manual.nssurge.com/policy-groups/policy-including.html 。

### Surge 订阅解析兼容性（2026-10-16）

若外部资源显示 `Failed to parse remote resource data`，先查看 Surge 日志中的具体字段错误。已确认本机 Surge 会拒绝节点中的 HTTPS `test-url`；订阅输出已移除这个可选字段，使用 Surge 原生检查验证格式。订阅地址、节点凭据和分流规则不变，更新该外部资源即可。

该服务仅允许 Emby 域名的 443 端口；Surge 默认的公共网站延迟测试可能失败，不应据此判定 Emby 节点不可用，应以实际 Emby 请求为准。不要为了公共测速放开任意目标转发。

### 默认入口与订阅优选（2026-10-16）

rex.tli.li 保留原 emby-proxy 路由。正式 DNS 已从固定优选 IP 的灰云 A 记录改为橙云代理 A 记录，内容为保留占位地址 192.0.2.1，TTL 自动。占位地址不是客户端实际连接地址，公开 DNS 返回 Cloudflare 管理的入口，Worker 路由在请求源站前处理。不可将该占位记录改成灰云。

选择直连时，各设备使用自己的网络访问默认 DNS 返回的 Cloudflare 入口；选择订阅节点时，Surge 使用该节点指定的 IP 和端口。新设备要切换优选，需加载订阅和 Emby 分流规则；本机策略选择不会改变其他设备。无 Surge 的设备直接访问同一反代域名，使用默认 DNS 入口。

以后测速结果仅保存到订阅。唯一解析、提交选中至 DNS、更新 TOP3 至 DNS 属于旧的全局 DNS 优选功能，会重新固定正式域名 IP，不适用于本模式。测速本身不改正式 DNS。

原记录及路由备份在私有 backups/default-entry-*/before.json。回滚仅恢复 rex.tli.li 该条 A 记录，不修改其他 DNS、订阅或全局分流。

### 面板仅保存订阅（2026-10-16）

面板移除了更新 TOP3 至 DNS、直推 CNAME 和提交选中至 DNS。主操作为「保存选中到订阅」：以已勾选且本次测速通过的节点替换订阅入口列表，保留已保存的中转方式与固定 ProxyIP。单节点操作「加入订阅」追加该节点并去重。保存完在 Surge 更新订阅即可；它不改变客户端当前策略选择。

正式 DNS 写入接口已停用，旧页面或缓存脚本也不能覆盖默认橙云解析。DNS 读取、临时测速解析的创建和清理继续工作。保存失败会显示错误，不报告成功；没有通过验证的节点不能通过测速保存按钮提交。手工节点列表仍可编辑后保存。
