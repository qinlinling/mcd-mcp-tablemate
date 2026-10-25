# 冻结接口契约（v1，禁止单方面修改）

> 依据《麦麦同席-项目规划.md》第 4/5/8 节。任何变更必须由 orchestrator 写入 `decisions.md` 后广播。

## 0. 技术选型（项目内已冻结）

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Python 3 标准库（无第三方依赖） | 与仓库既有 `mcd-mcp/mcd.py` 一致，新环境可直接跑 |
| 后端 | `http.server.ThreadingHTTPServer` 自建 REST | 无框架依赖，便于评委本地复现 |
| 前端 | 原生 HTML/CSS/JS，无构建步骤 | 双击即开，减少环境风险 |
| MCP 接入 | JSON-RPC over HTTP，直连 `https://mcp.mcd.cn` | 已实测可用，token 复用 `~/.workbuddy/mcp.json` |
| 存储 | 本地 JSON 文件 `mmtx/.data/` | 符合「本地数据清理」要求，无云依赖 |
| 金额 | 内部一律「分」int；展示层转元 | 避免浮点误差，与官方接口一致 |

## 1. 目录与归属

```
mmtx/
  run.py                     [orchestrator]  启动入口
  app/rules.py               [orchestrator]  数据模型/校验/忌口字典
  app/strategy.py            [orchestrator]  三类方案生成
  app/allocate.py            [orchestrator]  分账与归属
  app/explain.py             [orchestrator]  解释文案
  app/server.py              [orchestrator]  REST API
  app/store.py               [orchestrator]  本地持久化
  app/mcd_mcp.py             [agent-mcp]     MCP 客户端/缓存/降级
  app/ticket.py              [agent-ticket]  票根字段映射与脱敏
  web/index.html             [agent-web]
  web/styles.css             [agent-web]
  web/app.js                 [agent-web]
  web/ticket.js              [agent-ticket]
  tests/*.py                 [orchestrator]
  docs/*.md                  [orchestrator]
```

**写入纪律**：每个文件只有一个 owner。跨文件需求通过 orchestrator 转达。

## 2. 核心数据结构

### 2.1 Party（聚餐）

```jsonc
{
  "id": "p_20261025_7f3a",
  "title": "周五项目庆功",          // 聚餐名称/事由，1-30 字
  "memberCount": 4,                // 3-8
  "store": {
    "storeCode": "1450713",
    "storeName": "麦当劳上海黄浦华旭国际大厦餐厅",
    "beType": 1,                   // 1=到店自取, 5=得来速
    "orderType": 1,                // 由 beType 推导：1/5 → 1
    "beCode": null,                // beType=5 时必填
    "reservationDate": "2026-10-25 18:30"  // 可空
  },
  "budgetTotal": 200.0,            // 共同预算（元），>0
  "status": "draft",               // draft | planned | confirmed | completed
  "members": [ Member, ... ],
  "confirmedPlanId": null,         // "A" | "B" | "C"
  "confirmedAt": null,
  "dataTime": "2026-10-25 14:20:00",  // 最近一次 MCP 数据时点
  "dataSource": "live",            // live | replay | unavailable
  "createdAt": "2026-10-25T14:20:00+08:00"
}
```

### 2.2 Member（成员）

```jsonc
{
  "id": "m1",
  "nickname": "小A",               // 1-12 字，允许重复但 id 唯一
  "budget": 50.0,                  // 个人预算（元）| null=未填
  "must": ["麦辣鸡腿堡"],           // 「必须要」，0-3 条
  "nice": ["薯条"],                // 「最好有」，0-3 条
  "never": ["辣"]                  // 「不要」硬约束，0-3 条
}
```

### 2.3 MenuItem（归一化菜单项，由 mcd_mcp 产出）

```jsonc
{
  "productCode": "9900005456",
  "name": "麦辣鸡腿汉堡三件套",
  "category": "精选单人餐",
  "priceCents": 3350,              // 官方 currentPrice × 100（int）
  "originalPriceCents": 4600,
  "image": "https://...",
  "tags": ["全球爆款"],
  "novelty": true,                 // 由 tags 含「上新/限时/新品/回归/新」判定
  "combo": true,                   // 名称含 套餐/件套/组合
  "components": ["麦辣鸡腿汉堡", "中薯条", "可乐中杯"]  // 来自 query-meal-detail，缺详情时为空数组
}
```

