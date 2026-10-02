# M0 安全基線 baseline

## 目的
建立可重現的部署與環境治理，作為 M1–M5 所有變更的基準。

## 已完成
- [x] CI 前端 install 改用 `npm ci`（lockfile 可重現）
- [x] CI 新增 worker-validate job（dry-run 部署驗證）
- [x] worker .dev.vars.example 環境治理文件

## baseline 環境資訊
- 前端：GitHub Pages（已部署，https://polik18.github.io/vote-platform/）
- Worker：vote-platform-api（已部署）
- D1：vote-platform-db（c5631093-c3e1-4b7e-82bd-5ebcf909a5bc）
- migration：0001_init.sql（唯一）

## 待辦（非 M0 阻塞）
- [ ] D1 原生 backup 確認開啟（Cloudflare 控制台）
- [ ] staging preview deployment 流程（M1 後建立）

## baseline 測試基準（待 M2 建立後回填）
- 前端 build：成功
- worker dry-run：成功
- 效能 baseline：（待 load test）
