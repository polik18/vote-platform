# Vote Platform 改善計畫

- 更新日期：2026-10-02
- 狀態：`PLANNED`
- 適用專案：`/Users/huangjianzhe/Git/vote-platform`
- 執行原則：所有正式資料異動先在 staging 驗證；正式 D1 只採可回復、向後相容的 migration。

## 1. 目標與完成定義

本計畫將目前已部署的 MVP 提升為可供約 300 人參與、具明確資料完整性與操作門禁的投票平台。

完成後必須達成：

1. 投票規則生效後不得事後修改。
2. 送票、關閉與管理更新同時發生時，不會重複計票、遺失選項或接受逾時選票。
3. Authentication、authorization、票制、狀態機、匿名邊界及結果權限具自動化測試。
4. 錯誤回應不洩漏內部資訊，輸入、CSV、流量及外部腳本風險受到控制。
5. 300 人 staging 演練的資料筆數與聚合結果完全一致。
6. 備份、migration、rollback、監控與活動 runbook 經過實際演練。

本計畫完成仍不代表具備政府選舉等級的密碼學可驗證秘密投票能力。匿名投票維持「行政匿名」，除非另案導入專用密碼學投票協定與獨立信任邊界。

## 2. 現況摘要

### 已確認可用

- GitHub Pages 正式前端與 Cloudflare Worker 根端點均回應 HTTP 200。
- `npm run build` 通過。
- `wrangler deploy --dry-run` 通過。
- 初始 D1 schema 可由 SQLite 正確載入。
- Firebase ID token 的 issuer、audience、email 與 email verification 在 Worker 驗證。
- Admin、Super Admin 與 poll owner 的主要授權判斷位於伺服器端。
- 三種票制、三種資格模式、結果權限及 CSV 匯出均已有實作。
- 專案已明確揭露匿名投票不是密碼學匿名。

### 主要缺口

| ID | 等級 | 缺口 | 主要位置 |
|---|---|---|---|
| R-01 | Critical | 投票後仍可修改 quorum、approval、allow-change、時程及其他結果規則 | `worker/src/index.js:updatePoll` |
| R-02 | Critical | 白名單可在投票後繼續增加，會改變百分比 quorum 分母 | `worker/src/index.js:importWhitelist` |
| R-03 | Critical | 管理更新與第一票間有 TOCTOU 競態，可能讓 ballot 引用已被替換的 option ID | `updatePoll`、`castVote` |
| R-04 | High | 有效截止後可藉由修改 `endAt` 重新開放 | `effectiveStatus`、`updatePoll` |
| R-05 | High | 目前沒有可執行的專案測試，只有人工 checklist | `TESTING.md`、兩份 `package.json` |
| R-06 | High | quorum／approval 接受負值、小數人數或超過 100% | `validatePollInput` |
| R-07 | High | 非法日期會拋出 RangeError；頂層錯誤統一變成 500 並回傳內部訊息 | `validatePollInput`、top-level fetch |
| R-08 | Medium | 每次驗證重新建立 remote JWKS resolver | `authenticate` |
| R-09 | Medium | 結果端點讀取並解析全部 ballot | `getResults` |
| R-10 | Medium | CSV 未防止試算表公式注入 | `csvCell` |
| R-11 | Medium | 無 application-level rate limit／濫用控制 | Worker API |
| R-12 | Medium | `package-lock.json` 未追蹤，CI 使用 `npm install` | Git／Pages workflow |
| R-13 | Medium | 首頁載入 repo 外同源 `site-stats.js`，會建立匿名識別碼並傳送 heartbeat | `frontend/index.html` |

## 3. 核心設計決策

### 3.1 規則鎖定時點

建議在投票從 `draft` 進入 `scheduled` 或 `open` 時鎖定核心規則，而不是等第一張有效選票才鎖。

理由：

- 消除管理員重建 options 與第一位投票者同時送票的競態。
- 所有參與者從投票開始前就面對同一組規則。
- 白名單與 quorum 分母可以在開放前產生固定快照。
- 關閉結果可由固定規則重新驗證。

