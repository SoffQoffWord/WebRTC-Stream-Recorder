browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'downloadBlob') {
    browser.downloads.download({
      url: msg.url,
      filename: msg.filename,
      saveAs: false
    }).then(id => {
      console.log('Download started id=' + id + ' file=' + msg.filename);
      sendResponse({ ok: true, id });
    }).catch(err => {
      console.error('Download error:', err.message);
      sendResponse({ ok: false, reason: err.message });
    });
    return true;
  }
});