### 2.4 Plan（候选方案）

```jsonc
{
  "planId": "A",                   // A|B|C
  "strategy": "balanced",          // balanced | value | explore
  "name": "人人有期待",
  "subtitle": "优先照顾每位成员的核心心愿",
  "items": [
    {
      "productCode": "9900005456",
      "name": "麦辣鸡腿汉堡三件套",
      "quantity": 1,
      "unitPriceCents": 3350,
      "assigneeId": "m1",          // 归属成员；共享项为 null
      "shared": false,
      "novelty": false,
      "components": ["..."]
    }
  ],
  "pricing": {
    "ok": true,
    "source": "official",          // official | unavailable
    "originalTotalCents": 10250,
    "totalCents": 10250,
    "discountCents": 0,
    "coupon": null,                // {"couponId","title","couponCode"}
    "quotedAt": "2026-10-25 14:22:10",
    "traceId": "1744a378...",
    "error": null                  // {"code":"600012","message":"促销规则不支持该商品"}
  },
  "allocation": [ Alloc, ... ],    // 见 2.5
  "wishResults": { "m1": WishResult, ... },  // 见 2.6
  "tradeoffs": [ {"type": "price|wish|budget|coupon|converged|constraint", "text": "..."} ],
  "warnings": ["..."],
  "convergedWith": null            // null | "B" | "A,C"
}
```

### 2.5 Alloc（分账）

```jsonc
{
  "memberId": "m1",
  "nickname": "小A",
  "itemsSubtotalCents": 3350,      // 归属该成员的餐品小计（不含共享分摊）
  "sharedShareCents": 0,           // 共享项按人数均摊部分
  "discountShareCents": 0,         // 优惠按占比分摊（负数或 0）
  "shareCents": 3350,              // 实付分摊 = subtotal + shared - discount
  "personalBudget": 50.0,
  "overBudget": false
}
```
**不变量**：`sum(shareCents) == pricing.totalCents`（核对失败时 error 记入 warnings）。

### 2.6 WishResult

```jsonc
{
  "must": [{"wish": "麦辣鸡腿堡", "status": "satisfied|unmet|adjusted",
            "byProduct": "麦辣鸡腿汉堡三件套", "reason": "..."}],
  "nice": [{"wish": "薯条", "status": "satisfied|unmet", "byProduct": "...", "reason": "..."}],
  "never": [{"wish": "辣", "status": "respected|violated", "reason": "整单已排除含「辣」餐品"}]
}
```

## 3. MCP 适配层（agent-mcp 交付）

文件：`app/mcd_mcp.py`。全部函数以「分」为金额单位，返回 dict，不抛异常（异常转为 `ok:false`）。

```python
class McdClient:
    def __init__(self, token: str | None = None, endpoint: str = "https://mcp.mcd.cn",
                 cache_dir: str | None = None) -> None: ...

    def call(self, tool: str, arguments: dict) -> dict:
        """底层 JSON-RPC。返回 {"ok": bool, "data": Any, "error": {"code","message"} | None,
        "traceId": str | None, "dataTime": str | None, "source": "live|replay|unavailable"}"""

    def health(self) -> dict:
        """{"ok","latencyMs","dataTime","accountHint"}，用于 /api/health"""

    def query_stores(self, city: str, keyword: str, be_type: int = 1) -> dict:
        """{"ok","stores":[{"storeCode","storeName","address","distance","reservation","beCode"}],
            "error","source","dataTime"}"""

    def query_menu(self, store_code: str, be_type: int = 1) -> dict:
        """{"ok","items":[MenuItem...],"error","source","dataTime","traceId"}"""

    def meal_detail(self, store_code: str, code: str, be_type: int = 1) -> dict:
        """{"ok","detail":{...},"components":["..."],"supportModify":bool,"error","source"}"""

    def prefetch_details(self, store_code: str, codes: list[str], be_type: int = 1,
                         workers: int = 8) -> dict[str, dict]:
        """并发预取，返回 {code: meal_detail 结果}。单条失败不影响整体。"""

    def store_coupons(self, store_code: str, be_type: int = 1) -> dict:
        """{"ok","coupons":[{"couponId","couponCode","title","tradeDateTime",
            "products":[{"productCode","productName"}]}],"error","source","dataTime"}"""

    def calculate_price(self, store_code: str, items: list[dict], be_type: int = 1,
                        reservation_date: str | None = None) -> dict:
        """items: [{"productCode","quantity","couponId"?,"couponCode"?,"roundList"?}]
        返回 {"ok","originalTotalCents","totalCents","discountCents",
              "productList":[{"productCode","productName","quantity","subtotalCents","originalSubtotalCents"}],
              "error":{"code","message"}|None,"traceId","dataTime","source"}"""

    def capability_matrix(self) -> dict:
        """静态能力矩阵 + 实测时点，/api/capability 直接透出"""
```

