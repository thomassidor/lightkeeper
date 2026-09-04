function daylightCard() {
    /**
     * Every key this card can render, written out as a LITERAL.
     *
     * Not assembled from a prefix. `Homey.__` is given whatever string it is
     * given, so `'daylight.' + key` works at runtime and is invisible to
     * test/unit/locales.test.ts — which finds keys by scanning the source for
     * quoted `group.key` literals, in BOTH directions. A key referenced only by
     * assembly reads as defined-but-never-rendered; one removed from en.json
     * reads as nothing at all, and the screen would ship showing a raw key.
     */
    var KEYS = {
      nowSky: 'daylight.nowSky',
      nowSkyValue: 'daylight.nowSkyValue',
      nowSkyUnknown: 'daylight.nowSkyUnknown',
      nowSensors: 'daylight.nowSensors',
      nowNoSensors: 'daylight.nowNoSensors',
      nowResult: 'daylight.nowResult',
      nowResultValue: 'daylight.nowResultValue',
      nowUnknown: 'daylight.nowUnknown',
      sourceSensors: 'daylight.sourceSensors',
      sourceSky: 'daylight.sourceSky',
      sensorsNone: 'daylight.sensorsNone',
      sensorsNoneHelp: 'daylight.sensorsNoneHelp',
      sensorLux: 'daylight.sensorLux',
      sensorReading: 'daylight.sensorReading',
      sensorNoReading: 'daylight.sensorNoReading',
      sensorUnavailable: 'daylight.sensorUnavailable',
      ageNow: 'daylight.ageNow',
      ageMinutes: 'daylight.ageMinutes',
      ageHours: 'daylight.ageHours',
      ageDays: 'daylight.ageDays',
      sunNone: 'daylight.sunNone',
      sunMorning: 'daylight.sunMorning',
      sunMidday: 'daylight.sunMidday',
      sunAfternoon: 'daylight.sunAfternoon',
      percent: 'daylight.percent',
      preview: 'daylight.preview',
      previewing: 'daylight.previewing',
      previewed: 'daylight.previewed'
    };

    function t(key, tokens) {
      return Homey.__(KEYS[key], tokens || {});
    }

    var el = {
      card: document.getElementById('dl-card'),
      now: document.getElementById('dl-now'),
      sun: document.getElementById('dl-sun'),
      peaks: document.getElementById('dl-peaks'),
      sensors: document.getElementById('dl-sensors'),
      darkLux: document.getElementById('dl-dark-lux'),
      brightLux: document.getElementById('dl-bright-lux'),
      dark: document.getElementById('dl-dark'),
      bright: document.getElementById('dl-bright'),
      darkValue: document.getElementById('dl-dark-value'),
      brightValue: document.getElementById('dl-bright-value'),
      previewCard: document.getElementById('dl-preview-card'),
      preview: document.getElementById('dl-preview'),
      previewResult: document.getElementById('dl-preview-result')
    };

    var model = {
      standalone: false,
      response: { sensors: [], darkLux: 5, brightLux: 500, dark: 0.9, bright: 0.25 },
      limits: { minLux: 0.1, maxLux: 100000 },
      now: null,
      sky: null,
      readings: [],
      rooms: [],
      loaded: false
    };

    function percentOf(value) {
      return Math.round(Number(value) * 100);
    }

    /**
     * How long ago a reading arrived, in words.
     *
     * A reading is never treated as stale — many Zigbee sensors report only on
     * change, so a quiet sensor in a stable room is telling the truth — which
     * leaves its AGE as the only thing on screen that can reveal one that has
     * simply stopped.
     */
    function ageText(at) {
      if (at === null || at === undefined) return '';
      var minutes = Math.floor((Date.now() - Number(at)) / 60000);
      if (!isFinite(minutes) || minutes < 1) return t('ageNow');
      if (minutes < 60) return t('ageMinutes', { minutes: String(minutes) });
      if (minutes < 60 * 48) return t('ageHours', { hours: String(Math.floor(minutes / 60)) });
      // DAYS past two, because hours stop being legible: two sensors in the
      // first house this was measured in had last reported 53 and 59 days
      // earlier, and both rendered as "1414 h ago" — true, and unreadable as
      // the "this sensor is dead" it actually meant. Homey still reports such a
      // sensor as available and it still returns a finite number, so the age is
      // the ONLY thing that can reveal it (platform §16).
      return t('ageDays', { days: String(Math.floor(minutes / 1440)) });
    }

    function reading(what, value, unknown) {
      var row = node('div', 'dl-reading');
      row.appendChild(node('span', 'dl-what', what));
      row.appendChild(node('span', unknown ? 'dl-val dl-unknown' : 'dl-val', value));
      return row;
    }

    function readingFor(deviceId) {
      for (var i = 0; i < model.readings.length; i++) {
        if (model.readings[i].deviceId === deviceId) return model.readings[i];
      }
      return null;
    }

    function renderNow() {
      clear(el.now);

      var sky = model.sky || {};
      if (sky.elevation === null || sky.elevation === undefined) {
        el.now.appendChild(reading(t('nowSky'), t('nowSkyUnknown'), true));
      } else {
        el.now.appendChild(reading(t('nowSky'), t('nowSkyValue', {
          degrees: String(Math.round(Number(sky.elevation)))
        }), false));
      }

      var chosen = model.response.sensors || [];
      if (chosen.length === 0) {
        el.now.appendChild(reading(t('nowSensors'), t('nowNoSensors'), true));
      } else {
        for (var i = 0; i < chosen.length; i++) {
          var found = readingFor(chosen[i]);
          var name = found && found.name ? found.name : chosen[i];
          if (!found || !found.available || found.lux === null || found.lux === undefined) {
            el.now.appendChild(reading(name, t('sensorNoReading'), true));
          } else {
            el.now.appendChild(reading(name, t('sensorReading', {
              lux: String(Math.round(Number(found.lux))), age: ageText(found.at)
            }), false));
          }
        }
      }

      if (!model.now || model.now.source === 'none') {
        el.now.appendChild(reading(t('nowResult'), t('nowUnknown'), true));
        return;
      }
      el.now.appendChild(reading(t('nowResult'), t('nowResultValue', {
        percent: String(percentOf(model.now.brightness)),
        source: model.now.source === 'sensors' ? t('sourceSensors') : t('sourceSky')
      }), false));
    }

    /**
     * The sensor list, grouped by room, each row carrying its current reading.
     *
     * Built as NODES rather than as a markup string, so nothing here needs
     * escaping — a device name is user-supplied text and this is the safest
     * shape for it.
     *
     * The empty state is not an error. Most households own no light sensor at
     * all, and the sun answers for them perfectly well, so it says so.
     */
    function renderSensors() {
      clear(el.sensors);

      if (model.rooms.length === 0) {
        var none = node('div', 'card');
        none.appendChild(node('div', 'dl-blocktitle', t('sensorsNone')));
        none.appendChild(node('div', 'dl-blockhelp', t('sensorsNoneHelp')));
        el.sensors.appendChild(none);
        return;
      }

      var chosen = model.response.sensors || [];
      for (var r = 0; r < model.rooms.length; r++) {
        var room = model.rooms[r];
        el.sensors.appendChild(node('div', 'section-title', room.zoneName));
        for (var s = 0; s < room.sensors.length; s++) {
          var sensor = room.sensors[s];
          var tile = node('button', chosen.indexOf(sensor.id) !== -1 ? 'tile sel' : 'tile');
          tile.type = 'button';
          tile.dataset.sensor = sensor.id;
          tile.appendChild(node('div', 'name', sensor.name));
          if (!sensor.available) {
            tile.appendChild(node('div', 'dl-tile-lux', t('sensorUnavailable')));
          } else if (sensor.lux === null || sensor.lux === undefined) {
            tile.appendChild(node('div', 'dl-tile-lux', t('sensorNoReading')));
          } else {
            tile.appendChild(node('div', 'dl-tile-lux', t('sensorLux', {
              lux: String(Math.round(Number(sensor.lux)))
            })));
          }
          el.sensors.appendChild(tile);
        }
      }
    }

    /**
     * The four answers, and the reason they are radio buttons.
     *
     * A single choice from a closed set, so a select would hide three of four
     * behind a tap and a segmented control would truncate "Middle of the day" on
     * a phone. `PEAKS` pairs each stored value with its key; the order is the
     * order they are offered in, with "no direct sun" first because it is the
     * default and the commonest true answer for an interior room.
     */
    var PEAKS = [
      { value: 'none', key: 'sunNone' },
      { value: 'morning', key: 'sunMorning' },
      { value: 'midday', key: 'sunMidday' },
      { value: 'afternoon', key: 'sunAfternoon' }
    ];

    function renderSun() {
      // Hidden outright when a sensor is chosen: the sensor measures this room,
      // and asking about it as well would invite somebody to believe the answer
      // still mattered.
      var hasSensor = (model.response.sensors || []).length > 0;
      el.sun.className = hasSensor ? 'dl-sun dl-off' : 'dl-sun';
      if (hasSensor) return;

      var current = model.response.sunPeak || 'none';
      clear(el.peaks);
      PEAKS.forEach(function (peak) {
        var row = node('label', 'dl-peak');
        var input = document.createElement('input');
        input.type = 'radio';
        input.name = 'dl-peak';
        input.value = peak.value;
        input.checked = peak.value === current;
        input.addEventListener('change', function () {
          if (!input.checked) return;
          model.response.sunPeak = peak.value;
          push();
        });
        row.appendChild(input);
        row.appendChild(node('span', null, t(peak.key)));
        el.peaks.appendChild(row);
      });
    }

    function renderControls() {
      el.darkLux.value = String(model.response.darkLux);
      el.brightLux.value = String(model.response.brightLux);
      el.dark.value = String(percentOf(model.response.dark));
      el.bright.value = String(percentOf(model.response.bright));
      el.darkValue.textContent = t('percent', { value: String(percentOf(model.response.dark)) });
      el.brightValue.textContent = t('percent', { value: String(percentOf(model.response.bright)) });
      el.previewCard.hidden = !model.standalone;
    }

    function render() {
      if (!model.loaded) return;
      renderNow();
      renderSensors();
      renderSun();
      renderControls();
    }

    function payload() {
      return {
        sensors: (model.response.sensors || []).slice(),
        darkLux: Number(el.darkLux.value),
        brightLux: Number(el.brightLux.value),
        dark: Number(el.dark.value) / 100,
        bright: Number(el.bright.value) / 100,
        // From the MODEL, not the DOM: the radios are not rendered at all while
        // a sensor is chosen, so reading them would send 'none' the moment
        // somebody picked a sensor and undo an answer they had already given.
        sunPeak: model.response.sunPeak || 'none'
      };
    }

    /**
     * Push, and take back what the driver made of it.
     *
     * The reply is authoritative rather than an acknowledgement:
     * `sanitiseResponse` corrects per field — an inverted lux range resets both
     * ends, a brightness under the floor comes up to it — and a card that went
     * on showing what the user typed would be a card saving something different
     * from what it says.
     */
    function push() {
      return emit('setDaylight', { response: payload() }).then(function (result) {
        model.response = result.response;
        model.now = result.now;
        model.readings = result.sensorReadings || [];
        render();
        return result;
      });
    }

    /**
     * A push whose failure must not be swallowed by the caller's happy path.
     *
     * Every fire-and-forget site needs its own catch: an unhandled rejection
     * inside the pairing container is a screen that silently stops responding.
     */
    function pushQuietly() {
      push().catch(function (err) {
        el.previewResult.textContent = String(err && err.message ? err.message : err);
      });
    }

    el.sensors.addEventListener('click', function (event) {
      var tile = event.target && event.target.closest ? event.target.closest('.tile') : null;
      if (!tile || !tile.dataset.sensor) return;

      var id = tile.dataset.sensor;
      var chosen = (model.response.sensors || []).slice();
      var at = chosen.indexOf(id);
      if (at === -1) chosen.push(id);
      else chosen.splice(at, 1);
      model.response.sensors = chosen;

      // Rendered before the round trip so the tap feels immediate, and again
      // from the reply, which is the authority.
      render();
      pushQuietly();
    });

    el.dark.addEventListener('input', function () {
      el.darkValue.textContent = t('percent', { value: String(el.dark.value) });
    });
    el.bright.addEventListener('input', function () {
      el.brightValue.textContent = t('percent', { value: String(el.bright.value) });
    });

    // `change` rather than `input` for the push: a slider dragged across its
    // range fires input for every pixel, and each one is a round trip.
    el.dark.addEventListener('change', pushQuietly);
    el.bright.addEventListener('change', pushQuietly);
    el.darkLux.addEventListener('change', pushQuietly);
    el.brightLux.addEventListener('change', pushQuietly);

    el.preview.addEventListener('click', function () {
      el.preview.disabled = true;
      el.preview.textContent = t('previewing');
      el.previewResult.textContent = '';

      push().then(function () {
        return emit('previewNow');
      }).then(function (outcome) {
        el.previewResult.textContent = t('previewed', {
          writes: String((outcome && outcome.writes) || 0)
        });
      }).catch(function (err) {
        el.previewResult.textContent = String(err && err.message ? err.message : err);
      }).then(function () {
        el.preview.disabled = false;
        el.preview.textContent = t('preview');
      });
    });

    return {
      /** Fetch everything this card needs. Two calls, because two handlers. */
      load: function () {
        return Promise.all([emit('getDaylight'), emit('listSensors')]).then(function (replies) {
          var data = replies[0] || {};
          var sensors = replies[1] || {};

          model.standalone = data.standalone === true;
          if (data.response) model.response = data.response;
          if (data.limits) model.limits = data.limits;
          model.now = data.now || null;
          model.sky = data.sky || null;
          model.readings = data.sensorReadings || [];
          model.rooms = sensors.rooms || [];
          model.loaded = true;

          // Bounded by what the driver will actually accept, so a number the
          // sanitiser would clamp cannot be typed in the first place.
          el.darkLux.min = String(model.limits.minLux);
          el.darkLux.max = String(model.limits.maxLux);
          el.brightLux.min = String(model.limits.minLux);
          el.brightLux.max = String(model.limits.maxLux);

          render();
          return data;
        });
      },
      /** Whether this device's own plan IS the response. */
      isStandalone: function () {
        return model.standalone;
      },
      /**
       * Show or hide the card.
       *
       * The host screen decides: a Daylight light always shows it, and the other
       * three show it only once a row actually follows the daylight. A schedule
       * screen that already carries twelve windows should not also carry a
       * sensor picker nobody asked for.
       */
      setUsed: function (used) {
        el.card.className = used ? 'section dl-card' : 'section dl-card dl-off';
      },
      /** Push the current controls, for a host screen saving its own plan. */
      push: push
    };
  }
