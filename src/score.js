/* 幽靈職缺評分。
 *
 * 原則:分數只是排序用的摘要,真正要給求職者看的是「事實」(HR 幾天沒處理履歷、
 * 從未回覆過應徵者、掛了幾天)。誤判把真職缺標成假的,對雙方都是傷害,
 * 所以 UI 一律同時呈現原始數據,讓使用者自己判斷。
 */
var GJD = (function (ns) {
  const u = ns.util;

  /**
   * @param {object} f 事實集合
   *   hrBehaviorPR   0~1,104 內部的 HR 活躍度百分位
   *   daysSinceProcessed  HR 上次處理履歷距今天數(null = 無紀錄)
   *   daysSinceReply      公司上次回覆應徵者距今天數(null = 從未回覆)
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
    if (f.hasInteraction) {
      const d = f.daysSinceProcessed;
      if (d === null) {
        add(25, '沒有任何處理履歷的紀錄');
      } else if (d > 14) {
        add(25, `已經 ${d} 天沒有處理履歷`);
      } else if (d > 7) {
        add(12, `${d} 天沒有處理履歷`);
      } else {
        reasons.push({
          points: 0,
          text: d <= 1 ? '最近一天內處理過履歷' : `${d} 天前處理過履歷`,
          kind: 'good',
        });
      }

      // 3. 有沒有真的回覆過應徵者(已讀不回的核心指標)
      if (f.daysSinceReply === null) {
        add(20, '從未回覆過任何應徵者');
      } else if (f.daysSinceReply > 90) {
        add(12, `上次回覆應徵者是 ${f.daysSinceReply} 天前`);
      } else if (f.daysSinceReply > 30) {
        add(6, `上次回覆應徵者是 ${f.daysSinceReply} 天前`);
      } else {
        reasons.push({
          points: 0,
          text: `${f.daysSinceReply} 天前回覆過應徵者`,
          kind: 'good',
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

    return { score, level, label, reasons };
  }

  /** 把各來源的原始資料整理成 scoreJob 需要的事實集合 */
  function buildFacts({ searchRow, companyEntry, companyTotal, history, jobDetail }) {
    const src = searchRow || {};
    const ce = companyEntry || {};
    const ir = ce.interactionRecord || null;
    const now = ir && ir.nowTimestamp ? ir.nowTimestamp : Date.now() / 1000;

    const appearRaw = src.appearDate || (jobDetail && jobDetail.appearDate) || ce.appearDate;
    const appearDate = u.parseAppearDate(appearRaw);

    const hrPR =
      typeof src.hrBehaviorPR === 'number'
        ? src.hrBehaviorPR
        : typeof ce.hrBehaviorPR === 'number'
          ? ce.hrBehaviorPR
          : jobDetail && typeof jobDetail.hrBehaviorPR === 'number'
            ? jobDetail.hrBehaviorPR
            : null;

    return {
      jobName: src.jobName || ce.jobName || (jobDetail && jobDetail.jobName),
      custName: src.custName || (jobDetail && jobDetail.custName),
      hrBehaviorPR: hrPR,
      hasInteraction: !!ir,
      daysSinceProcessed: ir ? u.daysSinceTs(ir.lastProcessedResumeAtTime, now) : null,
      daysSinceReply: ir ? u.daysSinceTs(ir.lastCustReplyTimestamp, now) : null,
      postedDays: u.daysSince(appearDate),
      appearDateText: appearRaw,
      applyCnt: typeof src.applyCnt === 'number' ? src.applyCnt : null,
      openJobs: typeof companyTotal === 'number' ? companyTotal : null,
      repostCount: history ? history.repostCount || 0 : 0,
      firstSeen: history ? history.firstSeen : null,
      salaryUndisclosed: src.salaryLow === 0 && src.salaryHigh === 0,
    };
  }

  ns.score = { scoreJob, buildFacts };
  return ns;
})(typeof GJD === 'undefined' ? {} : GJD);
