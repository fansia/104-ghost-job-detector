/* 主流程:偵測頁面類型 → 取資料 → 整理成事實 → 注入徽章。 */
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
    hidden: null, // 隱藏規則,init 時載入,storage 變動時更新
    /* 使用者在摺疊列上按過「顯示」的卡片。只活在這一次瀏覽,不寫進 storage ——
     * 那是「這張我想看一下」,不是「取消這條規則」。被放行的卡片右上角那顆鈕
     * 會變成「解除隱藏」,要真的解除規則從那裡走。 */
    overrides: new Set(),
  };

  /* ---------- 隱藏 ---------- */

  /**
   * 決定這張卡片要畫徽章還是摺疊起來。
   * 三個頁面共用,所以掛載點與 key 由呼叫端給。
   */
  function mountBadge(card, facts, key, loading) {
    // 不管有沒有被放行都先算一次:規則是否命中,決定右上角那顆鈕是哪一顆
    const reason = u.hiddenReason(facts, state.hidden);

    if (reason && !state.overrides.has(key)) {
      loading.remove();
      card.classList.add('gjd-card-hidden');
      countHiddenSoon();
      card.prepend(
        badge.renderHiddenBar(facts, reason, {
          onUndo: () => u.undoHidden(reason),
          onReveal: () => {
            state.overrides.add(key);
            resetCard(card);
            schedule();
          },
        })
      );
      return;
    }

    /* 這張卡片明明命中規則卻看得到,代表是被放行出來的 —— 那顆鈕要講「解除隱藏」。
     * 繼續顯示「隱藏」等於謊報狀態:按下去什麼也不會發生(規則本來就在),
     * 使用者只會覺得壞了。 */
    const action = reason
      ? {
          label: '解除隱藏',
          title: `解除:${reason.text}`,
          onClick: () => u.undoHidden(reason),
        }
      : facts.custCode
        ? {
            label: '隱藏',
            title: facts.custName ? `不再顯示「${facts.custName}」的職缺` : '隱藏這家公司的職缺',
            onClick: () => hideCompany(facts),
          }
        : null;

    loading.replaceWith(badge.render(facts, action));
    countHiddenSoon();
  }

  async function hideCompany(facts) {
    /* 放行紀錄整組清掉:使用者說「隱藏」時要的是現在就看不到,
     * 不是「除了我剛才點開的那幾張以外」。 */
    state.overrides.clear();
    const ok = await u.hideCompany(facts.custCode, facts.custName);
    // 保險:值沒變時 storage 的 onChanged 不會發出來,得自己重畫一次
    if (ok) redecorateAll();
  }

  /* ---------- 「這一頁隱藏了幾筆」 ----------
   *
   * 過濾器最怕的是沒有回饋:職缺莫名其妙變少,使用者不會想到是自己設的規則,
   * 只會覺得 104 壞了或外掛壞了。摺疊列講得出單筆,講不出總數。
   *
   * 走 storage 而不是訊息傳遞,是為了不加 tabs 權限 —— 這個外掛目前只要
   * storage 加一個網域,審查時那是加分項,不值得為一個數字放寬。
   */

  const PAGE_HIDDEN_KEY = 'gjd:pageHidden';
  let countTimer = null;

  function countHiddenSoon() {
    if (countTimer) return;
    countTimer = setTimeout(() => {
      countTimer = null;
      const count = document.querySelectorAll('.gjd-card-hidden').length;
      chrome.storage.local
        .set({ [PAGE_HIDDEN_KEY]: { count, at: Date.now() } })
        .catch(() => {});
    }, 400);
  }

  /** 清掉一張卡片上所有外掛留下的東西,讓它可以重畫 */
  function resetCard(card) {
    delete card.dataset.gjdFor;
    card.classList.remove('gjd-card-hidden');
    card.querySelectorAll(':scope > .gjd-hidden-bar').forEach((e) => e.remove());
    card.querySelectorAll('.gjd-badge').forEach((e) => e.remove());
  }

  function redecorateAll() {
    document.querySelectorAll('[data-gjd-for]').forEach(resetCard);
    document.querySelectorAll('.gjd-hidden-bar').forEach((e) => e.remove());
    document.querySelectorAll('.gjd-card-hidden').forEach((e) => e.classList.remove('gjd-card-hidden'));
    schedule();
  }

  /* ---------- 觀察紀錄:記下第一次看到的時間與重新刊登次數 ---------- */

  async function touchHistory(jobCode, appearDate) {
    if (!jobCode) return null;
    const key = 'hist:' + jobCode;
    let h = await u.cacheGet(key);
    const today = new Date().toISOString().slice(0, 10);
    if (!h) {
      h = { firstSeen: today, lastAppear: appearDate || null, repostCount: 0 };
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

  async function analyse(searchRow, jobDetail) {
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
    });
    return facts;
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
    card.classList.remove('gjd-card-hidden');
    card.querySelectorAll(':scope > .gjd-hidden-bar').forEach((e) => e.remove());
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
    try {
      /* 對不上搜尋結果時走職缺內頁 API。
       *
       * decorateCard 只認外掛自己重打的那份搜尋結果,而置頂職缺不隨關鍵字走 ——
       * 重打一次換了別的幾筆,那兩三張卡就永遠對不上。卡片連結裡有 base36 代碼,
       * 職缺內頁 API 自備 interactionRecord 與 analysisType,
       * 跟推薦頁同一條路,不必為此多維護一套資料來源。
       */
      const facts = row ? await analyse(row, null) : await factsFromCardLink(card);
      if (card.dataset.gjdFor !== jobNo || !loading.isConnected) {
        loading.remove();
        return;
      }
      if (!facts) {
        loading.replaceWith(badge.renderError('找不到這個職缺的資料'));
        return;
      }
      mountBadge(card, facts, jobNo, loading);
    } catch (e) {
      loading.replaceWith(badge.renderError('分析失敗,104 的資料格式可能已變更'));
    }
  }

  function scanSearchPage() {
    if (!state.enabled) return;
    document.querySelectorAll('.job-summary[data-job-no]').forEach((card) => {
      decorateCard(card);
    });
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
    card.classList.remove('gjd-card-hidden');
    card.querySelectorAll(':scope > .gjd-hidden-bar').forEach((e) => e.remove());
    const old = card.querySelector(':scope .gjd-badge');
    if (old) old.remove();

    const anchor = card.querySelector('.info-job') || card.querySelector('h2');
    if (!anchor) return;

    const loading = badge.renderLoading();
    anchor.after(loading);

    try {
      // 職缺本身的資料來自公司 API,應徵人數由應徵分析端點補
      const facts = await analyse({ jobCode, custCode, custName }, null);
      if (card.dataset.gjdFor !== jobCode || !loading.isConnected) {
        loading.remove();
        return;
      }
      mountBadge(card, facts, jobCode, loading);
    } catch (e) {
      loading.replaceWith(badge.renderError('分析失敗,104 的資料格式可能已變更'));
    }
  }

  function scanCompanyPage() {
    if (!state.enabled) return;
    const custCode = u.custCodeFromUrl(location.pathname);
    if (!custCode) return;
    const h1 = document.querySelector('h1');
    const custName = h1 ? h1.textContent.trim() : null;
    document.querySelectorAll('.job-list-container--cprofile').forEach((card) => {
      decorateCompanyCard(card, custCode, custName);
    });
  }

  /**
   * 只知道 base36 職缺代碼時的分析路徑。
   * 職缺詳細頁 API 沒有 applyCnt,也沒有 interactionRecord 的解析結果 ——
   * analyse() 會用 custCode 去公司 API 拿互動紀錄,再由應徵分析端點補應徵人數。
   * 職缺內頁與推薦頁共用這條路。
   */
  async function analyseByJobCode(jobCode, detail) {
    const pseudoRow = {
      jobCode,
      jobName: detail.jobName,
      custName: detail.custName,
      custCode: detail.custCode,
      appearDate: detail.appearDate,
      analysisType: detail.analysisType,
    };
    return analyse(pseudoRow, detail);
  }

  /** 只有 base36 代碼可用時的入口:推薦頁、搜尋頁置頂缺共用 */
  async function factsFromJobCode(jobCode) {
    const detail = await api.jobContent(jobCode);
    if (!detail) return null;
    return analyseByJobCode(jobCode, detail);
  }

  /** 從卡片連結取出 base36 代碼再走上面那條路;取不到代碼就回 null */
  async function factsFromCardLink(card) {
    const a = card.querySelector('a[href*="/job/"]');
    const jobCode = a ? u.jobCodeFromUrl(a.getAttribute('href') || a.href) : null;
    return jobCode ? factsFromJobCode(jobCode) : null;
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
    card.classList.remove('gjd-card-hidden');
    card.querySelectorAll(':scope > .gjd-hidden-bar').forEach((e) => e.remove());
    const old = card.querySelector(':scope .gjd-badge');
    if (old) old.remove();

    const anchor = card.querySelector('.info-job') || card.querySelector('h2');
    if (!anchor) return;

    const loading = badge.renderLoading();
    anchor.after(loading);

    try {
      const facts = await factsFromJobCode(jobCode);
      // 卡片可能在等待期間被回收
      if (card.dataset.gjdFor !== jobCode || !loading.isConnected) {
        loading.remove();
        return;
      }
      if (!facts) {
        loading.replaceWith(badge.renderError('無法取得這個職缺的資料'));
        return;
      }
      mountBadge(card, facts, jobCode, loading);
    } catch (e) {
      loading.replaceWith(badge.renderError('分析失敗,104 的資料格式可能已變更'));
    }
  }

  function scanRecommendPage() {
    if (!state.enabled) return;
    document.querySelectorAll('.job-summary[data-job-no]').forEach(decorateRecommendCard);
  }

  /* ---------- 職缺詳細頁 ---------- */

  async function decorateJobPage() {
    if (!state.enabled) return;
    const jobCode = u.jobCodeFromUrl(location.pathname);
    if (!jobCode) return;

    /* 104 改版過標題容器,新舊版都要認:舊版 .job-header,改版後 .jobmobile-header。
     * 順序是「越精確的越前面」,任何一個對上就掛得住。 */
    const header =
      document.querySelector('.job-header__title') ||
      document.querySelector('.job-header') ||
      document.querySelector('.jobmobile-header');
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

    const facts = await analyseByJobCode(jobCode, detail);
    const el = badge.render(facts);
    el.classList.add('gjd-badge--page');
    header.append(el);
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

    state.hidden = await u.getHidden();

    // 在彈出視窗改了規則(或在別的分頁按了隱藏)要立刻反映,不必重整頁面
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes['gjd:hidden']) return;
      u.getHidden().then((h) => {
        state.hidden = h;
        redecorateAll();
      });
    });

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
        state.overrides.clear();
        redecorateAll();
      }
    }, 800);
  }

  init();
})();
