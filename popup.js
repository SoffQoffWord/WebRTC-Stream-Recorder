let currentTabId = null;
const timers = {};

async function getTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendMsg(msg) {
  return browser.tabs.sendMessage(currentTabId, msg);
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return [h, m % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':');
}

function startTimer(id, startTimestamp) {
  if (timers[id]) {
    clearInterval(timers[id]);
    delete timers[id];
  }

  const start = (startTimestamp && startTimestamp > 0) ? startTimestamp : Date.now();

  const el = document.getElementById('timer-' + id);
  if (el) el.textContent = formatTime(Date.now() - start);

  timers[id] = setInterval(() => {
    const el = document.getElementById('timer-' + id);
    if (el) el.textContent = formatTime(Date.now() - start);
  }, 1000);
}

function stopTimer(id) {
  if (timers[id]) {
    clearInterval(timers[id]);
    delete timers[id];
  }
}

// -- Preview ----------------------------------------------------
let previewRunning = false;
let previewIds = [];
let previewAnimFrame = null;
const PREVIEW_MIN_DELAY = 33;
const previewLastSent = {};

function startPreviews(ids) {
  stopPreviews();
  previewIds = ids.slice();
  previewRunning = true;

  async function loop() {
    if (!previewRunning) return;

    const now = performance.now();
    const promises = [];

    for (const id of previewIds) {
      const last = previewLastSent[id] || 0;
      if (now - last < PREVIEW_MIN_DELAY) continue;
      previewLastSent[id] = now;

      promises.push(
        sendMsg({ action: 'preview', id })
          .then(res => {
            if (res && res.frame) {
              const img = document.getElementById('preview-' + id);
              if (img) requestAnimationFrame(() => { img.src = res.frame; });
            }
          })
          .catch(() => {})
      );
    }

    Promise.all(promises).catch(() => {});
    previewAnimFrame = requestAnimationFrame(loop);
  }

  previewAnimFrame = requestAnimationFrame(loop);
}

function stopPreviews() {
  previewRunning = false;
  if (previewAnimFrame) {
    cancelAnimationFrame(previewAnimFrame);
    previewAnimFrame = null;
  }
}

// -- Build card -------------------------------------------------
function buildCard(stream) {
  const hasVideo = stream.tracks.includes('video');

  // -- Main card --
  const card = document.createElement('div');
  card.className = 'stream-card selected';
  card.id = 'card-' + stream.id;
  card.dataset.selected = 'true';

  // -- Header --
  const cardHeader = document.createElement('div');
  cardHeader.className = 'card-header';

  const selectIndicator = document.createElement('div');
  selectIndicator.className = 'select-indicator';
  selectIndicator.id = 'sel-' + stream.id;

  const cardTitle = document.createElement('span');
  cardTitle.className = 'card-title';
  cardTitle.textContent = stream.label;

  const statusDot = document.createElement('div');
  statusDot.className = 'status-dot';
  statusDot.id = 'dot-' + stream.id;

  cardHeader.appendChild(selectIndicator);
  cardHeader.appendChild(cardTitle);
  cardHeader.appendChild(statusDot);

  // -- Body --
  const cardBody = document.createElement('div');
  cardBody.className = 'card-body';

  // Preview
  const previewWrap = document.createElement('div');
  previewWrap.className = 'preview-wrap';

  if (hasVideo) {
    const img = document.createElement('img');
    img.id = 'preview-' + stream.id;
    img.alt = 'preview';
    img.src = '';
    previewWrap.appendChild(img);
  } else {
    const noVideo = document.createElement('div');
    noVideo.className = 'no-video';
    noVideo.textContent = 'Audio only';
    previewWrap.appendChild(noVideo);
  }

  // Info
  const cardInfo = document.createElement('div');
  cardInfo.className = 'card-info';

  const tracksDiv = document.createElement('div');
  tracksDiv.className = 'tracks';
  stream.tracks.forEach(t => {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = t;
    tracksDiv.appendChild(badge);
  });

  const timer = document.createElement('div');
  timer.className = 'timer';
  timer.id = 'timer-' + stream.id;
  timer.textContent = '00:00:00';

  const statusText = document.createElement('div');
  statusText.className = 'status-text';
  statusText.id = 'status-text-' + stream.id;
  statusText.textContent = 'Idle';

  cardInfo.appendChild(tracksDiv);
  cardInfo.appendChild(timer);
  cardInfo.appendChild(statusText);

  // Actions
  const cardActions = document.createElement('div');
  cardActions.className = 'card-actions';

  const btnRec = document.createElement('button');
  btnRec.className = 'btn btn-green btn-sm';
  btnRec.id = 'btn-rec-' + stream.id;
  btnRec.textContent = 'Rec';

  const btnStop = document.createElement('button');
  btnStop.className = 'btn btn-red btn-sm';
  btnStop.id = 'btn-stop-' + stream.id;
  btnStop.textContent = 'Stop';
  btnStop.disabled = true;

  cardActions.appendChild(btnRec);
  cardActions.appendChild(btnStop);

  // Assembler body
  cardBody.appendChild(previewWrap);
  cardBody.appendChild(cardInfo);
  cardBody.appendChild(cardActions);

  // Assembler card
  card.appendChild(cardHeader);
  card.appendChild(cardBody);

  // -- Events --
  card.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (card.classList.contains('recording')) return;

    const isSelected = card.dataset.selected === 'true';
    card.dataset.selected = isSelected ? 'false' : 'true';

    if (card.dataset.selected === 'true') {
      card.classList.remove('unselected');
      card.classList.add('selected');
    } else {
      card.classList.remove('selected');
      card.classList.add('unselected');
    }

    updateToolbarButtons();
  });

  btnRec.addEventListener('click', async (e) => {
    e.stopPropagation();
    await startRecording(stream.id);
  });

  btnStop.addEventListener('click', async (e) => {
    e.stopPropagation();
    await stopRecording(stream.id);
  });

  return card;
}

