# MCP 能力矩阵与字段限制清单

对应规划：阶段 2（C01—C04）、第 9.1 节、第 12.2 节。
实测环境：`https://mcp.mcd.cn`，2026-10-25 14:12—14:35，门店 `1450713`（麦当劳上海黄浦华旭国际大厦餐厅），到店自取 `beType=1 / orderType=1`。
运行时可通过 `GET /api/capability` 取到同一份矩阵（含 `probedAt`）。

## 一、工具使用矩阵

| 工具 | 用途 | 本项目使用 | 关键参数 | 备注 |
|---|---|---|---|---|
| `query-nearby-stores` | 按城市+关键词找门店 | ✅ 步骤 1 | `beType=1/5`, `searchType=2`, `city`, `keyword` | `searchType=2` 才是按位置搜；默认 1 是搜收藏 |
| `query-meals` | 门店可售菜单 | ✅ 取菜单 | `storeCode`, `orderType=1`, `beType=1` | `data.categories` 是展示顺序，`data.meals` 是 `{productCode: {...}}` 字典 |
| `query-meal-detail` | 套餐组成 / 特调项 | ✅ 忌口校验 | `code`, `storeCode`, `orderType`, `beType` | 单次约 0.43s，必须并发 + 缓存 |
| `query-store-coupons` | 门店可用券及适用商品 | ✅ 用券试算 | `storeCode`, `orderType`, `beType` | 只给适用商品，不给面额 |
| `calculate-price` | 官方核价 | ✅ 唯一价格来源 | `items[]`, `storeCode`, `orderType`, `beType` | 金额单位**分**；`productCode+quantity` 即可 |
| `now-time-info` | 官方时间 | ✅ 健康探测 | — | 用于数据时点对齐 |
| `query-my-account` | 会员积分 | ✅ 凭证旁证 | — | 只取积分，`accountId` 不外传 |
| `create-order` / `auto-bind-coupons` / `mall-create-order` | 下单、领券、积分兑换 | ❌ **不调用** | — | 变更类操作，P0 明确不做 |

## 二、字段可用性（决定产品能做到什么）

| 工具 | 字段 | 可用 | 对产品的影响 |
|---|---|---|---|
| `query-meals` | `data.categories[].meals[].code` | ✅ | 只给 code + tags，商品主体要去 `data.meals` 查 |
| `query-meals` | `data.meals{code}.currentPrice` | ✅ | **元**字符串（`"33.5"`，可能为空串）→ 适配层 ×100 转分 |
| `query-meals` | `data.meals{code}.originalPrice` / `image` | ✅ | 用于展示划线价与餐盘图 |
| `query-meals` | 套餐组成、单品规格 | ❌ | 必须另调 `query-meal-detail`，这是忌口校验的唯一依据 |
| `query-meals` | 辣度 / 口味 / 过敏原结构化字段 | ❌ | **忌口只能按「餐品名 + 套餐组成名」做关键词匹配**，因此产品不做过敏原安全承诺 |
| `query-meal-detail` | `data.rounds[].choices[].isDefault` | ✅ | `isDefault=1` 即默认组成，用它还原真实套餐 |
| `query-meal-detail` | `supportModify` | ✅ | 顶层可能缺，需回退到 `choice.supportModify` |
| `calculate-price` | `data.price` / `originalPrice` / `discount` | ✅ | 单位分，直接展示；不要再换算 |
| `calculate-price` | `data.productList[].subtotal` | ✅ | 分账按官方分项金额算，避免与整单对不上 |
| `query-store-coupons` | `data[].products[]` | ✅ | 券 ↔ 商品匹配 |
| `query-store-coupons` | 券面额 / 折扣率 | ❌ | 优惠额必须走 `calculate-price` 才能拿到 |
| `query-nearby-stores` | 经度 / 纬度 | ❌ | 实测恒为 `0.0`，无法打点，只能用 `address` 文本 + `distance` |
| `query-my-account` | 会员等级 | ❌ | 只返回积分字段 |

## 三、能力限制（已在代码中处理）

