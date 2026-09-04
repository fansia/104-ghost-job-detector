/* 徽章 UI:在職缺卡片上插入一列風險摘要,點擊展開完整訊號。 */
var GJD = (function (ns) {
  const LEVEL_TEXT = { green: '正常', yellow: '留意', orange: '可疑', red: '高風險' };

  /** 摘要列上最值得一眼看到的兩三個事實 */
  function headlineFacts(f) {
    const out = [];
    // 跟 score.js 用同一個條件:近期沒人應徵又完全沒紀錄時,這些 null 沒有指控任何事
    const quiet =
      (f.applyCnt === 0 || f.applyType === 1) &&
      f.daysSinceProcessed === null &&
      f.daysSinceReply === null;
    if (f.hasInteraction && !quiet) {
      // null 是「時間窗內沒有」,不是「從來沒有」—— 措辭必須守住這個差別
      if (f.daysSinceReply === null) out.push('30 天內無回覆紀錄');
      else if (f.daysSinceReply > 30) out.push(`上次回覆 ${f.daysSinceReply} 天前`);

      if (f.daysSinceProcessed === null) out.push('30 天內無處理紀錄');
      else if (f.daysSinceProcessed > 7) out.push(`${f.daysSinceProcessed} 天沒處理履歷`);
      else out.push(`${GJD.util.withinDaysText(f.daysSinceProcessed)}處理過履歷`);
    }
    if (typeof f.postedDays === 'number' && f.postedDays > 30) {
      out.push(`刊登 ${f.postedDays} 天`);
    }
    if (typeof f.applyCnt === 'number') out.push(`${f.applyCnt} 人應徵`);
    else if (f.applyRangeText) out.push(`${f.applyRangeText}應徵`);
    return out.slice(0, 3);
  }

  function buildDetail(f, result) {
    const rows = [];
    const push = (label, value) => rows.push({ label, value });

    // 104 停止下發 PR 數值後,只剩 hasHrBehavior 這個布林值(近似 PR >= 0.7,見 score.js)。
    // false 分不出「中段班」和「墊底」,措辭不能寫成「不活躍」。
    // 「前 30%」是隨機抽樣量到的(true 佔 27%、PR>=0.7 佔 30%),不是從門檻反推的。
    push(
      'HR 活躍度',
      typeof f.hrBehaviorPR === 'number'
        ? `PR ${Math.round(f.hrBehaviorPR * 100)}(104 內部指標)`
        : f.hrActive === true
          ? '積極徵才中(104 標準:活躍度前 30%)'
          : f.hrActive === false
            ? '未達 104 的「積極徵才中」標準'
            : '無資料'
    );
    push(
      '上次處理履歷',
      !f.hasInteraction
        ? '無資料'
        : f.daysSinceProcessed !== null
          ? GJD.util.withinDaysText(f.daysSinceProcessed)
          : '近 30 天內無紀錄'
    );
    push(
      '上次回覆(104 站內)',
      !f.hasInteraction
        ? '無資料'
        : f.daysSinceReply !== null
          ? GJD.util.withinDaysText(f.daysSinceReply)
          : '近 30 天內無紀錄'
    );
    // 刊登日是日曆日期,要用 daysAgoText(0 = 今天),不能寫成「0 天前」
    push(
      '刊登(更新)日期',
      f.appearDateText
        ? typeof f.postedDays === 'number'
          ? `${f.appearDateText}(${GJD.util.daysAgoText(f.postedDays)})`
          : f.appearDateText
        : '無資料'
    );
    // 抓不到就明講。整列消失會讓使用者以為是 0 人應徵,或以為外掛壞了。
    // 104 於 2026-09 移除精確人數,只剩級距。有級距就顯示級距,兩者都沒有才說取不到。
    push(
      '應徵人數',
      typeof f.applyCnt === 'number'
        ? `${f.applyCnt} 人`
        : f.applyRangeText
          ? f.applyRangeText
          : '無法取得'
    );
    if (typeof f.openJobs === 'number') push('公司目前開缺', `${f.openJobs} 個`);
    if (f.repostCount) push('觀察到重新刊登', `${f.repostCount} 次`);

    const el = document.createElement('div');
    el.className = 'gjd-detail';

    const table = document.createElement('div');
    table.className = 'gjd-detail__grid';
    for (const r of rows) {
      const k = document.createElement('div');
      k.className = 'gjd-detail__k';
      k.textContent = r.label;
      const v = document.createElement('div');
      v.className = 'gjd-detail__v';
      v.textContent = r.value;
      table.append(k, v);
    }
    el.append(table);

    if (result.opportunity) {
      const ul = document.createElement('ul');
      ul.className = 'gjd-detail__reasons';
      for (const t of result.opportunity.reasons) {
        const li = document.createElement('li');
        li.className = 'gjd-reason gjd-reason--good';
        li.textContent = '✓ ' + t;
        ul.append(li);
      }
      const li = document.createElement('li');
      li.className = 'gjd-reason gjd-reason--info';
      li.textContent = '• 少人應徵、新刊登、HR 近期在看履歷 —— 搶先投遞比較有機會';
      ul.append(li);
      el.append(ul);
    }

    if (result.reasons.length) {
      const ul = document.createElement('ul');
      ul.className = 'gjd-detail__reasons';
      for (const r of result.reasons) {
        const li = document.createElement('li');
        li.className = 'gjd-reason gjd-reason--' + r.kind;
        li.textContent = (r.kind === 'good' ? '✓ ' : '• ') + r.text;
        ul.append(li);
      }
      el.append(ul);
    }

    const note = document.createElement('p');
    note.className = 'gjd-detail__note';
    note.textContent =
      '資料來自 104 網頁自己使用的內部 API,僅供參考。處理履歷與回覆都是 30 天的滾動紀錄,' +
      '「無紀錄」是指這段期間內沒有,不是從來沒有;HR 若以電話或 email 聯絡,104 也不會記錄。' +
      '另外「處理履歷」不一定是真人動作,系統自動配對可能也算在內。' +
      '分數高不代表這是假職缺,請搭配上面的原始數據自行判斷。';
    el.append(note);
    return el;
  }

  /* ---------- 商店評價邀請 ----------
   * 只在使用者已經用順手、而且正在展開數據表時出現一次(門檻見 util.js)。
   *
   * 兩件刻意不做的事:
   * 1. 不指定星數。Chrome 商店的政策禁止操縱評分,文案只能請人「留下評價」。
   * 2. 不做評價分流(先問喜不喜歡、喜歡才帶去商店)。挑「時機」可以,篩「對象」不行。
   */

  const REVIEW_URL =
    'https://chromewebstore.google.com/detail/ollabfbopbnckocijfnahjeaoalbnbej/reviews';

  let askShownThisPage = false;

  function buildReviewAsk() {
    const box = document.createElement('div');
    box.className = 'gjd-ask';

    const text = document.createElement('p');
    text.className = 'gjd-ask__text';
    text.textContent = '這個外掛有幫上忙嗎?到 Chrome 商店留幾句話,可以幫其他求職者找到它。';

    const actions = document.createElement('p');
    actions.className = 'gjd-ask__actions';

    // 104 的職缺卡片本身可能是連結,點任何地方都可能導航 —— 一律擋掉冒泡
    const go = document.createElement('a');
    go.className = 'gjd-ask__go';
    go.href = REVIEW_URL;
    go.target = '_blank';
    go.rel = 'noopener noreferrer';
    go.textContent = '前往評價';
    go.addEventListener('click', (e) => {
      e.stopPropagation();
      GJD.util.markReview('clicked');
      box.remove();
    });

    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'gjd-ask__no';
    no.textContent = '不用了';
    no.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      GJD.util.markReview('dismissed');
      box.remove();
    });

    actions.append(go, no);
    box.append(text, actions);
    return box;
  }

  /** 展開數據表時呼叫:記一次展開,必要時附上評價邀請。 */
  async function maybeAskForReview(detail) {
    try {
      await GJD.util.noteExpand();
      if (askShownThisPage) return;
      if (!(await GJD.util.shouldAskReview())) return;
      if (detail.hidden) return; // 使用者已經收回去了,不要事後才冒出來
      askShownThisPage = true;
      detail.append(buildReviewAsk());
    } catch (e) {
      /* 邀請只是加分項,壞掉不能影響徽章本身 */
    }
  }

  /** 建立(或更新)一張卡片的徽章元素 */
  function render(facts, result) {
    const opp = result.opportunity;
    const wrap = document.createElement('div');
    wrap.className = 'gjd-badge gjd-badge--' + (opp ? 'opportunity' : result.level);

    const bar = document.createElement('button');
    bar.type = 'button';
    bar.className = 'gjd-bar';

    const pill = document.createElement('span');
    pill.className = 'gjd-pill';
    pill.textContent = opp ? '✦ 機會' : LEVEL_TEXT[result.level] + ' ' + result.score;

    const facesEl = document.createElement('span');
    facesEl.className = 'gjd-facts';
    // 是機會缺就把三個成立的條件講出來,而不是重複「正常」的風險摘要
    facesEl.textContent = (opp ? opp.reasons : headlineFacts(facts)).join(' ・ ');

    const caret = document.createElement('span');
    caret.className = 'gjd-caret';
    caret.textContent = '▾';

    bar.append(pill, facesEl, caret);
    wrap.append(bar);

    const detail = buildDetail(facts, result);
    detail.hidden = true;
    wrap.append(detail);

    bar.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      detail.hidden = !detail.hidden;
      caret.textContent = detail.hidden ? '▾' : '▴';
      if (!detail.hidden) maybeAskForReview(detail);
    });

    return wrap;
  }

  function renderLoading() {
    const wrap = document.createElement('div');
    wrap.className = 'gjd-badge gjd-badge--loading';
    wrap.textContent = '分析中…';
    return wrap;
  }

  /**
   * 抓不到資料時顯示的徽章。
   * 這裡刻意不沉默:徽章直接消失的話,使用者無從分辨是「這個職缺沒有資料」、
   * 「外掛壞了」還是「104 改版了」,只會覺得工具時好時壞。
   */
  function renderError(text) {
    const wrap = document.createElement('div');
    wrap.className = 'gjd-badge gjd-badge--error';
    wrap.textContent = text || '無法取得這個職缺的資料';
    return wrap;
  }

  ns.badge = { render, renderLoading, renderError };
  return ns;
})(typeof GJD === 'undefined' ? {} : GJD);
