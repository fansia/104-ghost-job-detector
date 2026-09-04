# Chrome Web Store 上架文案

送審時把以下內容貼到 Developer Dashboard 對應欄位。
最容易被退件的是「Privacy practices」那一頁,尤其是權限理由,請逐字填寫、不要精簡。

上傳的套件用 `./build.sh` 產生的 `dist/ghost-job-detector-<version>.zip`。

---

## Store listing

### Name(上限 75 字元)

```
幽靈職缺偵測器(104 非官方)
```

### Summary(上限 132 字元)

```
顯示 104 職缺的 HR 實際處理履歷紀錄:多久沒看履歷、是否從未回覆過應徵者,幫你避開已讀不回的幽靈職缺。非官方工具。
```

### Description(上限 16,000 字元)

```
104 的資料庫其實記錄了每個職缺「上次處理履歷」和「上次回覆應徵者」的時間,而且 104 網頁自己載入職缺時就會把這些欄位抓回你的瀏覽器。但 104 只會在頁面上顯示正面的那一半(例如「7 天內處理過履歷」),從不告訴你這家公司從來沒有回覆過任何應徵者。

這個外掛把另一半補上。

▍它會顯示什麼

在 104 的搜尋結果、職缺內頁和公司頁,每個職缺會多出一列徽章:

[留意 32] 從未回覆應徵者 ・ 11 天沒處理履歷 ・ 4 人應徵

點開徽章會展開完整原始數據:

・HR 活躍度 — 104 內部的活躍度百分位(0~100)
・上次處理履歷 — HR 最後一次點開履歷是幾天前
・上次回覆應徵者 — 公司最後一次真的回覆是幾天前(常常是「從未回覆過」)
・刊登(更新)日期 — 原始日期,不是 104 顯示的相對時間
・應徵人數 — 精確數字,不是「6~10 人」這種模糊區間
・公司目前開缺 — 同時開幾個缺,用來看是不是在養人才庫
・觀察到重新刊登 — 本外掛長期追蹤到這個缺被重貼幾次

▍關於分數

分數 0~100,是多個訊號的加總,分級為:0–19 正常 / 20–39 留意 / 40–64 可疑 / 65+ 高風險。

分數只是排序用的摘要,不是結論。把真職缺誤標成假的,對求職者和公司都是傷害,所以介面一律同時呈現原始數據,讓你自己判斷。

舉例來說,一個「從未回覆過應徵者」的缺,如果它根本還沒有人應徵,那就不構成任何負面訊號——這種情況外掛會直接標示「尚無人應徵,無從判斷 HR 的回覆行為」,而不是拿它來扣分。

▍隱私

・不蒐集、不上傳任何資料,開發者沒有伺服器
・所有資料都由你的瀏覽器直接向 104 網頁自己使用的內部 API 查詢,不經過任何第三方
・本機只存 API 快取(最長 6 小時)與職缺觀察紀錄,可從彈出視窗一鍵清除
・完整原始碼以 MIT 授權公開,歡迎稽核

原始碼:https://github.com/fansia/104-ghost-job-detector
隱私權政策:https://fansia.github.io/104-ghost-job-detector/privacy.html

▍已知限制

・104 沒有公開「首次刊登日期」,appearDate 只是最後更新日,真正的刊登時長要靠外掛長期累積觀察紀錄
・應徵人數只有搜尋 API 有,公司頁與職缺內頁需要用公司名稱回查才能補上;公司名稱夠特殊時能完整對上,名稱通用時只撈得到一部分,對不到的就不顯示,不會亂猜
・依賴 104 未公開文件的 API,對方改版可能失效

▍聲明

本外掛由第三方獨立開發,與 104 資訊科技股份有限公司無任何隸屬、合作或背書關係。
「104」為其權利人之商標,此處僅用於說明本外掛的適用範圍。
```

### 其他欄位

| 欄位 | 建議值 |
|---|---|
| Category | 求職 / 生產力工具(Productivity) |
| Language | 中文(繁體) |
| Homepage URL | `https://fansia.github.io/104-ghost-job-detector/` |
| Support URL | `https://github.com/fansia/104-ghost-job-detector/issues` |

---

## Privacy practices(最常被退件的一頁)

### Single purpose description

```
本外掛只做一件事:在 104 人力銀行(www.104.com.tw)的職缺頁面上,顯示該職缺的 HR 處理履歷與回覆應徵者的紀錄,協助求職者判斷職缺是否仍在實際招募。所有資料皆取自 104 網站自身在載入職缺頁面時使用的內部 JSON API,以使用者自己瀏覽器發出的同源請求取得,不經過任何中介伺服器。
```