### 3.2 狀態機

| 目前狀態 | 允許轉換 | 設定權限 |
|---|---|---|
| `draft` | `scheduled`、`open` | 全部可改 |
| `scheduled` | `draft`、`open`、`closed` | 核心規則已鎖；開始前可退回 draft 解鎖，必須寫 audit |
| `open` | `paused`、`closed` | 僅狀態可變 |
| `paused` | `open`、`closed` | 僅狀態可變 |
| `closed` | `archived` | 唯讀 |
| `archived` | 無 | 完全唯讀 |

禁止：

- `open → draft`
- `closed → open`
- `archived` 後任何更新
- 已有效截止後延長 `endAt` 重新收票
- 已鎖定後修改選項、資格、結果門檻或顯示規則

### 3.3 核心不可變欄位

規則鎖定後禁止修改：

- `title`、`description`
- `anonymity`
- `voteMode`、`maxVotes`、`requireAllVotes`、`allowChange`
- `eligibilityMode`、`allowedDomain`
- options 內容與順序
- whitelist email 集合
- `resultsVisibility`
- `quorumType`、`quorumValue`
- `approvalType`、`approvalValue`
- `startAt`、`endAt`

需要修正題意或規則時，應建立投票副本並封存舊投票，不在原投票上修改。

### 3.4 併發策略

第一階段採用：

- 開放前鎖定規則。
- `polls.version` 樂觀鎖。
- 所有 update 使用 `WHERE id = ? AND version = ?`。
- 送票前依最新資料重新檢查狀態與時間。
- participation／ballot／ballot choices 使用資料庫 constraint 與原子 batch。

若 staging 仍無法證明關閉與送票競態完全受控，第二階段改用每個 poll 一個 Durable Object，將狀態變更及送票寫入串行化，D1 作為永久儲存層。

## 4. 里程碑

### M0：安全基線與可重現建置

- 預估：0.5–1 日
- 優先級：P0
- 依賴：無

#### 工作項目

- [ ] M0-01 匯出正式 D1 schema、表筆數與可回復備份。
- [ ] M0-02 建立獨立 Firebase、Worker、D1 與前端 staging 環境。
- [ ] M0-03 檢查現有兩份 `package-lock.json`，確認依賴後納入 Git。
- [ ] M0-04 GitHub Actions 改用 `npm ci`。
- [ ] M0-05 固定 CI 與本機支援的 Node major version。
- [ ] M0-06 保存修改前 smoke baseline：登入、建票、投票、結果、export。
- [ ] M0-07 建立 migration／rollback 操作說明。

#### 驗收條件

- [ ] 正式 D1 備份可讀且有 SHA-256 或平台備份識別。
- [ ] staging 可完成登入、建立投票、送票與讀取結果。
- [ ] 全新 checkout 執行 `npm ci && npm run build` 成功。
- [ ] CI 與本機解析出相同 direct dependency 版本。
- [ ] M0 不改動或刪除正式投票資料。

### M1：投票完整性與狀態機

- 預估：2–4 日
- 優先級：P0／正式使用前必做
- 依賴：M0

#### M1-01 新增完整性 migration

建立 `worker/migrations/0002_poll_integrity.sql`，至少新增：

```sql
version INTEGER NOT NULL DEFAULT 1
rules_locked_at TEXT
opened_at TEXT
closed_at TEXT
eligible_count_snapshot INTEGER
```

舊資料處理：

- `has_votes=1` 的投票在 migration 後標記為已鎖定。
- whitelist percent quorum 以當下 whitelist count 回填 snapshot。
- audit 記錄 `integrity_migration_backfill`。
- 若歷史白名單曾經改動，文件需標明原始分母不可重建。

#### M1-02 實作明確狀態轉換

- [ ] 建立 `validateTransition(from, to, context)` 純函式。
- [ ] route 不再接受任意 allowed-status 字串組合。
- [ ] `closed_at` 一旦設定即不可清除。
- [ ] `archived` 所有 mutation endpoint 回傳 409。
- [ ] 到期關閉後不可修改時間重新開啟。