**实现要求**：
1. token 读取优先级：`MCD_TOKEN` 环境变量 → `~/.workbuddy/mcp.json` 的 `mcpServers.mcd-mcp.headers.Authorization`（去掉 `Bearer ` 前缀后复用，请求时补 `Bearer `）。
2. 工具返回体前面可能拼一大段 markdown 说明，必须在文本中定位第一个可解析的 JSON 对象（提示：找 `{"success"` 或 `{"code"` 后用 `json.JSONDecoder().raw_decode`），解析失败再抛 `ok:false`。
3. 业务失败：HTTP 200 但 `success:false` → `ok:false`，`error={"code": str(code), "message": message}`。
4. 缓存：`.cache/mcd/{tool}_{sha1(args)[:16]}.json`，TTL：stores 5min、menu **2min**（菜单变动会导致核价整单失败）、detail 6h、coupons 5min、price 0（不缓存）。另需提供 `invalidate(tool, arguments) -> bool` 删除单条缓存。命中缓存时 `source:"live"` 且 `dataTime` 保留原始时点。
5. 降级：网络异常/超时（默认 30s）→ 若有历史缓存则返回 `source:"replay"` + 原始 `dataTime`，**绝不伪造数据**；无缓存则 `source:"unavailable"`、`ok:false`。
6. 并发：`prefetch_details` 用 `concurrent.futures.ThreadPoolExecutor`，单条异常转 dict。
7. 单价换算：菜单 `currentPrice` 是「元」字符串（如 `"33.5"`）；`calculate-price` 返回「分」。转换必须显式且加注释。

## 4. 票根层（agent-ticket 交付）

### 4.1 `app/ticket.py`

```python
def build_ticket(party: dict, plan: dict, options: dict | None = None) -> dict
```
输入 party（2.1）+ plan（2.4，已确认为最终方案）+ options：

```jsonc
{"nicknames": {"m1": "小A"},          // 用户改写的昵称，可选
 "visibleFields": ["title","date","members","items","wishes","themeLine","status"],
 "themeLine": "又一次，把周五点亮了",  // 用户输入，可空 → 用默认模板
 "maxItems": 3}
```

输出：

```jsonc
{
  "ticketId": "t_p_20261025_7f3a_A",
  "partyId": "...",
  "status": "planning",              // planning | completed
  "statusLabel": "计划中",
  "title": "周五项目庆功",
  "date": "2026-10-25",
  "members": ["小A", "小B"],
  "items": [{"name": "麦辣鸡腿汉堡三件套", "quantity": 1, "assignee": "小A"}],
  "wishes": [{"member": "小A", "wish": "麦辣鸡腿堡", "byProduct": "麦辣鸡腿汉堡三件套"}],
  "themeLine": "...",
  "fieldsVisible": { "title": true, ... },
  "hiddenFields": ["订单号", "门店详址", "个人预算", "个人分摊", "实际支付金额"],
  "dataTime": "...",
  "dataSource": "live",
  "generatedAt": "..."
}
```
**原则**：只从 party/plan 取事实字段；`status=="confirmed"` 才输出 `planning`；`completed` 才输出 `completed`；默认隐藏订单号/门店详址/个人预算/分摊/总额，`visibleFields` 控制渲染。

### 4.1b 票根新增字段（P1）

```jsonc
"photo": "data:image/jpeg;base64,…" | null,   // 仅 jpeg/png/webp，服务端 ≤600KB
"notes": [{"member": "小北", "note": "今晚很尽兴"}],   // 每人 1 句，≤24 字，≤8 条
"nextMeet": "下周五同一家" | null,             // ≤40 字
"fieldsVisible": {..., "photo": true, "notes": true, "nextMeet": true}
```

