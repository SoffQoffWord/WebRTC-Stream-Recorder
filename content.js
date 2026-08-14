// Remove old listener if present
if (window._webrtcRecorderListener) {
  browser.runtime.onMessage.removeListener(window._webrtcRecorderListener);
}

// Initialize state once
if (!window._webrtcRecorderState) {
  window._webrtcRecorderState = { streams: [] };
}
if (!window._webrtcStreamIdCounter) {
  window._webrtcStreamIdCounter = 0;
}

const state = window._webrtcRecorderState;
let streamIdCounter = window._webrtcStreamIdCounter;

// -- Scan streams -----------------------------------------------
function scanStreams() {
  const videoEls = Array.from(document.querySelectorAll('video, audio'));
  const found = [];

  videoEls.forEach((el) => {
    const srcObj = el.srcObject;
    if (!srcObj || !(srcObj instanceof MediaStream)) return;
    if (!srcObj.active) return;

    const alreadyTracked = state.streams.find(s => s.stream.id === srcObj.id);
    if (alreadyTracked) {
      found.push(alreadyTracked);
      return;
    }

    const tracks = srcObj.getTracks().map(t => t.kind);
    streamIdCounter++;
    window._webrtcStreamIdCounter = streamIdCounter;

    const entry = {
      id: streamIdCounter,
      streamId: srcObj.id,
      videoEl: el,
      stream: srcObj,
      recorder: null,
      chunks: [],
      status: 'idle',
      startTime: null,
      label: el.title || tracks.join('+') || ('Stream #' + streamIdCounter),
      tracks,
      previewCanvas: null,
      previewCtx: null,
      frameCapturing: false,
      latestFrame: null,
      dataInterval: null,
    };

    state.streams.push(entry);
    found.push(entry);

    // Start frame capture immediately
    if (entry.tracks.includes('video')) {
      startFrameCapture(entry);
    }
  });

  return found.map(s => ({
    id: s.id,
    streamId: s.streamId,
    label: s.label,
    tracks: s.tracks,
    status: s.status,
    startTime: s.startTime || null,
  }));
}

// -- Frame capture (requestAnimationFrame) ----------------------
function startFrameCapture(entry) {
  if (entry.frameCapturing) return;
  entry.frameCapturing = true;

  const capture = () => {
    if (!entry.frameCapturing) return;

    const video = entry.videoEl;
    if (video.readyState >= 2 && video.videoWidth > 0) {
      if (!entry.previewCanvas) {
        entry.previewCanvas = document.createElement('canvas');
        entry.previewCtx = entry.previewCanvas.getContext('2d');
      }

      const sourceW = video.videoWidth;
      const sourceH = video.videoHeight;
      const maxW = 320;
      const maxH = 180;
      const ratio = Math.min(maxW / sourceW, maxH / sourceH, 1);
      const w = Math.round(sourceW * ratio);
      const h = Math.round(sourceH * ratio);

      const canvas = entry.previewCanvas;
      const ctx = entry.previewCtx;

      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;

      ctx.drawImage(video, 0, 0, w, h);
      entry.latestFrame = canvas.toDataURL('image/jpeg', 0.5);
    }

    requestAnimationFrame(capture);
  };

  requestAnimationFrame(capture);
  console.log('Frame capture started for stream #' + entry.id);
}

function stopFrameCapture(entry) {
  entry.frameCapturing = false;
  entry.latestFrame = null;
}

// -- Preview ----------------------------------------------------
function capturePreview(id) {
  const entry = state.streams.find(s => s.id === id);
  if (!entry) return null;
  if (entry.videoEl.tagName === 'AUDIO') return null;

  if (!entry.frameCapturing) {
    startFrameCapture(entry);
  }

  return entry.latestFrame || null;
}