#### M1-03 鎖定規則與白名單

- [ ] `draft → scheduled/open` 時設定 `rules_locked_at`。
- [ ] 同時設定 `eligible_count_snapshot`。
- [ ] 鎖定後拒絕 poll core fields 更新。
- [ ] 鎖定後拒絕 whitelist insert／update／delete。
- [ ] options 不再於 active poll 被刪除重建。
- [ ] 所有拒絕均回傳穩定的 409 error code。

#### M1-04 樂觀鎖與管理競態

所有管理更新包含版本：

```sql
UPDATE polls
SET ..., version = version + 1
WHERE id = ? AND version = ?;
```

更新筆數為零回傳：

```json
{
  "error": "poll_version_conflict"
}
```

前端收到衝突時要求重新載入，不自動覆寫。

#### M1-05 送票完整性

- [ ] 送票時讀取最新 poll 狀態。
- [ ] 寫入前再次檢查 stored status、start、end、opened／closed timestamp。
- [ ] participation primary key 仍是 `(poll_id, uid)`。
- [ ] ballot 與 choices 有明確 FK／constraint。
- [ ] `allowChange=false` 的重試不會新增第二張票。
- [ ] `allowChange=true` 的更新會完整取代舊 choices。
- [ ] 逾時投票不會入庫，即使請求在截止前開始、截止後才寫入。

#### M1 驗收條件

- [ ] 開放後修改任一核心規則均回傳 409。
- [ ] 白名單凍結後任何異動均回傳 409。
- [ ] quorum 使用固定 snapshot 分母。
- [ ] 關閉後只能封存。
- [ ] 封存後完全唯讀。
- [ ] 管理頁同時儲存時，過期版本收到 409。
- [ ] 管理更新與第一票同時發生，不產生孤兒 option ID。
- [ ] 截止後零新增 ballot／participation。

### M2：自動化測試與 CI 門禁

- 預估：2–3 日
- 優先級：P0／正式使用前必做
- 依賴：M1，可與部分重構並行

#### M2-01 建立測試架構

- [ ] 使用與目前 Wrangler 相容的 Cloudflare Workers 測試環境。
- [ ] Worker 單元與整合測試採 Vitest。
- [ ] 前端加入基本 DOM／API client 測試。
- [ ] staging 端到端測試採 Playwright，禁止對正式投票執行。

為便於測試，優先從 `worker/src/index.js` 抽出：

```text
worker/src/
├── index.js
├── auth.js
├── errors.js
├── validation.js
├── poll-state.js
├── voting.js
├── results.js
└── csv.js
```

避免無關的大規模重寫；先抽出純函式與高風險流程。

#### M2-02 測試矩陣

##### Authentication／Authorization

- [ ] 無 token、過期 token、錯誤 issuer／audience。
- [ ] email 未驗證。
- [ ] voter 不能建立或管理投票。
- [ ] Admin A 不能管理 Admin B 的投票。
- [ ] Super Admin 可管理全部投票。
- [ ] 明確測試是否只接受 `google.com` sign-in provider。

##### Eligibility

- [ ] public、whitelist、domain 的接受與拒絕案例。
- [ ] email 大小寫與前後空白。
- [ ] whitelist 鎖定。
- [ ] domain 空值、URL、路徑與非法 hostname。

##### Vote modes

- [ ] single 只能一個 option、一票。
- [ ] multiple 不得重複且不得超過 N。
- [ ] allocate 總票數不得超過 N。
- [ ] `requireAllVotes` 的不足與超額案例。
- [ ] 不存在或屬於其他 poll 的 option ID。
- [ ] 零、負數、小數與超大票數。

##### Lifecycle／Concurrency

- [ ] 所有合法與非法狀態轉換。
- [ ] 恰好位於 start／end 邊界。
- [ ] 到期後延長時間不能重開。
- [ ] 同 UID 並行送票只產生一份 participation。
- [ ] 開放與修改設定同時發生。
- [ ] 關閉與送票同時發生。
- [ ] 兩位管理員以相同 version 儲存。

