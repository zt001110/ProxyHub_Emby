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

策略列表不含 DIRECT/FINAL 等全局路由规则。订阅域名通过 `EMBY_SUB_DOMAIN` 配置，应与 Emby 分流域名不同，避免策略资源下载依赖其自身节点；现有部署使用独立订阅 Worker 的 workers.dev 入口承载订阅和 WebSocket，原反代域名继续仅承载反代；无需创建优选 DNS 记录。若该入口在某网络不可达，订阅刷新会失败，应使用可达且独立的订阅域名。

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