1. `query-meal-detail` 单次 0.43s：116 个商品串行要 40s+，实现为 8 路并发 + 6h 缓存，并按「心愿匹配项 → 便宜主餐 → 新品」截取 45 个候选。
2. **菜单 ≠ 可核价集合**：券适用商品 `9900016523`（龙焰鸡腿堡两件套）不在本店 `query-meals` 列表中，但 `calculate-price` 可正常核价（3400 → 2048 分）。
   → 选品只从菜单取，券抵扣只在「商品在菜单内且券匹配」时启用，避免给用户推一个他看不到、点不了的商品。
3. **券不适用是业务结论，不是故障**：`success=false`、`code=600012`、`message=促销规则不支持该商品`。降级文案必须区分这类业务拒绝与网络失败。
4. `calculate-price` **不缓存**：改数量/换券必须实时重算，否则展示的金额不可信。
4.1 菜单缓存只留 **2 分钟**，并在核价因「售罄/不可售」（如 `60006`）失败时主动失效重取——
     实测缓存 10 分钟会让三套方案一起核价失败（菜单里还有、门店已经卖完了）。
5. 菜单价可能是空串 → 按 0 分处理，展示层隐藏 0 元价格，避免出现「赠品价」误导。
6. `beType=1` 不要传 `beCode`（传了报错）；`beType=5/2/6` 才需要 `beCode`。
7. 门店经纬度恒为 0 → 不做地图与距离排序，只展示接口返回的 `distance`。

## 三之二、取餐方式实测（2026-10-25 17:33 补测）

| beType | 门店查询是否返回 beCode | 菜单 | 核价 | 结论 |
|---|---|---|---|---|
| 1 到店自取 | 否（也不需要） | ✅ 116 项 | ✅ | 已支持 |
| 5 得来速 | **是**（如 `145021441`） | ✅ 125 项 | ✅ 三套方案全部成功 | 已支持 |
| 2 麦乐送 / 6 团餐 | 需 `delivery-query-stores` | 未验证 | 未验证 | 未开放 |

要点：`beCode` 必须与 `storeCode` 配对下发，且只在 beType=2/5/6 时携带；到店自取传了会报错。
`select` 层面的实现见 `mcd_mcp.menu_arguments()`。

## 四、异常处理矩阵（C04）

| 场景 | 判定依据 | 系统行为 |
|---|---|---|
| 网络异常 / 超时（30s） | `urllib` 异常 | 有历史缓存 → `source=replay` + 原始 `dataTime` + 页面黄色横幅；无缓存 → `source=unavailable`、`ok=false` |
| 返回体不可解析 | 找不到 JSON 主体 | 同上，按 `PARSE` 处理，不猜内容 |
| HTTP 4xx/5xx | 状态码 | 按网络失败处理，不重试到死（单次请求即降级） |
| 业务失败 | `success=false` | `ok=false` + 原始 `code/message`，`source` 保持 `live` |
| 券不匹配 | `code=600012` | 取舍里写明「试算被官方拒绝：促销规则不支持该商品」，方案继续用无券价 |
| 商品不在菜单 | 菜单里查不到 code | 不允许进入方案；手动复算时报「未知餐品」 |
| 菜单有、门店已售罄 | `calculate-price` 返回 `60006` / 「商品已售罄或不可售」 | 三案全部失败且错误码属于售罄类时：丢弃菜单缓存 → 重取菜单 → 自动重算一次，并在 meta 里标记 `menuRefreshed`；仍失败才展示失败卡 |
| token 缺失/失效 | 403 或配置缺失 | `/api/health` 报不可用，页面顶部横幅提示，方案生成中断并给原因 |

## 五、与规划的差异说明

规划 9.1 提到「P1 所需的订单查询或创建订单权限」——本项目**未验证也未使用**创建订单能力，
因此 P1 的下单闭环没有写入任何承诺。规划提到的外送（麦乐送）与团餐场景同样未纳入 MVP，
理由见 `实现与规划对照.md` 的偏离项 D-3。