// -- Card state -------------------------------------------------
function setCardState(id, status, startTime) {
  const card    = document.getElementById('card-' + id);
  const dot     = document.getElementById('dot-' + id);
  const btnRec  = document.getElementById('btn-rec-' + id);
  const btnStp  = document.getElementById('btn-stop-' + id);
  const timer   = document.getElementById('timer-' + id);

  if (!card || !dot || !btnRec || !btnStp) {
    console.warn('setCardState: missing elements id=' + id);
    return;
  }

  console.log('setCardState id=' + id + ' status=' + status + ' startTime=' + startTime);

  card.classList.remove('recording');
  dot.className = 'status-dot';

  if (status === 'recording') {
    card.classList.add('recording');
    card.classList.remove('selected', 'unselected');
    card.dataset.selected = 'true';
    dot.classList.add('recording');
    btnRec.disabled = true;
    btnStp.disabled = false;
    if (timer) timer.classList.add('visible');
    startTimer(id, startTime);

  } else {
    btnRec.disabled = false;
    btnStp.disabled = true;
    if (timer) timer.classList.remove('visible');
    stopTimer(id);

    if (status === 'stopped') {
      dot.classList.add('stopped');
      card.classList.remove('selected', 'unselected');
      card.classList.add('selected');
      card.dataset.selected = 'true';
    }
  }

  const statusText = document.getElementById('status-text-' + id);
  if (statusText) {
    if (status === 'recording')    statusText.textContent = 'Recording...';
    else if (status === 'stopped') statusText.textContent = 'Stopped - file saved';
    else                           statusText.textContent = 'Idle';
  }

  updateToolbarButtons();
}

// -- Toolbar ----------------------------------------------------
function updateToolbarButtons() {
  const cards = document.querySelectorAll('.stream-card');
  const hasSelected  = Array.from(cards).some(c => c.dataset.selected === 'true');
  const hasRecording = document.querySelectorAll('.status-dot.recording').length > 0;

  document.getElementById('btn-rec-all').disabled  = !hasSelected;
  document.getElementById('btn-stop-all').disabled = !hasRecording;
}

// -- Actions ----------------------------------------------------
async function startRecording(id) {
  try {
    const res = await sendMsg({ action: 'startRecording', id });
    console.log('startRecording response:', JSON.stringify(res));
    if (res && res.ok) {
      setCardState(id, 'recording', Date.now());
    } else {
      console.warn('startRecording error:', res && res.reason);
      if (res && res.reason && res.reason.indexOf('already') !== -1) {
        setCardState(id, 'recording', null);
      }
    }
  } catch (e) {
    console.error('startRecording exception:', e);
  }
}

