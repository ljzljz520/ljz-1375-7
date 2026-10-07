# 窑火资料站（陶瓷窑火资料与预约站）

资料库 + 工坊预约 + 静态公开站发布。Node 20 + better-sqlite3，无其他运行时依赖。

```bash
npm install
npm run seed     # 演示数据（可选）
npm start        # 后台 http://localhost:8080 ，预约页 /workshops ，公开站 /site/
npm test         # 12 项验收测试
```

## 架构

```
src/db.js           SQLite 模式与连接（WAL，外键）
src/chronology.js   年代区间 + 不确定度比较
src/inheritance.js  通用工艺卡 vs 展品特定说明的继承
src/materials.js    材料卡版本化 / 软删除 / 引用图待复核
src/booking.js      预约：事务内原子占用、候补 FIFO、取消转正、回执
src/publish.js      静态站构建与原子发布（临时目录→校验→rename→软链切换）
src/views.js        公开站 HTML 渲染（全量转义）
src/server.js       HTTP 路由：后台 API + 预约 API + 静态发布物
src/admin.js        后台管理台页面
src/bookingPage.js  工坊预约页
test/acceptance.test.js  验收测试
var/                运行期数据（kiln.db、site/releases、site/current），不入库
```

## 关键设计

**年代区间与不确定度**：展品存 `date_start/date_end/uncertainty_years`；比较时按 ±不确定度
展开区间，相交只报告 `overlap: true`，`same_era_confirmed` 恒为 false——区间相交不表示
同代确证，页面与 API 均如此表述。

**工艺卡继承**：通用工艺卡在 `processes.card_body`；展品特定说明在
`exhibit_processes.local_note`（局部例外）。`GET /api/exhibits/:id/process-cards` 返回
每道工序的通用卡、局部说明与生效来源（`source: generic|exhibit`）。更新通用卡只写
`processes` 表，绝不触碰局部例外；无局部例外的展品自动继承新通用卡。

**材料卡与引用图**：材料内容全部版本化（`material_versions`），更新=追加版本，历史版本
永不改写。追加版本或删除材料时，沿 `article_citations` 引用图把引用旧版的文章标记
`needs_review`（`GET /api/review/pending`），文章正文与所引版本保持不变；复核是显式
人工动作（`POST /api/citations/:id/resolve`）。删除为软删除，历史版本与引用留档可查。

**工坊预约（无电商结算）**：无任何价格/支付字段。名额在 SQLite 事务内原子占用
（`bookings` 单连接同步事务，并发请求串行化）；满员进入 FIFO 候补；取消释放名额后队首
原子转正，全程写入 `booking_events` 时序。回执为服务端随机码，页面提交后凭回执向
`GET /api/bookings/:receipt` 查询真实状态，不做本地计数；回执丢失可凭联系方式
`POST /api/bookings/lookup` 找回。

**静态公开站**：`POST /api/publish` 仅取后台已批准记录构建。先写临时目录，校验（如批准
媒体必须绑定许可版本）通过后 `rename` 成正式 release，再原子切换 `current` 软链；任一
步失败 `current` 不变，不混入半版内容。旧 release 目录保留，`/releases/<slug>/...`
深链接长期可访问，展品页含来源链（陈述、来源争议、材料版本、许可版本）。窑址
`coords_public=0` 时坐标在构建期剔除；借展展品默认不公开高清图与打印说明（除非
`loan_allows_hires`）；高清图与打印说明均绑定许可 `code + version`。

## 验收对照（test/acceptance.test.js）

| 验收点 | 测试 |
| --- | --- |
| 年代区间相交≠同代确证 | `年代：区间相交不表示同代确证…` |
| 通用卡更新不覆盖局部例外 | `继承：通用卡更新不覆盖展品特定说明…` |
| 材料更新→待复核、历史不改 | `材料卡：追加版本后…` |
| 材料卡被删除 | `材料卡删除：软删除…` |
| 借展 | `发布v1：…借展高清图不公开…` |
| 窑址禁止公开坐标 | `发布v1：…禁公开坐标不出现…` |
| 发布失败不混入半版 | `发布失败：current 保持不变…` |
| 旧深链接保留来源链 | `旧深链接：…来源链完整` |
| 最后名额竞争 | `最后名额竞争：并发 10 人抢 1 个名额…` |
| 取消/候补时序 | `取消释放名额：候补队首原子转正…` |
| 回执丢失 | `回执丢失：凭联系方式找回…` |
| 无电商结算 | `预约接口不含任何价格/支付字段…` |
