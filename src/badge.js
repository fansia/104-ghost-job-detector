/* 徽章 UI:在職缺卡片上插入一列風險摘要,點擊展開完整訊號。 */
var GJD = (function (ns) {
  const LEVEL_TEXT = { green: '正常', yellow: '留意', orange: '可疑', red: '高風險' };

  /** 摘要列上最值得一眼看到的兩三個事實 */
  function headlineFacts(f) {
    const out = [];
    // 跟 score.js 用同一個條件:近期沒人應徵又完全沒紀錄時,這些 null 沒有指控任何事
    const quiet =
      f.applyCnt === 0 && f.daysSinceProcessed === null && f.daysSinceReply === null;
    if (f.hasInteraction && !quiet) {
      // null 是「時間窗內沒有」,不是「從來沒有」—— 措辭必須守住這個差別
      if (f.daysSinceReply === null) out.push('90 天內無回覆紀錄');
      else if (f.daysSinceReply > 30) out.push(`上次回覆 ${f.daysSinceReply} 天前`);

      if (f.daysSinceProcessed === null) out.push('30 天內無處理紀錄');
      else if (f.daysSinceProcessed > 7) out.push(`${f.daysSinceProcessed} 天沒處理履歷`);
      else out.push(`${GJD.util.daysAgoText(f.daysSinceProcessed)}處理過履歷`);
    }
    if (typeof f.postedDays === 'number' && f.postedDays > 30) {
      out.push(`刊登 ${f.postedDays} 天`);
    }
    if (typeof f.applyCnt === 'number') out.push(`${f.applyCnt} 人應徵`);
    return out.slice(0, 3);
  }

  function buildDetail(f, result) {
    const rows = [];
    const push = (label, value) => rows.push({ label, value });

    push('HR 活躍度', typeof f.hrBehaviorPR === 'number' ? `PR ${Math.round(f.hrBehaviorPR * 100)}(104 內部指標)` : '無資料');
    push(
      '上次處理履歷',
      !f.hasInteraction
        ? '無資料'
        : f.daysSinceProcessed !== null
          ? GJD.util.daysAgoText(f.daysSinceProcessed)
          : '近 30 天內無紀錄'
    );
    push(
      '上次回覆(104 站內)',
      !f.hasInteraction
        ? '無資料'
        : f.daysSinceReply !== null
          ? GJD.util.daysAgoText(f.daysSinceReply)
          : '近 90 天內無紀錄'
    );
    push('刊登(更新)日期', f.appearDateText ? `${f.appearDateText}(${f.postedDays} 天前)` : '無資料');
    // 抓不到就明講。整列消失會讓使用者以為是 0 人應徵,或以為外掛壞了。
    push('應徵人數', typeof f.applyCnt === 'number' ? `${f.applyCnt} 人` : '無法取得');
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
      '資料來自 104 網頁自己使用的內部 API,僅供參考。處理履歷為 30 天、回覆為 90 天的滾動紀錄,' +
      '「無紀錄」是指這段期間內沒有,不是從來沒有;HR 若以電話或 email 聯絡,104 也不會記錄。' +
      '另外「處理履歷」不一定是真人動作,系統自動配對可能也算在內。' +
      '分數高不代表這是假職缺,請搭配上面的原始數據自行判斷。';
    el.append(note);
    return el;
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
