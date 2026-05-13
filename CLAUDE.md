# 项目指引 — A股实时筛选App

## 项目概述
一个运行在安卓手机上的PWA网页应用，按6个条件逐级筛选A股股票，使用东方财富免费API获取实时行情数据。

## 文档索引

| 文档 | 路径 | 说明 |
|------|------|------|
| 需求文档 | [docs/requirements.md](docs/requirements.md) | 功能需求、用户故事、筛选规则 |
| 技术规范 | [docs/tech-spec.md](docs/tech-spec.md) | 技术选型、API接口、数据结构 |
| 设计规范 | [docs/design-spec.md](docs/design-spec.md) | UI设计原则、配色、布局 |
| 执行步骤 | [docs/execution-steps.md](docs/execution-steps.md) | 分阶段开发步骤、检查点 |

## 开发日志
所有日志存放在 [dev-logs/](dev-logs/) 目录，按日期命名（如 `2026-05-13.md`）。每日记录完成事项和待办事项。

## 项目结构
```
stocks finding/
├── CLAUDE.md              # 本文件
├── docs/                  # 项目文档
├── dev-logs/              # 开发日志
├── index.html             # 主页面
├── manifest.json          # PWA清单
├── sw.js                  # Service Worker
├── css/style.css          # 样式
├── js/                    # 脚本
│   ├── api.js             # 数据获取
│   ├── filter.js          # 筛选逻辑
│   ├── ui.js              # UI渲染
│   └── app.js             # 主控
└── img/                   # 图标
```

## 工作约定
- 用户是不懂代码的小白，所有说明需通俗易懂
- 每个开发阶段完成后需向用户展示成果
- 使用东方财富JSONP接口，无需后端服务器
- 目标部署平台：GitHub Pages
- 优先保证功能正确和稳定，再优化UI
