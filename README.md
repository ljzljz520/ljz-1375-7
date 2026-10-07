# 窑火资料馆 · 陶瓷窑火资料与预约站

零第三方依赖（Python 3.11 标准库）：SQLite 持久化 + 静态公开站发布管线 + 工坊预约。

## 运行

```bash
python3 run.py            # 首次启动自动灌入演示数据并发布，监听 8000 端口
PORT=8000 ADMIN_TOKEN=secret KILN_DB=kiln.db python3 run.py
python3 -m unittest discover -s tests -v   # 18 个验收测试
```

公开站：`http://127.0.0.1:8000/index.html`（由 `public/current` 符号链接指向最新成功构建）。

## 架构

```
kiln/
  db.py            SQLite：业务表 + entity_versions 全量历史快照 + approvals 批准记录
  periods.py       年代区间与不确定度：相交仅"可能同期"，永不输出"同代确证"
  inheritance.py   通用工艺卡 vs 展品特定说明：局部例外优先，全局修改不覆盖例外
  reviews.py       材料卡更新/删除 → 沿引用图(材料→工序→展品)生成待复核文章，
                   历史记载一律不自动改写
  reservations.py  BEGIN IMMEDIATE 事务内原子占座；候补按序递补；回执签发/补发；
                   reservation_events 记录明确时序
  publish.py       仅从批准版本构建 → 临时目录 → 断链校验 → 原子切换 current；
                   失败则旧版本原样保留，绝不混入半版内容
  server.py        公开 API + 后台 API(X-Admin-Token) + 静态站服务
```

## 关键设计

| 需求 | 实现 |
|---|---|
| 年代区间+不确定度 | `era_start/era_end/era_uncertainty`；`era_relation` 只返回 `overlap_possible`/`disjoint`，页面明示"不构成同代确证" |
| 工序材料更新 | `reviews.fanout_material_change` 沿 `process_material_refs→exhibit_processes/overrides` 列待复核文章；材料卡软删除，陈述原文不动 |
| 继承关系 | `resolve_process_notes`：有 override 用展品特例，否则继承通用卡；`card_updated_after_override` 提示通用卡已更新但例外仍生效 |
| 名额原子占用 | 单连接 RLock + `BEGIN IMMEDIATE`，确认/候补判定与写入同一事务；并发测试 8 线程抢 1 席恰 1 人确认 |
| 候补/取消时序 | 取消确认名额同事务递补最早候补并发新回执；`reservation_events` 全量时序 |
| 真实确认 | 页面 JS 只读 `/api/sessions/:id` 服务端计数；预约结果直接展示服务端返回的状态与回执码 |
| 回执丢失 | `POST /api/reservations/:id/receipt/reissue`（校验联系方式）：旧码 `superseded`，新码生效，预约状态不变 |
| 私坐标窑址 | `coord_visibility=private` 的窑址，公开 API 与全部构建产物均无坐标（测试逐文件扫描） |
| 许可绑定 | 高分辨率图/打印说明按批准版本的 `license_name+license_version` 渲染 `data-license-version` |
| 发布原子性 | 构建→校验→`os.replace` 切换符号链接；悬空引用/断链即失败，`current` 不动 |
| 旧深链接 | 展品改名登记 `redirects`，旧路径生成跳转页；目标页公开"来源链"（全部版本记录） |

## API 摘要

公开：`POST /api/reserve`、`GET /api/sessions/:id`、`POST /api/reservations/:id/cancel`、
`GET /api/reservations/:id?contact=`、`POST /api/reservations/:id/receipt/reissue`、
`GET /api/era-relation?a=&b=`、`GET /api/kilns/:slug`

后台（`X-Admin-Token`，默认 `dev-admin-token`）：`POST/PUT /api/admin/{kiln_site|glaze|vessel_form|process_card|material|exhibit|media|session}[/:id]`、
`DELETE /api/admin/materials/:id`、`PUT /api/admin/exhibits/:id/overrides/:process_id`、
`GET /api/admin/exhibits/:id/process-notes`、`GET /api/admin/process-cards/:id/inheritance`、
`GET /api/admin/review-tasks`、`POST /api/admin/approvals`、`POST /api/admin/publish`、
`GET /api/admin/sessions/:id/reservations`

典型后台流程：修改实体 → `POST /api/admin/approvals` 批准 → `POST /api/admin/publish` 发布。
