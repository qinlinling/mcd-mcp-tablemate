# MCP 联调记录（脱敏）

对应规划：C02—C04、12.2「保留脱敏联调证据」、E05。
说明：本文只记录与产品决策相关的字段与金额，已剔除 token、账户标识、完整 traceId（仅保留前 8 位）。
所有记录均可由 `python tests/e2e_smoke.py` 重新生成。

## 0. 环境

| 项 | 值 |
|---|---|
| 端点 | `https://mcp.mcd.cn`（JSON-RPC over HTTP，需 `Authorization: Bearer <token>`） |
| 客户端 | Python 3.13 标准库 `urllib`，单次超时 30s |
| token 来源 | 环境变量 `MCD_TOKEN`，或 `~/.workbuddy/mcp.json` 的 `mcpServers.mcd-mcp.headers.Authorization` |
| 门店 | `1450713` 麦当劳上海黄浦华旭国际大厦餐厅（上海 · 人民广场，到店自取） |
| 抓取时间 | 2026-10-25 14:12—14:35（GMT+8） |

## 1. 凭证与连通性

```
now-time-info      → success=true, datetime=2026-10-25 14:12:11, 延迟约 400ms
query-my-account   → success=true, availablePoint=18.9, accumulativePoint=41.4, currency=麦享会积分
```
→ 结论：token 有效，只读链路可用。**accountId 等账户标识不入库、不写日志。**

## 2. 门店查询

请求：`{"beType":1,"searchType":2,"city":"上海","keyword":"人民广场"}`

| storeCode | 门店名 | 地址 | distance | reservation |
|---|---|---|---|---|
| 1450713 | 麦当劳上海黄浦华旭国际大厦餐厅 | 南京东路街道西藏中路336号 | 144 | true |
| 1450441 | 麦当劳上海福州路餐厅 | 福州路666号 | 235 | true |
| 1450056 | 麦当劳上海食品一店餐厅 | 南京东路720号 | 355 | true |

观察：`longitude/latitude` 全部为 `0.0` → 无法打点，只能展示 `distance` 文本。
`beType=1` 时**不返回 `beCode`**（只有得来速/外送才需要），因此本 MVP 只开放到店自取。

## 3. 菜单查询

请求：`{"storeCode":"1450713","orderType":1,"beType":1}`

- 返回 15 个分类、129 条分类内条目，去重后 **116 个商品**（同一商品会出现在「人气热卖」等多个分类）。
- 结构：`data.categories[].meals[]` 只给 `code` + `tags`；商品主体在 `data.meals{code}`：
  `name / image / currentPrice / originalPrice / canWithOrder`。
- 价格是**元字符串**：如 `9900005456` 麦辣鸡腿汉堡三件套 `currentPrice="33.5"`、`originalPrice="46"`。
- 忌口相关的结构化字段（辣度、过敏原）**不存在**。

## 4. 餐品详情（忌口校验依据）

请求：`{"storeCode":"1450713","orderType":1,"beType":1,"code":"9900005456"}`

```
name = 麦辣鸡腿汉堡三件套
rounds[0].choices[isDefault=1].name = 麦辣鸡腿汉堡
rounds[1].choices[isDefault=1].name = 中薯条
rounds[2].choices[isDefault=1].name = 可乐中杯
```
→ 「不吃辣」正是靠组成里的「麦辣」命中。单次耗时 0.43s（5 次采样均值），已并发预取 + 缓存。

## 5. 官方核价

请求（无券）：
```json
{"storeCode":"1450713","orderType":1,"beType":1,
 "items":[{"productCode":"9900005456","quantity":1},{"productCode":"9900004064","quantity":2}]}
```
返回：`originalPrice=10250, discount=0, price=10250`，`productList` 分项 3350 / 6900。
→ 单位是**分**；`productCode+quantity` 即可核价，不需要 `roundList`。

## 6. 优惠券

`query-store-coupons` (storeCode=1450713)：返回 1 张可用券

| couponId（前缀） | 券名 | 有效期 | 适用商品 |
|---|---|---|---|
| 5FBE3138… | 1024"码"力翻倍 | 2026-10-24 ~ 10-30 | 9900016523 龙焰鸡腿堡两件套 |

用券核价（该券唯一适用商品）：
```
items=[{productCode:9900016523, quantity:1, couponId:…, couponCode:…}]
→ originalPrice=3400, discount=1352, price=2048
```
券挂到不适用商品上：
```
items=[{productCode:9900005456, quantity:1, couponId:…, couponCode:…}]
→ success=false, code=600012, message="促销规则不支持该商品"
```
→ 关键结论有两条：
1. 优惠额只能由官方核价给出，作品不自行计算；
2. **「券不适用」是业务结论，`source` 必须保持 live，不能被当成网络故障去回放缓存。**

## 7. 菜单与核价集合不一致（重要）

券适用商品 `9900016523` 在 `query-meals` 结果中**不存在**（该店当前不展示），但 `calculate-price` 仍能核价。
→ 选品一律只从菜单取；券抵扣只在「商品在菜单内 + 券匹配」时启用。
这样用户看到的每一件餐品都能在本店买到，不会出现「推荐了一个点不到的商品」。

## 8. 端到端联调（2026-10-25 14:33 记录）

标准演示场景（4 人，共同预算 ¥200）：

| 环节 | 结果 |
|---|---|
| 门店查询 | 5 家，快照 14:25:35 |
| 菜单 | 可售 91 款（忌口并集排除 25 款） |
| 生成三案耗时 | 2.12s（详情命中缓存）/ 4.95s（冷缓存） |
| 人人有期待 | ¥113.50，4 条「必须要」全满足 |
| 整单更划算 | ¥77.50 |
| 一起尝点新 | ¥93.50（官方优惠 ¥4.00，原价 ¥97.50） |
| 分账校验 | 三套方案 `Σ应付 == 整单` 均通过 |
| 手动加 1 份可乐复算 | ¥77.50 → ¥87.00（+¥9.50，等于菜单价），新核价时点 14:33:17 |
| 把「麦辣鸡腿堡四件套」挂给不吃辣的阿岚 | 复算被拒绝（符合预期） |
| 票根 | 状态「计划中」，输出中无金额/门店详址/订单号 |

## 9. 复现方式

```bash
cd mmtx
python run.py 8848                 # 另开一个终端
python tests/e2e_smoke.py          # 会打印上述每一步的真实返回值
python -m unittest tests.test_degrade -v   # 断网回放 / 核价失败 / 券不适用
```