// -- Choose mime type based on available tracks -----------------
function chooseMimeType(stream) {
  const hasVideo = stream.getVideoTracks().length > 0;
  const hasAudio = stream.getAudioTracks().length > 0;

  console.log('Tracks - video=' + stream.getVideoTracks().length + ' audio=' + stream.getAudioTracks().length);

  const candidates = [];

  if (hasVideo && hasAudio) {
    candidates.push('video/webm;codecs=vp8,opus');
    candidates.push('video/webm;codecs=vp8');
    candidates.push('video/webm');
  } else if (hasVideo) {
    candidates.push('video/webm;codecs=vp8');
    candidates.push('video/webm');
  } else if (hasAudio) {
    candidates.push('audio/webm;codecs=opus');
    candidates.push('audio/webm');
  }

  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      console.log('Selected mimeType: ' + mime);
      return mime;
    }
  }

  console.warn('No supported mimeType found, using empty string');
  return '';
}

// -- Save chunks ------------------------------------------------
function saveChunks(chunks, filename) {
  if (!chunks || chunks.length === 0) {
    console.error('SAVE: No chunks available');
    return;
  }

  const blob = new Blob(chunks, { type: 'video/webm' });
  console.log('SAVE: Blob ' + (blob.size / 1024 / 1024).toFixed(2) + ' MB -> ' + filename);

  if (blob.size === 0) {
    console.error('SAVE: Empty blob, aborting');
    return;
  }

  // Method 1: direct a.click()
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    console.log('SAVE: Method 1 (a.click) OK');
    setTimeout(() => {
      if (document.body.contains(a)) document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 10000);
    return;
  } catch (e) {
    console.warn('SAVE: Method 1 failed:', e.message);
  }

  // Method 2: base64 via background
  const reader = new FileReader();
  reader.onloadend = () => {
    console.log('SAVE: Method 2 base64, length=' + reader.result.length);
    browser.runtime.sendMessage({
      action: 'downloadBlob',
      url: reader.result,
      filename: filename
    }).then(res => {
      console.log('SAVE: Method 2 background response=' + JSON.stringify(res));
    }).catch(err => {
      console.error('SAVE: Method 2 error=' + err.message);

      // Method 3: open in new tab
      try {
        const url2 = URL.createObjectURL(blob);
        window.open(url2, '_blank');
        console.log('SAVE: Method 3 window.open attempted');
        setTimeout(() => URL.revokeObjectURL(url2), 30000);
      } catch (e2) {
        console.error('SAVE: Method 3 failed:', e2.message);
      }
    });
  };
  reader.onerror = (e) => console.error('SAVE: FileReader error:', e);
  reader.readAsDataURL(blob);
}