### Permission justification — `storage`

```
用於在使用者本機存放兩類資料:(1) 104 API 回應的快取,依資料類型於 5 分鐘至 6 小時後失效,避免對同一職缺重複發出請求、減少對 104 伺服器的負擔;(2) 職缺的重新刊登觀察紀錄,用來計算某個職缺被重貼過幾次,以及使用者的啟用/停用偏好設定。兩者都只存在 chrome.storage.local,不會離開使用者的裝置,使用者可從彈出視窗一鍵清除。
```

### Permission justification — host permission `https://www.104.com.tw/*`

```
本外掛必須在 104 的職缺頁面上執行,才能把資訊徽章注入到職缺卡片旁邊,並向 104 網站自身使用的內部 JSON API(/jobs/search/api/jobs、/job/ajax/content/、/api/companies/) 查詢該職缺的處理履歷紀錄。這些請求是同源請求,由使用者自己的瀏覽器直接送往 www.104.com.tw,不經過任何中介伺服器。本外掛不在 104 以外的任何網站執行,content script 的 matches 也僅限 104 的搜尋、職缺、公司三種頁面。
```

### Are you using remote code?

```
No, I am not using remote code
```

依據:所有 JavaScript 都封裝在套件內(`src/*.js`),`popup.html` 只以相對路徑載入同套件內的 `popup.js`。全專案無 `eval()`、無 `new Function()`、無 `innerHTML`、無 `document.write`、無 `importScripts`、無任何外部 CDN 或遠端腳本。`fetch()` 只用來取得 104 的 JSON 資料,不會被當成程式碼執行。

### Data usage certification

以下資料類型**全部不勾選**:

- ☐ 個人身分識別資訊(Personally identifiable information)
- ☐ 健康資訊(Health information)
- ☐ 財務與付款資訊(Financial and payment information)
- ☐ 認證資訊(Authentication information)
- ☐ 個人通訊(Personal communications)
- ☐ 位置(Location)
- ☐ 網頁瀏覽紀錄(Web history)
- ☐ 使用者活動(User activity)
- ☐ 網站內容(Website content)

三項聲明**全部勾選**:

- ☑ 我不會將使用者資料販售給第三方,除法定用途外
- ☑ 我不會將使用者資料用於或轉移至與單一用途無關的用途
- ☑ 我不會將使用者資料用於或轉移至判斷信用狀況或放貸目的

### Privacy policy URL

```
https://fansia.github.io/104-ghost-job-detector/privacy.html
```

---

## 還需要人工準備的素材

| 素材 | 規格 | 狀態 |
|---|---|---|
| 商店圖示 | 128×128 PNG | ✅ `icons/icon128.png` |
| 商店列表大圖 | 256×256 PNG | ✅ `store/icon256.png` |
| 螢幕截圖 | 1280×800 或 640×400,1–5 張 | ⚠️ `store/screenshot-1280x800.png` 可先送,建議再補 2 張 |
| 小型宣傳圖塊 | 440×280 PNG(選填,但會影響曝光) | ✅ `store/promo-440x280.png` |
| 跑馬燈宣傳圖塊 | 1400×560 PNG(選填) | ✅ `store/promo-1400x560.png` |
| 開發者帳號 | 一次性 $5 USD 註冊費 | ⬜ |

`store/screenshot-1280x800.png` 已把實際運作畫面(原始 1099×359)排版成合規的
1280×800,單張即可送審。但一張截圖的說服力有限,建議再補兩張。

所有圖片都存成 24 位元 RGB PNG(無 alpha 透明層),符合商店規定。

截圖建議拍三張:

1. 搜尋結果頁,多張卡片都掛著徽章
2. 徽章展開後的完整數據表(可對照 104 自己只顯示「6~10 人應徵」、徽章給精確數字)
3. 一個「從未回覆應徵者」的高風險職缺

---

## 送審注意事項

- **商標**:名稱與描述都已標註「非官方」並加上與 104 無隸屬關係的聲明。這是降低商標檢舉風險的必要措施,審核或日後有爭議時不要拿掉。
- **單一用途**:manifest 的 `content_scripts.matches` 僅限 104 三種頁面,與 Single purpose 描述一致,不要為了未來功能先放寬。
- **權限最小化**:目前只用 `storage` 與單一 host permission,沒有 `tabs`、`scripting`、`webRequest`,也沒有 background service worker。審核時這是加分項,新增權限前先想清楚理由怎麼寫。