### 4.2 `web/ticket.js`

```js
window.TicketRenderer = {
  render(container, ticket, opts) {},        // 渲染 DOM 票根（含撕裂线、纸张纹理、手写短句）
  exportPNG(ticket, opts) {},                // 返回 Promise<Blob>，1080 宽、2x 像素比
  downloadPNG(ticket, filename) {}
};
```
必须纯前端 canvas 绘制（无外部库、无网络字体），字体回退 `"PingFang SC","Microsoft YaHei",sans-serif`。

## 5. REST API（orchestrator 实现，agent-web 按此联调）

所有响应 `{"ok": true, ...}` 或 `{"ok": false, "error": {"code","message"}}`。

| 方法 | 路径 | 请求 | 响应要点 |
|---|---|---|---|
| GET | `/api/health` | — | `{"ok":bool,"latencyMs":int,"dataTime":"...","accountHint":{...}\|null}`（扁平结构，实现为准） |
| GET | `/api/capability` | — | `{"ok":true,"matrix":{...},"probedAt":"..."}` |
| POST | `/api/stores` | `{"city":"上海","keyword":"人民广场","beType":1}` | `{"ok":true,"stores":[...],"source","dataTime"}` |
| GET | `/api/menu?storeCode=&beType=1` | — | `{"ok":true,"items":[MenuItem],"source","dataTime"}` |
| POST | `/api/party` | Party 字段（title/memberCount/store/budgetTotal）+ `members` 可选 | `{"ok":true,"party":Party}` |
| GET | `/api/party/{id}` | — | `{"ok":true,"party":Party}` |
| PUT | `/api/party/{id}` | 同上任意字段 | `{"ok":true,"party":Party}` |
| POST | `/api/party/{id}/plans` | `{}` | `{"ok":true,"plans":[Plan],"meta":{"dataTime","dataSource","warnings":[],"wishResolution":{}}}` |
| POST | `/api/party/{id}/recalc` | `{"items":[{"productCode","quantity","assigneeId"}],"couponId":null,"planId":"A"}` | `{"ok":true,"plan":Plan}` |
| POST | `/api/party/{id}/confirm` | `{"planId":"A"}` | `{"ok":true,"party":Party}` |
| POST | `/api/party/{id}/complete` | `{"completed":true}` | `{"ok":true,"party":Party}` |
| GET | `/api/party/{id}/ticket` | — | `{"ok":true,"ticket":Ticket}` |
| POST | `/api/party/{id}/ticket` | options（4.1）+ `photo`/`notes{memberId:text}`/`nextMeet`/`persist` | `{"ok":true,"ticket":Ticket}`；增强项落库到 `party.ticketExtras` |
| GET | `/api/parties` | — | `{"ok":true,"parties":[{"id","title","status","createdAt"}]}` |
| POST | `/api/party/{id}/preferences` | `{"members":[{"memberId","consent"}]}` | `{"ok":true,"groupId","saved":[],"skipped":[],"notice"}`；无授权 → `NO_CONSENT` |
| GET | `/api/preferences` | — | `{"ok":true,"groups":[{"groupId","title","createdAt","memberCount","nicknames","wishCount"}]}` |
| POST | `/api/preferences/{gid}/revisit` | `{"store":{…},"budgetTotal":150,"title"?}` | `{"ok":true,"party":{draft,plans=[],dataTime=null},"notice"}` |
| DELETE | `/api/preferences/{gid}` | — | `{"ok":true,"notice"}` |
| GET | `/api/orders` | — | `{"ok":true,"orders":[{"orderId","status","createTime","storeCode","storeName","items","amountCents"}]}`（只读） |
| POST | `/api/party/{id}/link-order` | `{"orderId":"…"}` | `{"ok":true,"linkedOrder","diagnostics":{…},"notice"}`；订单号绝不进票根 |
| POST | `/api/cleanup` | `{"scope":"parties|all"}` | `{"ok":true,"removed":int,"scope":str}`；有文件删不掉时追加 `failed:int` 与 `note:str` |

前端只依赖上表；**不得**自行拼 MCP 调用。

## 6. 状态机

`draft` --(生成方案)--> `planned` --(确认方案)--> `confirmed` --(主动标记完成)--> `completed`
任意状态可继续修改成员心愿并重新生成方案 → 回到 `planned`（旧的核价结果必须作废）。