// -- Start recording --------------------------------------------
function startRecording(id) {
  const entry = state.streams.find(s => s.id === id);

  if (!entry) {
    return { ok: false, reason: 'Stream not found id=' + id };
  }

  if (entry.recorder && entry.recorder.state === 'recording') {
    return { ok: false, reason: 'Recorder already active' };
  }

  entry.chunks    = [];
  entry.status    = 'recording';
  entry.startTime = Date.now();
  entry.recorder  = null;

  const mimeType = chooseMimeType(entry.stream);

  try {
    const options = { videoBitsPerSecond: 8000000 };
    if (mimeType) options.mimeType = mimeType;
    if (entry.stream.getAudioTracks().length > 0) options.audioBitsPerSecond = 192000;

    console.log('MediaRecorder options:', JSON.stringify(options));
    entry.recorder = new MediaRecorder(entry.stream, options);
  } catch (e) {
    entry.status    = 'idle';
    entry.startTime = null;
    return { ok: false, reason: 'MediaRecorder: ' + e.message };
  }

  entry.recorder.ondataavailable = (e) => {
    console.log('ondataavailable size=' + (e.data ? e.data.size : 'null'));
    if (e.data && e.data.size > 0) {
      entry.chunks.push(e.data);
      console.log('Chunk #' + entry.chunks.length + ': ' + (e.data.size / 1024).toFixed(1) + ' KB');
    } else {
      console.warn('Empty chunk ignored');
    }
  };

  entry.recorder.onstop = () => {
    console.log('ONSTOP triggered! chunks=' + entry.chunks.length);
    entry.status    = 'stopped';
    entry.startTime = null;
    stopFrameCapture(entry);
    const filename = 'stream_' + entry.id + '_' + Date.now() + '.webm';
    saveChunks(entry.chunks.slice(), filename);
    entry.chunks   = [];
    entry.recorder = null;
  };

  entry.recorder.onerror = (e) => {
    console.error('MediaRecorder error:', e.error ? e.error.message : e);
    entry.status    = 'stopped';
    entry.startTime = null;
    entry.recorder  = null;
  };

  entry.recorder.onstart = () => {
    console.log('MediaRecorder started, state=' + entry.recorder.state);
  };

  // Auto-stop if tracks end
  entry.stream.getTracks().forEach(track => {
    track.onended = () => {
      console.warn('Track ended (' + track.kind + '), auto-saving...');
      if (entry.recorder && entry.recorder.state === 'recording') {
        entry.recorder.stop();
      }
    };
    track.onmute   = () => console.warn('Track muted (' + track.kind + ')');
    track.onunmute = () => console.log('Track unmuted (' + track.kind + ')');
  });

  // Manual requestData every second
  entry.dataInterval = setInterval(() => {
    if (entry.recorder && entry.recorder.state === 'recording') {
      entry.recorder.requestData();
    }
  }, 1000);

  entry.recorder.start();
  console.log('startRecording OK id=' + id + ' startTime=' + entry.startTime);
  return { ok: true, startTime: entry.startTime };
}

// -- Stop recording ---------------------------------------------
function stopRecording(id) {
  const entry = state.streams.find(s => s.id === id);

  if (!entry) return { ok: false, reason: 'Stream not found' };
  if (!entry.recorder) return { ok: false, reason: 'No recorder' };
  if (entry.recorder.state !== 'recording') {
    return { ok: false, reason: 'Recorder state=' + entry.recorder.state };
  }

  console.log('stopRecording id=' + id + ' state=' + entry.recorder.state);

  if (entry.dataInterval) {
    clearInterval(entry.dataInterval);
    entry.dataInterval = null;
  }

  try {
    entry.recorder.stop();
    return { ok: true };
  } catch (e) {
    console.error('Stop error:', e);
    return { ok: false, reason: e.message };
  }
}

function stopAll() {
  state.streams
    .filter(s => s.recorder && s.recorder.state === 'recording')
    .forEach(s => stopRecording(s.id));
}

function getRealStatus(entry) {
  if (entry.recorder && entry.recorder.state === 'recording') return 'recording';
  if (entry.recorder && entry.recorder.state === 'paused')    return 'recording';
  return entry.status;
}

function getAllStatus() {
  return state.streams.map(s => ({
    id: s.id,
    streamId: s.streamId,
    label: s.label,
    tracks: s.tracks,
    status: getRealStatus(s),
    startTime: s.startTime || null,
  }));
}

// -- Message listener -------------------------------------------
window._webrtcRecorderListener = (msg, sender, sendResponse) => {
  console.log('content.js received:', msg.action, msg.id !== undefined ? 'id=' + msg.id : '');

  if (msg.action === 'ping') {
    sendResponse({ ok: true });

  } else if (msg.action === 'scan') {
    sendResponse({ streams: scanStreams() });

  } else if (msg.action === 'preview') {
    sendResponse({ frame: capturePreview(msg.id) });

  } else if (msg.action === 'startRecording') {
    sendResponse(startRecording(msg.id));

  } else if (msg.action === 'stopRecording') {
    sendResponse(stopRecording(msg.id));

  } else if (msg.action === 'stopAll') {
    stopAll();
    sendResponse({ ok: true });

  } else if (msg.action === 'getStatus') {
    sendResponse({ streams: getAllStatus() });
  }

  return true;
};

browser.runtime.onMessage.addListener(window._webrtcRecorderListener);
console.log('WebRTC Recorder content script loaded v' + Date.now());