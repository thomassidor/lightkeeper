function weekGrid(host, payload) {
    /**
     * A sensor's own last week, drawn into an element.
     *
     * GENERATED. Spliced into every carrier by `npm run sync:views` from
     * views/shared/week-grid.js. **Edit that file, not this one.**
     *
     * It takes no arguments beyond the element and the payload, and it closes
     * over the `node` every carrier already has — the same trick the daylight
     * card used. One carrier today, the response screen: the detail screen a
     * sensor row used to push is gone, and with it the two refusals it drew —
     * see the verdict at the foot of this function.
     *
     * The grid IS the argument for the two lux thresholds. Nobody can judge
     * "under 8 lx" in the abstract; anybody can judge it against a week that
     * visibly has a night and a day in it. It is also what makes the two
     * refusals honest — a cupboard sensor that reports faithfully and says
     * nothing, and a sensor that stopped on Saturday — because the picture shows
     * both in a glance and no wording has to be trusted.
     */
    var DAY_KEYS = ['week.mon', 'week.tue', 'week.wed', 'week.thu',
      'week.fri', 'week.sat', 'week.sun'];

    while (host.firstChild) host.removeChild(host.firstChild);
    if (!payload || !payload.week) {
      // No readable history is not an error — the screen falls back to the
      // defaults, which is exactly what every screen did before this existed.
      host.appendChild(node('div', 'week-verdict', Homey.__('week.noHistory')));
      return;
    }

    var week = payload.week;

    var head = node('div', 'week-head');
    // The name only where the surrounding screen has not already said it: the
    // detail screen is titled with the sensor, and repeating it directly under
    // its own heading reads as two different sensors.
    if (payload.sensorName) head.appendChild(node('div', 'name', payload.sensorName));
    head.appendChild(node('span', 'span', Homey.__('week.lastSevenDays')));
    host.appendChild(head);

    /**
     * A cell's colour, on a log scale between the week's own 5th and 95th
     * percentiles.
     *
     * Logarithmic because illuminance is perceived that way and the range is
     * enormous — the same reason `levelFromLux` interpolates on log10 — and on
     * the week's OWN range rather than a fixed one, because a room that never
     * passes 40 lx would otherwise be a uniform dark grid with nothing to read.
     */
    var low = Math.max(0.1, week.low || 0.1);
    var high = Math.max(low * 2, week.high || 1);
    function shade(lux) {
      if (lux === null || lux === undefined) return null;
      var f = (Math.log10(Math.max(0.1, lux)) - Math.log10(low))
        / (Math.log10(high) - Math.log10(low));
      return Math.max(0, Math.min(1, f));
    }

    /**
     * Six steps of the app's own violet, dark to light, rather than a
     * continuous ramp.
     *
     * Stepped because the grid is read as a PATTERN — where the nights are,
     * where the days are — and six distinguishable shades make that pattern
     * legible where 84 nearly-identical ones do not. Light is bright and dark
     * is dark, which is the way round somebody expects a picture of light.
     */
    var SHADES = ['#6b48bc', '#9f81dc', '#c4b0ec', '#e0d6f6', '#f4f2fa'];
    function cellColour(value) {
      return SHADES[Math.min(SHADES.length - 1, Math.floor((1 - value) * SHADES.length))];
    }

    function round(lux) {
      return lux >= 10 ? Math.round(lux) : Math.round(lux * 10) / 10;
    }

    var anyGap = false;
    for (var row = 0; row < week.cells.length; row++) {
      var line = node('div', 'week-row');
      line.appendChild(node('span', 'week-day', Homey.__(DAY_KEYS[(week.days[row] || 1) - 1])));
      for (var column = 0; column < week.cells[row].length; column++) {
        var value = shade(week.cells[row][column]);
        var cell = node('i', value === null ? 'gap' : null);
        if (value === null) anyGap = true;
        else cell.style.background = cellColour(value);
        line.appendChild(cell);
      }
      host.appendChild(line);
    }

    var hours = node('div', 'week-hours');
    var LABELS = ['00', '06', '12', '18', '24'];
    for (var h = 0; h < LABELS.length; h++) hours.appendChild(node('span', null, LABELS[h]));
    host.appendChild(hours);

    var scale = node('div', 'week-scale');
    scale.appendChild(node('span', null, Homey.__('week.lux', { lux: round(low) })));
    var bar = node('span', 'bar');
    // No "now" tick on a sensor that has stopped: its last reading is hours
    // old, and a tick labelled "now" would be the one false thing on a card
    // whose whole job is to show that nothing has arrived since.
    var quiet = payload.staleFor !== null && payload.staleFor !== undefined;
    if (!quiet && payload.nowLux !== null && payload.nowLux !== undefined) {
      var at = shade(payload.nowLux);
      var tick = node('span', 'tick');
      tick.style.left = (at * 100) + '%';
      bar.appendChild(tick);
      var label = node('span', 'tickLabel', Homey.__('week.nowLux', { lux: round(payload.nowLux) }));
      label.style.left = (at * 100) + '%';
      bar.appendChild(label);
    }
    scale.appendChild(bar);
    scale.appendChild(node('span', null, Homey.__('week.lux', { lux: round(high) })));
    host.appendChild(scale);

    /**
     * What the hatch means, and only when there is one.
     *
     * A hatched cell is the difference between "pitch dark" and "nothing
     * arrived", and that difference is the whole argument of the stopped-sensor
     * screen — but it is a distinction nobody can be expected to read out of a
     * pattern. So it gets a line, on the weeks that have a gap in them, and no
     * line at all on the ones that do not.
     */
    /**
     * The scale, as five chips between two words.
     *
     * Drawn from the same array the cells are, reversed, so the key cannot
     * disagree with the grid above it — which is the one thing a legend must
     * never do.
     */
    var key = node('div', 'week-key');
    key.appendChild(node('span', null, Homey.__('week.less')));
    for (var k = SHADES.length - 1; k >= 0; k--) {
      var chip = node('i');
      chip.style.background = SHADES[k];
      key.appendChild(chip);
    }
    key.appendChild(node('span', null, Homey.__('week.more')));
    host.appendChild(key);

    if (anyGap) {
      var legend = node('div', 'week-legend');
      legend.appendChild(node('i'));
      legend.appendChild(node('span', null, Homey.__('week.nothingReported')));
      host.appendChild(legend);
    }

    /**
     * What this week is worth, in a sentence with the numbers in it — or, for
     * the two weeks that argue against using the sensor at all, a block.
     *
     * Those two used to be screens of their own ("A sensor not worth using",
     * "Sensor has gone quiet"), each with a list of three ways out. The
     * 2026-09-23 design folds both into this card, where the ways out are the
     * screen's own chrome: Previous picks another sensor or the sun, Next uses
     * it anyway. So the finding has to be impossible to miss IN the card, which
     * is what a tinted block is for in this system — a finding somebody has to
     * act on. Quiet is the error ground, flat the warning one: a stopped sensor
     * will hold the lights at one brightness, a flat one merely has nothing to
     * say.
     *
     * Quiet is decided by the SCREEN's `staleFor`, not by the week's verdict:
     * the live reading can be newer than the Insights history, and the driver
     * has already taken the newer of the two.
     */
    var verdict = week.verdict || { kind: 'nothing' };

    if (quiet) {
      host.appendChild(finding('msg bad',
        Homey.__('week.quiet', { name: payload.sensorName || '', hours: payload.staleFor }),
        Homey.__('week.quietMeans', { when: payload.lastReport || '' })));
      return;
    }
    if (verdict.kind === 'flat') {
      host.appendChild(finding('msg warn',
        Homey.__('week.flat'),
        Homey.__('week.flatDetail', { low: round(verdict.low), high: round(verdict.high) })));
      return;
    }

    var sentence = node('div', 'week-verdict');
    if (verdict.kind === 'usable') {
      sentence.appendChild(node('b', null, Homey.__('week.usable')));
      sentence.appendChild(document.createTextNode(' ' + Homey.__('week.usableDetail', {
        night: round(verdict.nightLux), noon: round(verdict.noonLux)
      })));
    } else if (verdict.kind === 'stopped') {
      sentence.appendChild(node('b', null, Homey.__('week.stopped')));
      sentence.appendChild(document.createTextNode(' ' + Homey.__('week.stoppedDetail', {
        when: new Date(verdict.lastAt).toLocaleString()
      })));
    } else {
      sentence.appendChild(node('b', null, Homey.__('week.nothing')));
    }
    host.appendChild(sentence);

    function finding(className, lead, body) {
      // What happened, then what it means — one block, the shape every other
      // message on these screens takes.
      var block = node('div', className + ' week-finding');
      block.appendChild(node('div', 'lead', lead));
      block.appendChild(node('div', null, body));
      return block;
    }
  }