##### Results／Anonymity

- [ ] `public`、`after_vote`、`after_close`、`admin_only`。
- [ ] 未參與者無法繞過結果限制。
- [ ] anonymous ballot 不含 UID／email／name。
- [ ] 匿名投票拒絕 named-votes export。
- [ ] 使用者只能讀取自己的 ballot。

##### Validation／Errors

- [ ] malformed JSON 回傳 400。
- [ ] 非法日期回傳 400。
- [ ] percent 限制為 0–100。
- [ ] count 門檻必須為正整數。
- [ ] 過大 body 回傳 413。
- [ ] SQL／JWT 內部訊息不出現在 response。

#### M2-03 CI

每次 push／PR 必須執行：

```text
npm ci
lint
unit tests
Worker integration tests
migration on empty DB
migration on representative old DB
frontend build
wrangler deploy --dry-run
```

#### M2 驗收條件

- [ ] `TESTING.md` 的人工條目全部有對應自動化測試或明確標示人工原因。
- [ ] 故意還原每個已知 Critical bug 時，至少一個測試失敗。
- [ ] PR 未通過測試時不能部署。
- [ ] 測試不依賴正式 Firebase、正式 D1 或正式投票資料。

### M3：輸入、安全與隱私強化

- 預估：2–3 日
- 優先級：P1
- 依賴：M1、M2 基礎

#### M3-01 輸入限制

| 欄位 | 規則 |
|---|---|
| title | 1–200 字 |
| description | 最多 5,000 字 |
| option code | 1–30 字 |
| option label | 1–300 字 |
| option description | 最多 2,000 字 |
| options | 2–100 個 |
| maxVotes | 正整數 1–100 |
| quorum count | 正整數 |
| quorum percent | 0–100 |
| approval count | 正整數 |
| approval percent | 0–100 |
| whitelist | 去重後最多 5,000 筆 |
| 一般 JSON body | 建議上限 256 KB |
| domain | 正規 hostname；不接受 URL、路徑或 `@` |

日期必須可解析、轉換為 UTC ISO，並滿足 `startAt < endAt`。

#### M3-02 錯誤模型

- [ ] 已知 `HttpError` 保留安全的 4xx status／code。
- [ ] 未知例外只對外回傳 `internal_error` 與 request ID。
- [ ] 完整 exception 僅進入伺服器 log。
- [ ] 前端將穩定 error code 對應為中文訊息。

#### M3-03 Authentication 效能與限制

- [ ] remote JWKS resolver 移至 module scope 以重用快取。
- [ ] 驗證 expiry、issuer、audience、email verification。
- [ ] 決定並測試是否強制 `firebase.sign_in_provider === "google.com"`。
- [ ] 不在 log 記錄完整 token。

#### M3-04 Rate limit

- [ ] 每 UID 的一般 API 請求上限。
- [ ] 每 UID／poll 的 vote submission 頻率。
- [ ] whitelist import／export 頻率。
- [ ] 明顯異常的 401／無效 token 流量。
- [ ] rate limit 不取代 participation unique constraint。

#### M3-05 CSV 安全

對以 `=`, `+`, `-`, `@` 開頭的儲存格加入安全前綴，並測試 Excel 與 Google Sheets 不會將其執行為公式。

#### M3-06 匿名資料最小化

`anonymous + allowChange=false` 時：

- [ ] `participation.ballot_id` 不保存。
- [ ] ballot 不含 UID、email、name。
- [ ] vote audit 不保存 actor email／UID。
- [ ] 避免完全相同的 participation 與 ballot timestamp 增加關聯性。

允許改票時需要內部關聯，UI 與說明必須清楚揭露行政匿名邊界。

#### M3-07 外部腳本與安全 headers

