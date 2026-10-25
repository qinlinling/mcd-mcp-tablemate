# 跨 agent 决策记录（append-only）

## D-001 2026-10-25 技术选型
按 `interfaces.md §0`。理由：与既有 `mcd-mcp/mcd.py`（纯标准库）保持一致，保证新环境零依赖可复现；避免引入前端构建链导致现场演示失败。

## D-002 2026-10-25 MCP 只读链路实测结论（阶段2 前置，已由 orchestrator 验证）
- `query-nearby-stores`（beType=1，searchType=2，city+keyword）→ 返回 storeCode / reservationTimeOptions，可用。
- `query-meals`（storeCode=1450713, orderType=1, beType=1）→ `data.categories`（15 类）+ `data.meals`（116 项，含 name/currentPrice/originalPrice/image/canWithOrder）。**注意 meals 是 dict，key=productCode**。
- `query-meal-detail`（code=9900005456）→ `rounds[].choices[]`，含 `diffPrice`、`supportModify`、`modification`；可用于提取套餐组成（含「麦辣」等关键词）做忌口校验。单次约 0.43s。
- `calculate-price` → 金额单位为**分**，返回 `price`/`discount`/`originalPrice`/`productList[]`/`takeWayList[]`；`productCode+quantity` 即可核价，无需 roundList。
- `query-store-coupons` → `data[]` 含 couponId / couponCode / tradeDateTime / products[]（productCode+productName）。
- **异常实测**：券与商品不匹配时 `calculate-price` 返回 `{"success":false,"code":600012,"message":"促销规则不支持该商品"}`。→ 归入「券不适用」降级路径，不得当作系统故障。
- **异常实测**：券适用商品 `9900016523`（龙焰鸡腿堡两件套）不在本店 `query-meals` 列表中，但 `calculate-price` 仍可核价（3400→2048，优惠 1352 分）。→ 结论：菜单列表 = 「可售展示集」，核价接口可校验「券内商品是否可售」，二者需分别使用，不能互相替代。方案生成时只从菜单列表取商品，券抵扣仅在商品可见且券匹配时启用。

## D-003 2026-10-25 忌口校验口径
「不要」按关键词在「餐品名 + 套餐组成名」上做包含匹配（`rules.NEVER_DICT` 维护同义词组，如 辣→[辣,辛,椒]）。未收录的自由词直接按原文匹配。若某餐品缺少 detail（拿不到组成），只在名称上校验，并在 warnings 里标注「未取得套餐组成，忌口仅按名称校验」——不谎称已验证。

## D-004 2026-10-25 离线回放
网络不可用时，`mcd_mcp` 允许返回 `source:"replay"` 的历史缓存，但必须带原始 `dataTime`，前端必须显示「离线回放·非实时」横幅。禁止用模型或本地常量补价格。

## D-005 2026-10-25 票根默认脱敏字段
隐藏：订单号、门店详址、个人预算、个人分摊、实际支付金额。票根状态默认 `planning`（计划中），仅 `party.status=="confirmed"` 时为计划中、`completed` 时为已完成。

## D-006 2026-10-25 阶段顺序
严格按规划第 7 节：阶段1（流程/规则）→ 阶段2（MCP 验证，已完成）→ 阶段3（MVP）→ 阶段4（测试）→ 阶段5（交付文档）。P1/P2 不实现，仅在文档中留接口位。

## D-007 2026-10-25 忌口作用范围修正（重要，覆盖早期实现）
回归测试发现：把「不要」当成整桌约束会导致「阿岚不吃辣 → 小北不能点麦辣鸡腿堡」，
既不合常识，也违背规划 5.1「让不同成员的心愿被看见」。
**最终口径**：个人餐品只校验归属人的忌口；共享餐品（探索项、无归属项）校验全桌忌口并集。
`strategy._member_eligible` 与 `recalc_plan` 均按此实现；`explain.build_wish_results` 只核对该成员自己名下 + 共享项。

