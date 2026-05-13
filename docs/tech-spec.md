# 技术规范 — A股实时筛选App

## 技术选型
- **平台**：PWA（渐进式Web应用）
- **前端**：原生 HTML + CSS + JavaScript（无框架）
- **部署**：GitHub Pages（免费静态托管）

## 数据源架构

| 步骤 | 数据源 | API | 协议 | 编码 |
|------|--------|-----|------|------|
| ①③④ | 新浪财经 | `vip.stock.finance.sina.com.cn` Market_Center | CORS | UTF-8 |
| ② | 腾讯行情 | `qt.gtimg.cn` | CORS | GBK |
| ⑤ | 腾讯K线 | `web.ifzq.gtimg.cn` fqkline | CORS | UTF-8 |
| ⑥ | 腾讯分钟 | `web.ifzq.gtimg.cn` minute | CORS | UTF-8 |

## API 详情

### 新浪财经 — 批量行情
```
GET https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData
  ?page=1&num=100&sort=changepercent&asc=0&node=hs_a
```
返回JSON数组，每只股票含：symbol, code, name, trade, changepercent, turnoverratio, nmc(流通市值/万元), mktcap

### 腾讯行情 — 量比批量
```
GET https://qt.gtimg.cn/q=sh600519,sz000001
```
返回 GBK 编码的伪 JavaScript，`~` 分隔字段，量比在索引 **49**。

### 腾讯K线 — 日线
```
GET https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,60,qfq
```
返回JSON：`data.{symbol}.qfqday` 数组，格式 `[日期, 开盘, 收盘, 最高, 最低, 成交量]`。注意：索引1是开盘、2是收盘。

### 腾讯分钟 — 分时
```
GET https://web.ifzq.gtimg.cn/appstock/app/minute/query?_var=d&code=sh600519
```
JSONP格式响应，分钟数据格式：`"HHMM 价格 成交量(手) 成交额(元)"`，VWAP需自行累计算。

## 筛选算法
- 步骤①-④：纯数值比较，内存中过滤
- 步骤⑤：对每只股票请求日K线，计算MA5/MA10/MA20，判断多头排列+压力位
- 步骤⑥：对每只股票请求分时分钟数据，计算累计VWAP，判断100%时间价格≥均价（剔除开盘2min）