async function stopRecording(id) {
  try {
    console.log('Sending stopRecording id=' + id);
    const res = await sendMsg({ action: 'stopRecording', id });
    console.log('stopRecording response:', JSON.stringify(res));
    if (res && res.ok) {
      setCardState(id, 'stopped');
    } else {
      console.warn('stopRecording error:', res && res.reason);
    }
  } catch (e) {
    console.error('stopRecording exception:', e);
  }
}

// -- Resync UI on popup reopen ----------------------------------
async function resyncUI() {
  let res;
  try {
    res = await sendMsg({ action: 'getStatus' });
  } catch (_) {
    return false;
  }

  console.log('resyncUI response:', JSON.stringify(res));

  if (!res || !res.streams || res.streams.length === 0) return false;

  document.getElementById('empty').style.display = 'none';
  const list = document.getElementById('stream-list');
  list.innerHTML = '';
  const ids = [];

  res.streams.forEach(s => {
    console.log('resync id=' + s.id + ' status=' + s.status + ' startTime=' + s.startTime);
    list.appendChild(buildCard(s));
    setTimeout(() => setCardState(s.id, s.status, s.startTime), 50);
    ids.push(s.id);
  });

  setTimeout(() => startPreviews(ids), 100);
  setTimeout(() => updateToolbarButtons(), 100);
  return true;
}

// -- Init -------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  const tab = await getTab();
  currentTabId = tab.id;

  const urlEl = document.getElementById('tab-url');
  try { urlEl.textContent = new URL(tab.url).hostname; } catch (_) {}

  let isInjected = false;
  try {
    await sendMsg({ action: 'ping' });
    isInjected = true;
    console.log('Content script already present');
  } catch (_) {
    isInjected = false;
    console.log('Content script absent, injecting...');
  }

  if (!isInjected) {
    try {
      await browser.tabs.executeScript(tab.id, { file: 'content.js' });
      console.log('Content script injected');
    } catch (e) {
      console.error('Injection error:', e);
    }
  }

  await resyncUI();

  // Scan
  document.getElementById('btn-scan').addEventListener('click', async () => {
    stopPreviews();
    document.getElementById('stream-list').innerHTML = '';
    document.getElementById('empty').style.display = 'block';

    let res;
    try {
      res = await sendMsg({ action: 'scan' });
    } catch (e) {
      document.getElementById('empty').querySelector('p').textContent =
        'Cannot contact the page. Reload and try again.';
      return;
    }

    const streams = (res && res.streams) ? res.streams : [];

    if (streams.length === 0) {
      document.getElementById('empty').querySelector('p').innerHTML =
        'No WebRTC stream detected.<br>Make sure the live is active.';
      return;
    }

    document.getElementById('empty').style.display = 'none';
    const list = document.getElementById('stream-list');
    const ids = [];

    streams.forEach(s => {
      list.appendChild(buildCard(s));
      setTimeout(() => setCardState(s.id, s.status, s.startTime), 50);
      ids.push(s.id);
    });

    setTimeout(() => startPreviews(ids), 100);
    setTimeout(() => updateToolbarButtons(), 100);
  });

  // Record selection
  document.getElementById('btn-rec-all').addEventListener('click', async () => {
    const cards = document.querySelectorAll('.stream-card');
    for (const card of cards) {
      if (card.dataset.selected !== 'true') continue;
      const id = parseInt(card.id.replace('card-', ''));
      const dot = document.getElementById('dot-' + id);
      if (dot && !dot.classList.contains('recording')) {
        await startRecording(id);
      }
    }
  });

  // Stop all
  document.getElementById('btn-stop-all').addEventListener('click', async () => {
    try {
      await sendMsg({ action: 'stopAll' });
      document.querySelectorAll('.status-dot.recording').forEach(dot => {
        const id = parseInt(dot.id.replace('dot-', ''));
        setCardState(id, 'stopped');
      });
    } catch (e) {
      console.error('stopAll error:', e);
    }
  });
});

window.addEventListener('unload', stopPreviews);