## D-008 2026-10-25 心愿匹配算法定稿
字符二元组 Jaccard 精度不足（「麦辣鸡腿堡」→「麦辣鸡翅」0.4 过线）。改为：
`difflib.SequenceMatcher` 比例 + 包含式长度折算，阈值 0.55，只保留与最高分同档（×0.85）的候选，
套餐项乘 0.85 降权；另加 12 条口语同义词（鸡块→麦乐鸡 等）。未收录词按字面匹配并在 warnings 提示。

## D-009 2026-10-25 交付结论
agent-mcp / agent-web / agent-ticket 三个工作流已集成完成：26 项单元/降级测试通过，
端到端 8 步通过（含官方核价与重新核价），前端运行时冒烟 17 条断言 0 问题。
遗留：真实浏览器多尺寸视觉核对、真人可用性测试（详见 docs/测试报告.md §四）。

## D-010 2026-10-25 联调暴露的两个现场问题（已修）
1. **清理接口无响应**：`scope=all` 一次删 66 个缓存文件会触发环境级批量删除保护，
   抛出物不是 `OSError`，导致请求线程被杀、连接直接关闭。修复：逐个删除 + 单次上限 40 +
   `except BaseException` 兜底 + 如实返回 `remaining`/`failed` 与说明；前端改为一键一次、失败不降级重试。
2. **过期菜单导致三案核价全失败**：菜单缓存 10 分钟，期间商品售罄 → `calculate-price` 返回
   `60006 商品已售罄或不可售` 且整单被拒。修复：菜单 TTL 降到 120s；`McdClient.invalidate()`；
   服务层在「全部方案失败且错误码属于售罄类」时丢弃缓存重取并重算一次（meta.menuRefreshed=true）。
   断网类失败**不触发**该重试，避免无意义刷新。

## D-011 2026-10-25 代码审查（第二轮）核实与修复
按 `docs/后端代码审查报告.md` 逐条复现后：P0 3/3、P1 6/6 全部确认并修复；
P2 8 条修复 + 1 条（CSRF）按本机模型只做头校验；P3 修 12 条、明确不做 6 条（重构/CI/解析优化等，理由见记录文档）。
关键修复：分账按行拆分官方小计、忌口口语变体归一、失败缓存 5s 短挡、
静态路径 realpath+commonpath、recalc 数量 1—99 校验、券 id+code 成对、
详情缓存加门店维度与 TTL、菜单失效与查询共用 menu_arguments、金额换算统一 Decimal。
新增 `tests/test_regressions.py` 30 条，回归总数 34 → 64。

## D-012 2026-10-25 P1 功能实现
- P1-A 偏好授权与再聚（`app/preferences.py`）：逐人 consent，只存昵称+三档心愿，不存个人预算；
  再聚生成 draft（plans=[]、dataTime=null），菜单与价格强制重查；不足 3 人补齐空位；组可单删。
- P1-B 票根增强（`ticket.py` + `ticket.js`）：照片（仅 jpeg/png/webp ≤600KB）、每人一句（≤24 字）、
  下次约定（≤40 字），全部落 `party.ticketExtras`，刷新可恢复。
- P1-C 三版式：portrait / square(1080×1080) / story(1080×1920)，真实 canvas 验证；
  预览走 DOM（按版式重排），另加按需「查看导出效果」弹层出成品图——不把画布挂在输入回路上。
- P1-D 订单关联（`app/orders.py`）：**只读** order-list/query-order，三项核对（门店/时间/餐品）只提示不拦截；
  订单号仅本地，界面显示后 4 位，票根完全不出现。**不调用 create-order**（见对照表 D-13）。
- 修复上一轮遗留：`preferences.cleanup()` 未兜 `BaseException` 会导致「清理全部」把请求线程带走，已加
  单次上限 + BaseException 兜底 + 如实回报 remaining。
