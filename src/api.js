/* 104 公開 API 封裝。content script 跑在 www.104.com.tw 底下,全部是同源請求。 */
var GJD = (function (ns) {
  const u = ns.util;
  const queue = u.makeQueue(2, 250); // 同時最多 2 個請求,每個間隔 250ms
  const COMPANY_TTL = 6 * 60 * 60 * 1000; // 公司資料快取 6 小時
  const SEARCH_TTL = 5 * 60 * 1000;

  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return res.json();
  }

  /**
   * 搜尋 API — 一次拿 20 筆職缺的 appearDate / applyCnt / hrBehaviorPR。
   * @param {URLSearchParams} params 直接沿用使用者當前搜尋頁的查詢條件
   */
  async function searchJobs(params, page) {
    const p = new URLSearchParams(params);
    p.set('page', String(page));
    p.set('pagesize', '20');
    const url = 'https://www.104.com.tw/jobs/search/api/jobs?' + p.toString();

    const key = 'search:' + url;
    const cached = await u.cacheGet(key, SEARCH_TTL);
    if (cached) return cached;

    const json = await queue(() => getJson(url));
    const rows = (json.data || []).map((x) => ({
      jobNo: String(x.jobNo),
      jobCode: u.jobCodeFromUrl(x.link && x.link.job),
      jobName: x.jobName,
      custName: x.custName,
      custCode: u.custCodeFromUrl(x.link && x.link.cust),
      appearDate: x.appearDate,
      applyCnt: x.applyCnt,
      hrBehaviorPR: x.hrBehaviorPR,
      salaryLow: x.salaryLow,
      salaryHigh: x.salaryHigh,
    }));
    await u.cacheSet(key, rows);
    return rows;
  }

  const COMPANY_PAGE_SIZE = 100;

  /**
   * 公司職缺 API — 這裡才有 interactionRecord(HR 上次處理履歷/回覆應徵者的時間)。
   * 大公司可能有數百個職缺,所以要分頁取;呼叫端負責往後翻到找到目標職缺為止。
   * 回傳 { totalCount, totalPages, byJobCode: { [base36]: {...} } }
   */
  async function companyJobs(custCode, page) {
    if (!custCode) return null;
    const pageNo = page || 1;
    const key = 'cust:' + custCode + ':' + pageNo;
    const cached = await u.cacheGet(key, COMPANY_TTL);
    if (cached) return cached;

    const url =
      'https://www.104.com.tw/api/companies/' +
      encodeURIComponent(custCode) +
      '/jobs?page=' +
      pageNo +
      '&pageSize=' +
      COMPANY_PAGE_SIZE;

    let json;
    try {
      json = await queue(() => getJson(url));
    } catch (e) {
      return null;
    }

    const d = (json && json.data) || {};
    const list = d.list || {};
    const jobs = [].concat(list.topJobs || [], list.normalJobs || []);
    const byJobCode = {};
    for (const j of jobs) {
      const code = j.jobNo || u.jobCodeFromUrl(j.jobUrl);
      if (!code) continue;
      byJobCode[code] = {
        interactionRecord: j.interactionRecord || null,
        hrBehaviorPR: j.hrBehaviorPR,
        appearDate: j.appearDate,
        jobName: j.jobName,
      };
    }
    const out = {
      totalCount: typeof d.totalCount === 'number' ? d.totalCount : jobs.length,
      totalPages: typeof d.totalPages === 'number' ? d.totalPages : 1,
      byJobCode,
    };
    await u.cacheSet(key, out);
    return out;
  }

  /** 職缺詳細頁 API */
  async function jobContent(jobCode) {
    const key = 'job:' + jobCode;
    const cached = await u.cacheGet(key, SEARCH_TTL);
    if (cached) return cached;
    let json;
    try {
      json = await queue(() =>
        getJson('https://www.104.com.tw/job/ajax/content/' + encodeURIComponent(jobCode))
      );
    } catch (e) {
      return null;
    }
    const d = (json && json.data) || {};
    const h = d.header || {};
    const out = {
      jobName: h.jobName,
      custName: h.custName,
      custCode: u.custCodeFromUrl(h.custUrl),
      appearDate: h.appearDate,
      hrBehaviorPR: h.hrBehaviorPR,
      closeDate: d.closeDate,
      employees: d.employees,
    };
    await u.cacheSet(key, out);
    return out;
  }

  ns.api = { searchJobs, companyJobs, jobContent };
  return ns;
})(typeof GJD === 'undefined' ? {} : GJD);
