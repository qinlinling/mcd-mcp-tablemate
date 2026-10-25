# MCP_INTEGRATION.md — 麦当劳 MCP 集成说明

> 本文说明「麦麦同席」实际使用的麦当劳 MCP Server、Tool 清单、调用流程与业务价值。
> 所有结论来自 2026-10-25 对 `https://mcp.mcd.cn` 的真实联调（脱敏记录见 `docs/MCP联调记录.md`，字段级结论见 `docs/MCP能力矩阵.md`）。

## 一、MCP Server

| 项 | 值 |
|---|---|
| Server | 麦当劳中国 MCP Server（官方开放平台 https://open.mcd.cn/mcp） |
| 端点 | `https://mcp.mcd.cn`（JSON-RPC over HTTP） |
| 鉴权 | `Authorization: Bearer <MCP_TOKEN>` |
| Token 来源 | 环境变量 `MCD_TOKEN`（或本地 `~/.workbuddy/mcp.json`），**不写入仓库** |
| 客户端实现 | Python 3 标准库 `urllib`，单次请求超时 30s，无第三方依赖 |
| 配置示例 | `mcp-config.example.json`（仅环境变量占位符） |

## 二、Tool 清单

### 实际调用（7 个，全部为只读工具）

| Tool | 用途 | 调用时机 | 关键参数 |
|---|---|---|---|
| `query-nearby-stores` | 按城市 + 关键词找门店 | 步骤 1：确定门店 | `beType`, `searchType=2`, `city`, `keyword` |
| `query-meals` | 门店当前可售菜单 | 步骤 2：取菜单 | `storeCode`, `orderType=1`, `beType` |
| `query-meal-detail` | 套餐组成 / 特调项 | 步骤 3：忌口校验 | `code`, `storeCode`, `orderType`, `beType` |
| `query-store-coupons` | 门店可用券及适用商品 | 步骤 4：用券试算 | `storeCode`, `orderType`, `beType` |
| `calculate-price` | **官方核价（唯一价格来源）** | 步骤 5：三案核价与每次调整后复算 | `items[]`, `storeCode`, `orderType`, `beType` |
| `now-time-info` | 官方时间 | 健康探测与数据时点对齐 | — |
| `query-my-account` | 会员积分（凭证旁证） | 健康探测 | — |

### 明确不调用（只读优先原则）

| Tool | 不调用原因 |
|---|---|
| `create-order` | 会产生真实订单与扣款，属变更类操作；本项目 P0 只形成点餐清单 |
| `auto-bind-coupons` | 领券属账户变更，即使用户有券也只在核价时试算，不代为领取 |
| `mall-create-order` / `cancel-order` 等变更类工具 | 同上，MVP 不做任何账户与资金变更 |

> 只读优先是硬约束：全部价格、优惠、在售状态结论均来自官方接口实时返回，**不由模型估算或补全**；接口失败时展示「未知 / 不可用」并给降级路径。

## 三、调用流程

```
创建聚餐（事由/人数/共同预算/成员三档心愿）
        │
        ▼
① query-nearby-stores ──► 选门店（beType=1 到店自取 / 5 得来速）
        │
        ▼
② query-meals ──► 当前菜单（116 项，分类表 + 商品字典两段式结构）
        │
        ▼
③ query-meal-detail ──► 套餐默认组成（rounds[].choices[isDefault=1]）
        │                    └─ 忌口校验唯一依据：官方无辣度/过敏原结构化字段，
        │                       按「餐品名 + 组成名」做关键词匹配，不做过敏原安全承诺
        ▼
④ query-store-coupons ──► 适用商品清单（券↔商品匹配）
        │
        ▼
⑤ calculate-price ──► 三套方案官方核价（金额单位为分）
        │   ├─ 人人有期待：优先满足每位成员「必须要」
        │   ├─ 整单更划算：满足硬约束后优化整单支出
        │   └─ 一起尝点新：保留核心心愿并加入探索项
        ▼
方案对比（餐品归属 / 心愿满足 / 金额 / 取舍说明 / 分账校验）
        │
        ▼
用户确认最终方案（MVP 仅保存为聚餐方案，不下单、不支付）
        │
        ▼
同桌食光票根（默认脱敏：无订单号、无门店详址、无个人预算）
```

### 工程实现要点（与接口特性直接相关）

1. **返回体前缀解析**：MCP 工具返回体前拼有 markdown 说明，用 `json.JSONDecoder().raw_decode` 定位首个 JSON 主体，不靠正则猜。
2. **金额单位**：菜单价为「元」字符串（如 `"33.5"`），适配层 ×100 转「分」；`calculate-price` 直接返回分，全链路内部分账、展示均以分为 int，避免浮点误差。
3. **并发与缓存**：`query-meal-detail` 单次约 0.43s，116 个商品串行需 40s+，实现为 8 路并发 + 6h 缓存；菜单缓存 2 分钟；`calculate-price` **不缓存**，改数量/换券实时重算。
4. **降级矩阵**：网络失败有缓存→标注 `replay` + 原始数据时点；无缓存→`unavailable`；业务拒绝（如券不适用 `code=600012`）保持 `live` 并原样透出 `code/message`，不与网络故障混淆；售罄类错误（`60006`）主动失效菜单缓存重取重算一次。
5. **菜单 ≠ 可核价集合**：券适用商品可能不在本店菜单中，选品只从菜单取，避免推荐用户点不到的商品。

## 四、业务价值

| MCP 能力 | 在本项目中解决的问题 |
|---|---|
| 真实门店 + 实时菜单 | 方案基于「今天这家店真实在售」生成，而非静态菜单记忆 |
| `query-meal-detail` 套餐组成 | 「不吃辣」等忌口从口头叮嘱变为可校验的硬约束，且不突破低价诱惑 |
| `calculate-price` 官方核价 | 多人拼单最关心的「到底多少钱」由官方口径给出，分摊总额与整单恒等可验证 |
| `query-store-coupons` 适用商品 | 优惠只在「商品在菜单内且券匹配」时启用，优惠条件可解释、可追溯 |
| 只读优先 + 明确不调用变更类工具 | 聚餐协商场景下避免误下单、误领券，保护用户账户与资金安全 |

**差异化价值**：市面作品多用 MCP 做「单人省钱/比价」，本项目把同一批只读能力用于**多人协作协商**——让每位成员的心愿被看见、每套方案的取舍可解释、每次相聚有票根留存。核价、忌口、优惠全部来自官方接口，展示金额与官方结论严格一致。

## 五、复现方式

```bash
export MCD_TOKEN=<你的 MCP Token>     # 或按 mcp-config.example.json 配置
cd mmtx
python run.py 8848                    # 启动（零第三方依赖）
# 浏览器访问 http://127.0.0.1:8848
python tests/e2e_smoke.py             # 端到端联调：打印每步真实返回值
python -m unittest tests.test_degrade -v   # 断网回放 / 核价失败 / 券不适用降级
```

运行时也可访问 `GET /api/capability` 获取实时能力矩阵（含探测时间 `probedAt`）。
