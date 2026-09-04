/* 幽靈職缺評分。
 *
 * 原則:分數只是排序用的摘要,真正要給求職者看的是「事實」(HR 幾天沒處理履歷、
 * 近 30 天內有沒有站內回覆紀錄、掛了幾天)。誤判把真職缺標成假的,對雙方都是傷害,
 * 所以 UI 一律同時呈現原始數據,讓使用者自己判斷。
 */
var GJD = (function (ns) {
  const u = ns.util;

  /**
   * @param {object} f 事實集合
   *   hrBehaviorPR   0~1,104 內部的 HR 活躍度百分位
   *   daysSinceProcessed  HR 上次處理履歷距今天數(null = 近 30 天內無紀錄)
   *   daysSinceReply      公司上次透過 104 回覆應徵者距今天數(null = 近 30 天內無紀錄)
   *
   * 這兩個欄位是滾動時間窗,不是全部歷史。2026-09 改版後兩者都是 30 天
   *(實測 1,056 筆,「N 天內」的最大值都正好是 30;改版前回覆窗是 90 天)。
   * 所以 null 代表「這段期間內沒有」,不是「從來沒有」。
   * 而且 104 只看得到站內訊息 —— HR 直接打電話或寄 email 不會被記錄。
   *   hasInteraction      是否有拿到 interactionRecord
   *   postedDays     刊登(最後更新)距今天數
   *   applyCnt       應徵人數
   *   openJobs       公司目前總開缺數
   *   repostCount    我們觀察期間看到它重新刊登的次數
   *   salaryUndisclosed 是否待遇面議
   */
  function scoreJob(f) {
    let score = 0;
    const reasons = [];

    // 近期沒人應徵、而且站內也沒有任何互動紀錄時,這兩個 null 沒有指控任何事,
    // 不該拿來扣分。條件必須同時成立:實測 63 個 0 人應徵的職缺裡有 44 個帶著
    // 非 null 的互動紀錄(applyCnt 與 interactionRecord 的統計窗口不同),
    // 只看 applyCnt === 0 就整組關掉,會把真實的紀錄一起蓋掉。
    const quietWithNoRecord =
      f.applyCnt === 0 && f.daysSinceProcessed === null && f.daysSinceReply === null;

    function add(points, text, kind) {
      score += points;
      reasons.push({ points, text, kind: kind || 'warn' });
    }

    // 1. HR 活躍度(104 自己算的分數,最直接)
    if (typeof f.hrBehaviorPR === 'number') {
      if (f.hrBehaviorPR < 0.3) {
        add(30, `HR 活躍度僅贏過 ${Math.round(f.hrBehaviorPR * 100)}% 的公司`);
      } else if (f.hrBehaviorPR < 0.5) {
        add(15, `HR 活躍度偏低(PR ${Math.round(f.hrBehaviorPR * 100)})`);
      } else if (f.hrBehaviorPR >= 0.8) {
        reasons.push({
          points: 0,
          text: `HR 活躍度高(PR ${Math.round(f.hrBehaviorPR * 100)})`,
          kind: 'good',
        });
      }
    }

    // 2. 上次處理履歷的時間 —— 最能反映「這個缺還有沒有人在看」
    if (f.hasInteraction && quietWithNoRecord) {
      reasons.push({
        points: 0,
        text: '近期無人應徵,104 站內也沒有互動紀錄,無從判斷 HR 的行為',
        kind: 'info',
      });
    } else if (f.hasInteraction) {
      // 門檻依實測分布訂:91% 的職缺在 7 天內處理過履歷,超過 7 天已是最差的 9.4%,
      // 超過 14 天是最差的 3.4%,而 null 代表落在 30 天的窗外,是最差的一檔。
      const d = f.daysSinceProcessed;
      if (d === null) {
        add(30, '近 30 天內沒有處理過任何履歷');
      } else if (d > 14) {
        add(22, `已經 ${d} 天沒有處理履歷`);
      } else if (d > 7) {
        add(14, `${d} 天沒有處理履歷`);
      } else {
        reasons.push({
          points: 0,
          text: `${u.withinDaysText(d)}處理過履歷`,
          kind: 'good',
        });
      }

      // 3. 有沒有透過 104 回覆應徵者 —— 呈現,但不計分。
      //    104 只記錄得到站內訊息的往來,很多 HR 是直接打電話或寄 email 聯絡應徵者,
      //    那些完全不會出現在這裡。既然「無紀錄」有一個完全無辜的解釋,
      //    就不該拿它扣分,只把事實擺出來讓使用者自己判斷。
      if (f.daysSinceReply === null) {
        reasons.push({
          points: 0,
          text: '近 30 天內沒有透過 104 回覆應徵者(HR 也可能是用電話或 email 聯絡)',
          kind: 'info',
        });
      } else {
        reasons.push({
          points: 0,
          text: `${u.withinDaysText(f.daysSinceReply)}透過 104 回覆過應徵者`,
          kind: f.daysSinceReply > 30 ? 'info' : 'good',
        });
      }
    }

    // 4. 刊登時長(104 只顯示「更新日期」,長期掛著的缺很容易被忽略)
    if (typeof f.postedDays === 'number') {
      if (f.postedDays > 90) add(18, `已刊登 ${f.postedDays} 天`);
      else if (f.postedDays > 60) add(12, `已刊登 ${f.postedDays} 天`);
      else if (f.postedDays > 30) add(6, `已刊登 ${f.postedDays} 天`);
    }

    // 5. 收了一堆履歷卻沒在處理
    if (f.applyCnt >= 50 && f.daysSinceProcessed !== null && f.daysSinceProcessed > 7) {
      add(10, `已有 ${f.applyCnt} 人應徵,但 HR 超過一週沒處理`);
    }

    // 6. 公司同時開的缺數(養人才庫的常見特徵)
    if (typeof f.openJobs === 'number') {
      if (f.openJobs > 30) add(10, `這家公司同時開 ${f.openJobs} 個缺`);
      else if (f.openJobs > 15) add(5, `這家公司同時開 ${f.openJobs} 個缺`);
    }

    // 7. 重新刊登 —— 由本外掛長期觀察得到,104 頁面上看不到
    if (f.repostCount >= 2) {
      add(15, `觀察期間重新刊登過 ${f.repostCount} 次`);
    }

    // 8. 待遇面議(弱訊號,只加一點點)
    if (f.salaryUndisclosed) add(4, '待遇面議');

    score = Math.max(0, Math.min(100, score));

    let level, label;
    if (score >= 65) {
      level = 'red';
      label = '高風險';
    } else if (score >= 40) {
      level = 'orange';
      label = '可疑';
    } else if (score >= 20) {
      level = 'yellow';
      label = '留意';
    } else {
      level = 'green';
      label = '正常';
    }

    return { score, level, label, reasons, opportunity: detectOpportunity(f, score) };
  }

  /* ---------- 正向訊號:值得優先投的缺 ----------
   *
   * 「應徵人數少」單獨看沒有意義 —— 實測 1,144 筆,3 人以下的職缺佔 54%,
   * 而且刊登天數中位數(4 天)並沒有比 11–30 人那組(3 天)新,
   * 也就是說少人應徵不代表新刊登,反而有 16.6% 是「掛了三週還沒人投」的滯銷缺。
   *
   * 真正有意義的是三個條件的交集:沒什麼人投、缺是新的、而且 HR 這幾天真的在看履歷。
   * 這時候搶先投才有意義。實測交集約佔 30%。
   */

  const OPP_MAX_APPLY = 3;
  const OPP_MAX_POSTED_DAYS = 7;
  const OPP_MAX_PROCESSED_DAYS = 7;
  // 比「正常」(0–19)更嚴:公司同時開 30 個缺就 +10,那種養人才庫的缺不該掛正向徽章
  const OPP_MAX_SCORE = 9;

  function detectOpportunity(f, score) {
    // 只在幾乎沒有風險訊號時才敢講「機會」,否則等於自打嘴巴
    if (score > OPP_MAX_SCORE) return null;
    if (typeof f.applyCnt !== 'number' || f.applyCnt > OPP_MAX_APPLY) return null;
    if (typeof f.postedDays !== 'number' || f.postedDays > OPP_MAX_POSTED_DAYS) return null;
    if (f.daysSinceProcessed === null || f.daysSinceProcessed > OPP_MAX_PROCESSED_DAYS) {
      return null;
    }
    return {
      reasons: [
        `目前只有 ${f.applyCnt} 人應徵`,
        `${u.daysAgoText(f.postedDays)}刊登`,
        `HR ${u.withinDaysText(f.daysSinceProcessed)}處理過履歷`,
      ],
    };
  }

  /** 把各來源的原始資料整理成 scoreJob 需要的事實集合 */
  function buildFacts({ searchRow, companyEntry, companyTotal, applyCnt, history, jobDetail }) {
    const src = searchRow || {};
    const ce = companyEntry || {};
    // 互動紀錄三個來源都可能有:公司職缺 API、搜尋結果列、職缺內頁
    const ir =
      ce.interactionRecord ||
      (src && src.interactionRecord) ||
      (jobDetail && jobDetail.interactionRecord) ||
      null;

    /* 104 於 2026-09 改版:interactionRecord 的三個時間戳全部歸零,真正的資料改放進
     * lastProcessedResumeDesc / lastCustReplyDesc 兩個中文字串;同時 applyCnt 與
     * hrBehaviorPR 也一併變成 0(實測 792 筆無一例外)。
     *
     * 用「有沒有 Desc 這個 key」判斷格式,而不是看值是不是 0 ——
     * 真的沒有互動紀錄的職缺也會是 0,兩者必須分得開。
     * 這樣寫還有一個好處:104 若改回舊格式,會自動走回時間戳那條路,不必再改一次。
     */
    const descApi = !!ir && 'lastProcessedResumeDesc' in ir;

    const now = ir && ir.nowTimestamp ? ir.nowTimestamp : Date.now() / 1000;

    const appearRaw = src.appearDate || (jobDetail && jobDetail.appearDate) || ce.appearDate;
    const appearDate = u.parseAppearDate(appearRaw);

    const hrPRRaw =
      typeof src.hrBehaviorPR === 'number'
        ? src.hrBehaviorPR
        : typeof ce.hrBehaviorPR === 'number'
          ? ce.hrBehaviorPR
          : jobDetail && typeof jobDetail.hrBehaviorPR === 'number'
            ? jobDetail.hrBehaviorPR
            : null;
    // PR 0 代表「贏過 0% 的公司」,是最重的一項扣分(+30)。104 改版後這個欄位
    // 恆為 0,把「沒給資料」當成「墊底」會冤枉每一個職缺 —— 真的墊底的是極少數,
    // 誤判的代價卻是全部,所以 0 一律視為無資料。
    const hrPR = hrPRRaw === 0 ? null : hrPRRaw;

    return {
      jobName: src.jobName || ce.jobName || (jobDetail && jobDetail.jobName),
      custName: src.custName || (jobDetail && jobDetail.custName),
      hrBehaviorPR: hrPR,
      hasInteraction: !!ir,
      daysSinceProcessed: !ir
        ? null
        : descApi
          ? u.parseInteractionDesc(ir.lastProcessedResumeDesc)
          : u.daysSinceTs(ir.lastProcessedResumeAtTime, now),
      daysSinceReply: !ir
        ? null
        : descApi
          ? u.parseInteractionDesc(ir.lastCustReplyDesc)
          : u.daysSinceTs(ir.lastCustReplyTimestamp, now),
      postedDays: u.daysSince(appearDate),
      appearDateText: u.formatDate(appearDate) || appearRaw || null,
      // 新格式下 applyCnt 恆為 0(實測 792/792),而 104 頁面上同一個職缺仍顯示
      // 「6~10 人應徵」—— 那是「不再提供」,不是「沒有人應徵」。
      // 照著顯示「0 人」會是不實陳述,所以一律當成取不到。
      applyCnt: descApi
        ? null
        : typeof src.applyCnt === 'number'
          ? src.applyCnt
          : typeof applyCnt === 'number'
            ? applyCnt
            : null,
      openJobs: typeof companyTotal === 'number' ? companyTotal : null,
      repostCount: history ? history.repostCount || 0 : 0,
      firstSeen: history ? history.firstSeen : null,
      salaryUndisclosed: src.salaryLow === 0 && src.salaryHigh === 0,
    };
  }

  ns.score = { scoreJob, buildFacts };
  return ns;
})(typeof GJD === 'undefined' ? {} : GJD);