- [ ] 將固定版 `site-stats.js` 納入 repo，或使用 SRI 與嚴格 CSP。
- [ ] 公開匿名 visitor ID、session ID、path 與 heartbeat 的資料用途。
- [ ] 不傳送 hash route、poll ID、email、UID 或 token。
- [ ] 加入 CSP、`X-Content-Type-Options`、合理 Referrer Policy 等 headers。

#### M3 驗收條件

- [ ] 所有非法輸入穩定回傳正確 4xx。
- [ ] response 不含 SQL、stack 或 JWT 內部訊息。
- [ ] CSV 測試字串不會被試算表執行。
- [ ] 匿名不可改票模式不存在直接 participant-to-ballot 關聯。
- [ ] rate limit 與安全 headers 有自動化 smoke test。

### M4：資料模型、結果與前端體驗

- 預估：2–4 日
- 優先級：P1／P2
- 依賴：M1–M3

#### M4-01 正規化選票選項

建議新增：

```text
ballot_choices
- ballot_id
- poll_id
- option_id
- votes
```

結果改由 SQL 聚合：

```sql
SELECT option_id, SUM(votes)
FROM ballot_choices
WHERE poll_id = ?
GROUP BY option_id;
```

改票時必須以原子操作刪除舊 choices、寫入新 choices。若保留 `choice_json`，需定義唯一權威來源，避免 JSON 與正規化資料不一致。

#### M4-02 關閉結果快照

建立 `poll_result_snapshots`：

```text
poll_id
participant_count
total_votes
result_json
rules_json
created_at
content_hash
```

關閉後的公開結果與 export 使用快照，不再依可變資料即時計算。

#### M4-03 我的選票

新增：

```text
GET /api/polls/:id/my-ballot
```

只回傳目前登入者的選票。允許改票時，前端預先填入原選擇，並顯示原始提交及最近更新時間。

#### M4-04 Idempotency 與送票 UX

- [ ] 送出後立即 disable 按鈕。
- [ ] 顯示處理中狀態。
- [ ] 使用 idempotency key 處理網路重試。
- [ ] 斷線後先查 participation／my-ballot，不盲目重送。
- [ ] 改票前顯示完整選票摘要及「取代上一張選票」。

#### M4-05 Accessibility

- [ ] tabs 使用 `tablist`、`tab`、`aria-selected` 與鍵盤操作。
- [ ] 成功／錯誤使用 `aria-live`，不只依賴 `alert()`。
- [ ] 驗證錯誤顯示於欄位附近。
- [ ] 操作後管理焦點。
- [ ] 測試手機寬度、鍵盤及螢幕閱讀器。

#### M4 驗收條件

- [ ] 結果查詢不再把全部 ballots 拉到 Worker 計算。
- [ ] 改票後聚合不殘留舊票。
- [ ] 關閉快照可重算驗證，hash 一致。
- [ ] 使用者能查看自己的現有選擇但無法查看他人選票。
- [ ] 雙擊與網路重試不會重複計票。

### M5：壓測、營運與正式發布

- 預估：1–2 日，加一次活動演練
- 優先級：正式使用前必做
- 依賴：M0–M4

#### M5-01 300 人 staging 壓測

測試情境：

- [ ] 300 位參與者在 2–5 分鐘內送票。
- [ ] 包含重試、雙擊、斷線及重連。
- [ ] 管理員同時查看結果與參與名單。
- [ ] `allowChange=true` 時多人改票。
- [ ] 截止時間附近大量送票。
- [ ] whitelist 匯入 300、1,000、5,000 筆。

完整性門檻：

- 每 UID 最多一份 participation。
- ballots、participation、ballot choices 數量符合票制預期。
- 聚合結果等於預先產生的測試答案。
- 截止後零新增選票。
- 零孤兒 ballot／choice／option reference。
- 所有非成功請求都有可解釋的 4xx／409；無非預期 5xx。

初始效能觀察目標：

- vote submission staging p95 低於 1 秒。
- result query staging p95 低於 1.5 秒。
- 若環境基準不合理，先保存 baseline 再制定正式 SLO，不以放寬資料完整性換取速度。

#### M5-02 監控

