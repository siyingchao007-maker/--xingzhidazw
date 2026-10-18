"use strict";
// Refresh while a subscribed view is open. Model output deltas do not trigger scans.
function watchDailyReview(view, plugin, updated) {
  let closed = false, timer, busy = false;
  const refresh = async () => {
    if (closed || busy) return;
    busy = true;
    try { await plugin.ensureDailyReview(); } catch { /* The view displays runtime.dailyReview.error. */ }
    finally {
      busy = false;
      if (!closed) {
        updated();
        if (!plugin.getDailyReviewState().error) schedule();
      }
    }
  };
  const schedule = () => {
    if (closed || plugin.getDailyReviewState().freshness === "current") return;
    clearTimeout(timer); timer = setTimeout(refresh, 300);
  };
  const unsubscribe = plugin.subscribe(schedule);
  const win = view.contentEl.ownerDocument.defaultView;
  win.addEventListener("focus", schedule);
  const interval = setInterval(schedule, 60_000);
  void refresh();
  return () => { closed = true; clearTimeout(timer); clearInterval(interval); unsubscribe?.(); win.removeEventListener("focus", schedule); };
}
module.exports = { watchDailyReview };
