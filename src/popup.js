const enabledEl = document.getElementById('enabled');
const healthEl = document.getElementById('health');
const trackedEl = document.getElementById('tracked');
const clearEl = document.getElementById('clear');

async function refresh() {
  const box = await chrome.storage.local.get(null);
  enabledEl.checked = box['gjd:enabled'] !== false;
  const tracked = Object.keys(box).filter((k) => k.startsWith('hist:')).length;
  trackedEl.textContent = tracked + ' 筆';
  renderHealth(box['gjd:health']);
}

// 104 的內部端點沒有公開文件,隨時可能改版。連續失敗代表的多半不是網路不穩,
// 而是資料來源變了 —— 與其讓徽章默默不出現,不如在這裡講清楚。
const FAIL_THRESHOLD = 5;

function renderHealth(h) {
  if (!h || (h.fails || 0) < FAIL_THRESHOLD) {
    healthEl.hidden = true;
    return;
  }
  healthEl.hidden = false;
  healthEl.textContent =
    `最近連續 ${h.fails} 次沒能取得資料。可能是 104 改版了,也可能只是網路不穩 —— ` +
    '重新整理 104 頁面後如果仍然如此,請到 GitHub 回報。';
  const a = document.createElement('a');
  a.href = 'https://github.com/fansia/104-ghost-job-detector/issues';
  a.target = '_blank';
  a.textContent = '回報問題';
  healthEl.append(' ', a);
}

enabledEl.addEventListener('change', async () => {
  await chrome.storage.local.set({ 'gjd:enabled': enabledEl.checked });
});

clearEl.addEventListener('click', async () => {
  const box = await chrome.storage.local.get(null);
  const keys = Object.keys(box).filter((k) => k !== 'gjd:enabled');
  await chrome.storage.local.remove(keys);
  refresh();
});

refresh();