記錄：

- request ID、endpoint、status、latency
- auth failure 數量
- version conflict
- duplicate／rate-limit attempt
- poll open／pause／close／archive
- D1 error
- result snapshot 成功／失敗

匿名投票的一般 application log 不記錄選票內容。

#### M5-03 Runbook

建立：

- 活動前備份
- 投票複製與白名單驗證
- 測試帳號演練
- 開放、暫停、關閉與封存
- Firebase／Worker／D1 故障處理
- Worker rollback 與 D1 restore
- 結果驗證、匯出及事故證據保存

#### M5-04 發布順序

1. 備份正式 D1。
2. staging migration。
3. staging 自動測試與 300 人模擬。
4. 正式 additive migration。
5. 部署向後相容 Worker。
6. API smoke test。
7. 部署前端。
8. 以 Super Admin、Admin、Voter 三種帳號驗收。
9. 驗證舊投票仍可讀取。
10. 觀察錯誤率及資料一致性後再宣告完成。

#### M5 驗收條件

- [ ] 300 人測試的資料與預期答案完全一致。
- [ ] 正式備份、rollback 與 restore 至少演練一次。
- [ ] 監控可定位一次模擬錯誤的 request ID。
- [ ] 活動操作者可依 runbook 完成開放、關閉與結果驗證。

## 5. 建議實作順序與提交切分

建議保持小型、可回復的 commit：

1. `chore: track lockfiles and make installs reproducible`
2. `test: add worker test harness and baseline cases`
3. `feat: add poll integrity migration and versioning`
4. `fix: enforce poll state transitions and rule locking`
5. `fix: freeze whitelist and quorum denominator`
6. `fix: make vote submission conflict-safe`
7. `fix: validate poll inputs and sanitize errors`
8. `security: harden auth caching rate limits and csv exports`
9. `refactor: normalize ballot choices and snapshot closed results`
10. `feat: improve ballot review accessibility and idempotency`
11. `ops: add load tests monitoring and event runbook`

每個 commit 都必須保持 migration 向後相容，並能獨立通過測試與 build。

## 6. 發布 Go／No-Go 門禁

只有以下條件全部通過，才可標記為正式可用：

- [ ] 核心規則在 scheduled／open 後不可變。
- [ ] 白名單與 quorum 分母已快照。
- [ ] 關閉／封存結果不可透過修改規則而改變。
- [ ] 並行投票無重複、遺失或孤兒資料。
- [ ] 權限、匿名、票制、狀態機及競態有自動化測試。
- [ ] CI 使用 lockfile 與 `npm ci`。
- [ ] 非法輸入回傳正確 4xx。
- [ ] 正式 response 不洩漏內部錯誤。
- [ ] CSV 已防公式注入。
- [ ] 外部統計腳本與隱私用途已治理。
- [ ] 300 人 staging 測試完全一致。
- [ ] 備份、rollback、監控與 runbook 已演練。

若 M1 或 M2 尚未完成，平台只能標記為 MVP／內部試用，不應標記為高可信正式表決系統。

## 7. 執行狀態表

| 里程碑 | 狀態 | 預估 | 前置依賴 | 完成證據 |
|---|---|---:|---|---|
| M0 安全基線 | PLANNED | 0.5–1 日 | 無 | 備份、staging、lockfile、baseline |
| M1 投票完整性 | PLANNED | 2–4 日 | M0 | migration、狀態機、競態測試 |
| M2 自動化測試 | PLANNED | 2–3 日 | M0／M1 | CI run、測試報告 |
| M3 安全與隱私 | PLANNED | 2–3 日 | M1／M2 | security tests、headers、error contract |
| M4 資料與 UX | PLANNED | 2–4 日 | M1–M3 | aggregation、snapshot、E2E |
| M5 壓測與發布 | PLANNED | 1–2 日＋演練 | M0–M4 | load report、runbook、release evidence |

整體預估：一位開發者約 8–14 個工作日；完整 staging、300 人壓測與正式演練另預留 3–5 日較安全。
