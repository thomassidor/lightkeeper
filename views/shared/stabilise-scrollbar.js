function stabiliseScrollbar() {
    /**
     * Reserve room for the scrollbar so growing the view cannot re-wrap it.
     *
     * GENERATED. Spliced into every pair view by `npm run sync:views` from
     * views/shared/stabilise-scrollbar.js. **Edit that file, not this one.**
     *
     * When the content grows past the pane height a scrollbar appears, the
     * usable width drops by its thickness, and every line of text re-measures —
     * so a heading that sat on one line before a list was expanded sits on two
     * afterwards, and the whole screen shifts under the tap that expanded it.
     * `scrollbar-gutter: stable` keeps the gutter reserved whether or not the
     * bar is showing, which makes the width one number for the life of the
     * session instead of two.
     *
     * It runs in EVERY view, not only the ones that grow, because the scroller
     * belongs to the pairing container and outlives each screen: a flow whose
     * first screen reserved the gutter is stable throughout, and a flow whose
     * first screen did not is stable nowhere. That asymmetry is exactly how
     * this was found — the two device types with a credential screen stabilised
     * on step 1 and the three without it never did, so the sensor picker
     * re-wrapped its heading the moment the sensor list unfolded.
     *
     * The scrolling element belongs to the pairing container, not to us, so
     * find it by walking up rather than guessing a selector.
     */
    var scroller = null;
    for (var el = __root.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      var overflowY = getComputedStyle(el).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') { scroller = el; break; }
    }
    var targets = scroller ? [scroller] : [document.documentElement, document.body];
    var supported = window.CSS && CSS.supports && CSS.supports('scrollbar-gutter', 'stable');

    targets.forEach(function (el) {
      if (!el) return;
      if (supported) el.style.scrollbarGutter = 'stable';
      // Without gutter support, always showing the track is the stable option.
      else if (el !== document.body) el.style.overflowY = 'scroll';
    });
  }
