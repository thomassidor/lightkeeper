function transitionCard(host, selected, onChoose) {
    /**
     * The "Transition" heading and card, drawn into an element.
     *
     * GENERATED. Spliced into every carrier by `npm run sync:views` from
     * views/shared/transition-card.js. **Edit that file, not this one.**
     *
     * Nodes only, never markup: no view assigns innerHTML. It closes over the
     * `node` and `transitionShape` every carrier already has, and calls
     * `onChoose(kind)` when a row is tapped — the carrier owns what that
     * changes and how it reaches the driver. The locale keys are written out
     * literally so locales.test.ts sees them used.
     */
    var KINDS = [
      { kind: 'gradual', what: 'transition.gradual', why: 'transition.gradualWhy' },
      { kind: 'balanced', what: 'transition.balanced', why: 'transition.balancedWhy' },
      { kind: 'quick', what: 'transition.quick', why: 'transition.quickWhy' },
    ];
    var SVG = 'http://www.w3.org/2000/svg';

    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(node('div', 'section-title', lk.t('transition.title')));
    var card = node('div', 'tr-card');
    card.setAttribute('role', 'radiogroup');

    KINDS.forEach(function (option) {
      var row = node('div', 'tr-row');
      var pick = node('button', 'tr-pick');
      pick.type = 'button';
      pick.setAttribute('role', 'radio');
      pick.setAttribute('data-transition', option.kind);
      pick.setAttribute('aria-checked', option.kind === selected ? 'true' : 'false');
      pick.appendChild(node('span', 'tr-box', '✓'));
      var text = node('span', 'tr-text');
      text.appendChild(node('div', 'tr-what', lk.t(option.what)));
      text.appendChild(node('div', 'tr-why', lk.t(option.why)));
      pick.appendChild(text);

      // 64 x 40, the curve inset 8px from the sides and 9px from the top and
      // bottom so a round cap never touches the edge of its tile.
      var svg = document.createElementNS(SVG, 'svg');
      svg.setAttribute('class', 'tr-thumb');
      svg.setAttribute('viewBox', '0 0 64 40');
      svg.setAttribute('aria-hidden', 'true');
      var coords = [];
      for (var i = 0; i <= 24; i++) {
        var t = i / 24;
        coords.push((8 + t * 48).toFixed(1) + ',' + (9 + transitionShape(option.kind, t) * 22).toFixed(1));
      }
      var line = document.createElementNS(SVG, 'polyline');
      line.setAttribute('class', 'tr-line');
      line.setAttribute('points', coords.join(' '));
      svg.appendChild(line);
      pick.appendChild(svg);

      pick.addEventListener('click', function () { onChoose(option.kind); });
      row.appendChild(pick);
      card.appendChild(row);
    });
    host.appendChild(card);
  }
