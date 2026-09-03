const enabledEl = document.getElementById('enabled');
const trackedEl = document.getElementById('tracked');
const clearEl = document.getElementById('clear');

async function refresh() {
  const box = await chrome.storage.local.get(null);
  enabledEl.checked = box['gjd:enabled'] !== false;
  const tracked = Object.keys(box).filter((k) => k.startsWith('hist:')).length;
  trackedEl.textContent = tracked + ' 筆';
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
