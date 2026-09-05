/* 主流程:偵測頁面類型 → 取資料 → 算分 → 注入徽章。 */
(function () {
  const { util: u, api, score, badge } = GJD;

  const MAX_PAGES = 30; // 搜尋結果的保險上限,避免無止境往後翻頁
  const MAX_COMPANY_PAGES = 6; // 一頁 100 筆,足以涵蓋開缺最多的公司

  const state = {
    enabled: true,
    rowsByJobNo: new Map(), // 搜尋 API 的結果,key 是數字 jobNo
    pageFetches: new Map(), // page -> Promise,避免同一頁被併發重複請求
    maxPage: 0,
    exhausted: false,
    companyCache: new Map(), // "custCode:page" -> Promise<companyJobs()>
    applyCache: new Map(), // jobCode -> Promise<應徵人數>
  };

  /* ---------- 觀察紀錄:記下第一次看到的時間與重新刊登次數 ---------- */

  async function touchHistory(jobCode, appearDate) {
    if (!jobCode) return null;
    const key = 'hist:' + jobCode;
    let h = await u.cacheGet(key);
    const today = new Date().toISOString().slice(0, 10);
    if (!h) {
      h = { firstSeen: today, lastAppear: appearDate || null, repostCount: 0 };
      u.noteNewJob(); // 只在真的第一次看到時計數,所以是不重複的職缺數
    } else if (appearDate && h.lastAppear && appearDate !== h.lastAppear) {
      h.repostCount = (h.repostCount || 0) + 1;
      h.lastAppear = appearDate;
    } else if (appearDate && !h.lastAppear) {
      h.lastAppear = appearDate;
    }
    await u.cacheSet(key, h);
    return h;
  }

  /* ---------- 資料組裝 ---------- */

  // 同一間公司的同一頁只請求一次,多張卡片共用結果
  function getCompanyPage(custCode, page) {
    const key = custCode + ':' + page;
    let p = state.companyCache.get(key);
    if (p) return p;
    p = api.companyJobs(custCode, page).catch(() => null);
    state.companyCache.set(key, p);
    return p;
  }

  // 同一個職缺可能同時被多張卡片(或重複掃描)要求,共用 Promise 才不會重複打 API
  function getApplyCount(jobCode) {
    if (!jobCode) return Promise.resolve(null);
    let p = state.applyCache.get(jobCode);
    if (p) return p;
    p = api.applyCount(jobCode).catch(() => null);
    state.applyCache.set(jobCode, p);
    return p;
  }

  // 同一間公司的開缺總數也只問一次
  function getCompanyTotal(custCode) {
    if (!custCode) return Promise.resolve(null);
    const key = 'total:' + custCode;
    let p = state.companyCache.get(key);
    if (p) return p;
    p = api.companyTotal(custCode).catch(() => null);
    state.companyCache.set(key, p);
    return p;
  }

  /** 大公司職缺會超過一頁,往後翻到找到這個職缺為止 */
  async function findCompanyEntry(custCode, jobCode) {
    if (!custCode) return { entry: null, totalCount: null };
    let totalPages = 1;
    let totalCount = null;
    for (let page = 1; page <= totalPages && page <= MAX_COMPANY_PAGES; page++) {
      const res = await getCompanyPage(custCode, page);
      if (!res) break;
      totalCount = res.totalCount;
      totalPages = res.totalPages || 1;
      if (jobCode && res.byJobCode[jobCode]) {
        return { entry: res.byJobCode[jobCode], totalCount };
      }
    }
    return { entry: null, totalCount };
  }

  /**
   * 公司資料要拿多少,看呼叫端手上有沒有 interactionRecord。
   *
   * 搜尋 API 與職缺內頁 API 都自帶 interactionRecord,格式和公司職缺 API 的一模一樣,
   * 那就只缺開缺總數,一次 pageSize=1 就夠。以前不論如何都往公司 API 翻頁找那一筆,
   * 實測一頁 22 張卡片要打 36 次(鴻海翻滿 6 頁上限還是沒找到,6 次全白費),
   * 改成看情況之後降到 22 次。
   *
   * 公司頁的卡片沒有搜尋列可用,那裡才需要整份 entry。
   */
  async function fetchCompanyFacts(custCode, jobCode, haveInteraction) {
    if (haveInteraction) {
      return { entry: null, totalCount: await getCompanyTotal(custCode) };
    }
    return findCompanyEntry(custCode, jobCode);
  }

  /* ---------- 用量統計輸出 ----------
   * 一輪掃描裡每張卡片各自非同步完成,沒有一個明確的「這輪結束」時點,所以用閒置節流:
   * 最後一張卡片畫完之後兩秒內沒有新動作,就把這一輪的用量印出來。
   * HR 活躍度反查一個職缺最多要打六次請求,這行 log 是判斷快取有沒有在擋的唯一依據。
   */
  let statsTimer = null;
  function scheduleStatsLog() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(() => {
      const s = api.takeStats();
      const reqs = s.searchPages + s.companyReq + s.applyReq + s.similarReq;
      if (!reqs && !s.storeHit && !s.prCacheHit) return; // 這輪什麼都沒做就別洗版

      const prTotal = s.prCacheHit + s.prFound + s.prMissed;
      const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
      const similarTotal = s.similarReq + s.similarHit;

      console.log(
        '[幽靈職缺偵測器] 本輪 ' +
          s.searchRows +
          ' 個職缺 · 送出 ' +
          reqs +
          ' 次請求(搜尋 ' +
          s.searchPages +
          ' 頁、公司 ' +
          s.companyReq +
          '、應徵人數 ' +
          s.applyReq +
          '、相似職缺 ' +
          s.similarReq +
          ') · HR 活躍度 ' +
          prTotal +
          ' 筆:快取命中 ' +
          s.prCacheHit +
          '(' +
          pct(s.prCacheHit, prTotal) +
          '%)、反查到 ' +
          s.prFound +
          '、查不到 ' +
          s.prMissed +
          ' · 相似清單省下 ' +
          s.similarHit +
          '/' +
          similarTotal +
          '(' +
          pct(s.similarHit, similarTotal) +
          '%) · storage 命中 ' +
          s.storeHit +
          ' 次 · PR 快取累積 ' +
          s.prCacheSize +
          ' 筆'
      );
    }, 2000);
  }

  // 104 置頂職缺(jobType 1)不反查 HR 活躍度:實測三頁 6 筆全部找不到,
  // 每筆固定燒掉 6 次請求。它們跟搜尋關鍵字本來就沒關係,略過反而讓覆蓋率上升。
  function wantsHrPR(searchRow) {
    return !(searchRow && searchRow.jobType === 1);
  }

  async function analyse(searchRow, jobDetail, hrPRLookup) {
    const jobCode = (searchRow && searchRow.jobCode) || null;
    const custCode = (searchRow && searchRow.custCode) || (jobDetail && jobDetail.custCode);
    const haveInteraction = !!(
      (searchRow && searchRow.interactionRecord) ||
      (jobDetail && jobDetail.interactionRecord)
    );

    // 搜尋 / 公司職缺 / 職缺內頁三個 API 的 applyCnt 都被 104 歸零了,
    // 精確人數一律走應徵分析端點,每個職缺各問一次。
    const [company, history, applyCnt] = await Promise.all([
      fetchCompanyFacts(custCode, jobCode, haveInteraction),
      touchHistory(jobCode, searchRow && searchRow.appearDate),
      getApplyCount(jobCode),
    ]);

    const facts = score.buildFacts({
      searchRow,
      companyEntry: company.entry,
      companyTotal: company.totalCount,
      applyCnt,
      history,
      jobDetail,
      hrPRLookup: typeof hrPRLookup === 'number' ? hrPRLookup : null,
    });
    scheduleStatsLog();
    return { facts, result: score.scoreJob(facts) };
  }

  /**
   * 先用手上的資料把徽章畫出來,HR 活躍度晚一步到了再換掉。
   *
   * 反查是排隊進行的,一個職缺最多六次請求。如果等它回來才畫徽章,使用者往下捲的
   * 時候會一直看到「分析中」—— 實測捲動速度約每秒 1.3 個職缺,而反查一個職缺
   * 要一到兩秒,等於永遠追不上。基礎資料(應徵人數、互動紀錄、刊登日、開缺數)
   * 只要兩次請求,先畫出來,PR 回來再重畫一次。
   *
   * 重畫會換掉整個徽章元素,所以要把展開狀態帶過去,否則使用者正在看的數據表
   * 會突然收合。
   */
  async function decorateWithLateHrPR({ card, key, loading, searchRow, jobDetail, jobCode }) {
    const alive = () => card.dataset.gjdFor === key;

    const first = await analyse(searchRow, jobDetail, null);
    if (!alive() || !loading.isConnected) {
      loading.remove();
      return;
    }
    let current = badge.render(first.facts, first.result);
    loading.replaceWith(current);

    if (!jobCode || !wantsHrPR(searchRow)) return;

    const pr = await api.lookupHrPR(jobCode);
    if (typeof pr !== 'number' || !alive() || !current.isConnected) return;

    const second = await analyse(searchRow, jobDetail, pr);
    if (!alive() || !current.isConnected) return;
    const next = badge.render(second.facts, second.result);
    badge.setOpen(next, badge.isOpen(current));
    current.replaceWith(next);
  }

  /* ---------- 搜尋結果頁 ---------- */

  function searchParams() {
    // 沿用使用者當前的搜尋條件,只換 page/pagesize
    const p = new URLSearchParams(location.search);
    p.delete('page');
    p.delete('pagesize');
    return p;
  }

  // 多張卡片會同時要求同一頁,必須共用同一個 Promise 並等它完成,
  // 否則後到的呼叫會在資料還沒回來時就以為已經取過了。
  function ensurePage(page) {
    let p = state.pageFetches.get(page);
    if (p) return p;
    p = api
      .searchJobs(searchParams(), page)
      .then((rows) => {
        for (const r of rows) state.rowsByJobNo.set(r.jobNo, r);
        if (rows.length === 0) state.exhausted = true;
        state.maxPage = Math.max(state.maxPage, page);
      })
      .catch(() => {
        state.pageFetches.delete(page); // 失敗後允許重試
      });
    state.pageFetches.set(page, p);
    return p;
  }

  // 一頁 API 實際回傳的筆數不固定(含置頂職缺時會多於 pagesize),
  // 所以不能用卡片索引推算頁碼,改成從第一頁循序往後找。
  async function findRow(jobNo) {
    let row = state.rowsByJobNo.get(jobNo);
    if (row) return row;
    for (let page = 1; page <= state.maxPage + 1 && page <= MAX_PAGES; page++) {
      await ensurePage(page);
      row = state.rowsByJobNo.get(jobNo);
      if (row) return row;
      if (state.exhausted) break;
    }
    return null;
  }

  async function decorateCard(card) {
    const jobNo = card.getAttribute('data-job-no');
    if (!jobNo) return;

    // 卡片被虛擬捲動回收重用時,dataset 會換成別的職缺,要重畫
    if (card.dataset.gjdFor === jobNo) return;
    card.dataset.gjdFor = jobNo;
    const old = card.querySelector(':scope > .gjd-badge');
    if (old) old.remove();

    const anchor = card.querySelector('.info-job') || card.querySelector('h2');
    if (!anchor) return;

    const loading = badge.renderLoading();
    anchor.after(loading);

    const row = await findRow(jobNo);

    // 卡片可能在等待期間已被回收
    if (card.dataset.gjdFor !== jobNo || !loading.isConnected) {
      loading.remove();
      return;
    }
    if (!row) {
      loading.replaceWith(badge.renderError('找不到這個職缺的資料'));
      return;
    }

    try {
      await decorateWithLateHrPR({
        card,
        key: jobNo,
        loading,
        searchRow: row,
        jobDetail: null,
        jobCode: row.jobCode,
      });
    } catch (e) {
      if (loading.isConnected) {
        loading.replaceWith(badge.renderError('分析失敗,104 的資料格式可能已變更'));
      }
    }
  }

  /* ---------- 捲到哪、算到哪 ----------
   *
   * 104 的搜尋頁一次就把整頁二十幾張卡片全放進 DOM,不是虛擬捲動。原本掃到就分析,
   * 首屏等於同時送出七八十次請求 —— 實測日誌是「本輪 21 個職缺 · 送出 48 次請求」,
   * 而且那一輪 PR 快取一筆都沒命中:大家同時起跑,誰也等不到別人灌進來的資料。
   *
   * 改成進入視口(含 300px 預備距離)才排隊。首屏只算看得見的那幾張,往下捲時
   * 後面的卡片還能吃到前面已經灌好的快取。
   */
  const VIEWPORT_MARGIN = '1200px 0px';
  let viewportObserver = null;
  const viewportPending = new WeakMap();

  function observeInViewport(cards, decorate) {
    if (!viewportObserver) {
      viewportObserver = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            viewportObserver.unobserve(e.target);
            const fn = viewportPending.get(e.target);
            if (fn) {
              viewportPending.delete(e.target);
              fn();
            }
          }
        },
        { rootMargin: VIEWPORT_MARGIN }
      );
    }
    for (const card of cards) {
      if (viewportPending.has(card)) continue; // 已經排過隊了
      viewportPending.set(card, () => decorate(card));
      viewportObserver.observe(card);
    }
  }

  function scanSearchPage() {
    if (!state.enabled) return;
    const cards = [...document.querySelectorAll('.job-summary[data-job-no]')].filter(
      // 已經畫好而且還是同一個職缺的卡片不必再排;被回收換成別的職缺時會重新進來
      (card) => card.dataset.gjdFor !== card.getAttribute('data-job-no')
    );
    observeInViewport(cards, decorateCard);
  }

  /* ---------- 公司頁的「工作機會」列表 ---------- */

  // 公司頁沒有 data-job-no,改用職缺連結裡的 base36 代碼當識別;
  // 公司職缺 API 本來就以這個代碼為 key,反而更直接。
  function companyCardJobCode(card) {
    const a = card.querySelector('a[href*="/job/"]');
    return a ? u.jobCodeFromUrl(a.getAttribute('href') || a.href) : null;
  }

  async function decorateCompanyCard(card, custCode, custName) {
    const jobCode = companyCardJobCode(card);
    if (!jobCode) return;
    if (card.dataset.gjdFor === jobCode) return;
    card.dataset.gjdFor = jobCode;
    const old = card.querySelector(':scope .gjd-badge');
    if (old) old.remove();

    const anchor = card.querySelector('.info-job') || card.querySelector('h2');
    if (!anchor) return;

    const loading = badge.renderLoading();
    anchor.after(loading);

    try {
      // 職缺本身的資料來自公司 API,應徵人數由應徵分析端點補
      await decorateWithLateHrPR({
        card,
        key: jobCode,
        loading,
        searchRow: { jobCode, custCode, custName },
        jobDetail: null,
        jobCode,
      });
    } catch (e) {
      if (loading.isConnected) {
        loading.replaceWith(badge.renderError('分析失敗,104 的資料格式可能已變更'));
      }
    }
  }

  function scanCompanyPage() {
    if (!state.enabled) return;
    const custCode = u.custCodeFromUrl(location.pathname);
    if (!custCode) return;
    const h1 = document.querySelector('h1');
    const custName = h1 ? h1.textContent.trim() : null;
    const cards = [...document.querySelectorAll('.job-list-container--cprofile')].filter(
      (card) => !card.dataset.gjdFor || card.dataset.gjdFor !== companyCardJobCode(card)
    );
    observeInViewport(cards, (card) => decorateCompanyCard(card, custCode, custName));
  }

  /**
   * 只知道 base36 職缺代碼時的分析路徑。
   * 職缺詳細頁 API 沒有 applyCnt,也沒有 interactionRecord 的解析結果 ——
   * analyse() 會用 custCode 去公司 API 拿互動紀錄,再由應徵分析端點補應徵人數。
   * 職缺內頁與推薦頁共用這條路。
   */
  function pseudoRowOf(jobCode, detail) {
    return {
      jobCode,
      jobName: detail.jobName,
      custName: detail.custName,
      custCode: detail.custCode,
      appearDate: detail.appearDate,
      hrBehaviorPR: detail.hrBehaviorPR,
      hasHrBehavior: detail.hasHrBehavior,
      analysisType: detail.analysisType,
    };
  }

  async function analyseByJobCode(jobCode, detail, hrPRLookup) {
    return analyse(pseudoRowOf(jobCode, detail), detail, hrPRLookup);
  }

  /* ---------- AI 推薦頁 ---------- */

  // 推薦頁的卡片 DOM 跟搜尋頁一模一樣(.job-summary[data-job-no]),但資料來源不同:
  // 它的 data-job-no 是數字 ID,而且推薦 API 需要頁面自己維護的 jobNos 排除清單,
  // 我們重建不出來。所以改走卡片連結裡的 base36 代碼 + 職缺內頁 API,
  // 跟職缺內頁徽章同一條路徑。
  async function decorateRecommendCard(card) {
    const a = card.querySelector('a[href*="/job/"]');
    const jobCode = a ? u.jobCodeFromUrl(a.getAttribute('href') || a.href) : null;
    if (!jobCode) return;
    if (card.dataset.gjdFor === jobCode) return;
    card.dataset.gjdFor = jobCode;
    const old = card.querySelector(':scope .gjd-badge');
    if (old) old.remove();

    const anchor = card.querySelector('.info-job') || card.querySelector('h2');
    if (!anchor) return;

    const loading = badge.renderLoading();
    anchor.after(loading);

    try {
      const detail = await api.jobContent(jobCode);
      // 卡片可能在等待期間被回收
      if (card.dataset.gjdFor !== jobCode || !loading.isConnected) {
        loading.remove();
        return;
      }
      if (!detail) {
        loading.replaceWith(badge.renderError('無法取得這個職缺的資料'));
        return;
      }
      await decorateWithLateHrPR({
        card,
        key: jobCode,
        loading,
        searchRow: pseudoRowOf(jobCode, detail),
        jobDetail: detail,
        jobCode,
      });
    } catch (e) {
      if (loading.isConnected) {
        loading.replaceWith(badge.renderError('分析失敗,104 的資料格式可能已變更'));
      }
    }
  }

  function scanRecommendPage() {
    if (!state.enabled) return;
    observeInViewport([...document.querySelectorAll('.job-summary[data-job-no]')], decorateRecommendCard);
  }

  /* ---------- 職缺詳細頁 ---------- */

  async function decorateJobPage() {
    if (!state.enabled) return;
    const jobCode = u.jobCodeFromUrl(location.pathname);
    if (!jobCode) return;

    const header = document.querySelector('.job-header__title') || document.querySelector('.job-header');
    if (!header || header.dataset.gjdFor === jobCode) return;
    header.dataset.gjdFor = jobCode;
    const old = document.querySelector('.gjd-badge--page');
    if (old) old.remove();

    const detail = await api.jobContent(jobCode);
    if (!detail) {
      const err = badge.renderError('無法取得這個職缺的資料,104 的資料格式可能已變更');
      err.classList.add('gjd-badge--page');
      header.append(err);
      return;
    }

    // 內頁只有一個職缺,但反查仍要一兩秒,一樣先畫基礎徽章再補 HR 活躍度
    const first = await analyseByJobCode(jobCode, detail, null);
    let el = badge.render(first.facts, first.result);
    el.classList.add('gjd-badge--page');
    header.append(el);

    const pr = await api.lookupHrPR(jobCode);
    if (typeof pr !== 'number' || header.dataset.gjdFor !== jobCode || !el.isConnected) return;
    const second = await analyseByJobCode(jobCode, detail, pr);
    if (header.dataset.gjdFor !== jobCode || !el.isConnected) return;
    const next = badge.render(second.facts, second.result);
    next.classList.add('gjd-badge--page');
    badge.setOpen(next, badge.isOpen(el));
    el.replaceWith(next);
  }

  /* ---------- 啟動 ---------- */

  function route() {
    if (location.pathname.startsWith('/jobs/search')) {
      scanSearchPage();
    } else if (location.pathname.startsWith('/jobs/recommend')) {
      scanRecommendPage();
    } else if (/^\/job\/[0-9a-z]+/i.test(location.pathname)) {
      decorateJobPage();
    } else if (/^\/company\/[0-9a-z]+/i.test(location.pathname)) {
      scanCompanyPage();
    }
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      route();
    });
  }

  async function init() {
    const box = await chrome.storage.local.get('gjd:enabled');
    state.enabled = box['gjd:enabled'] !== false;
    if (!state.enabled) return;

    u.noteActiveDay();

    route();

    // 虛擬捲動會不斷替換卡片內容,靠 MutationObserver 補上徽章
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-job-no'],
    });

    // 104 是 SPA,換頁不會重新載入。
    // 只看 pathname + query:公司頁切換頁籤只改 hash,不需要整批重畫。
    const routeKey = () => location.pathname + location.search;
    let lastUrl = routeKey();
    setInterval(() => {
      if (routeKey() !== lastUrl) {
        lastUrl = routeKey();
        state.rowsByJobNo.clear();
        state.pageFetches.clear();
        state.maxPage = 0;
        state.exhausted = false;
        document.querySelectorAll('[data-gjd-for]').forEach((e) => delete e.dataset.gjdFor);
        document.querySelectorAll('.gjd-badge').forEach((e) => e.remove());
        schedule();
      }
    }, 800);
  }

  init();
})();
