function i18n(homey) {
    /**
     * Plural-aware translation, and the language's own number and date rules.
     *
     * GENERATED. Spliced into every pair view, and into the settings page, by
     * `npm run sync:views` from views/shared/i18n.js. **Edit that file, not
     * this one.**
     *
     * The twin of `lib/support/i18n.ts`, and it must choose the same forms:
     * a counted string is a group of CLDR plural categories, the count is the
     * `count` token, and `Intl.PluralRules` in the locale file's OWN language
     * (`meta.language`) picks the form. `t()` is `Homey.__` with that one
     * extra step, so a view calls it exactly where it called `Homey.__`.
     *
     * `dir` is `meta.direction`: every view puts it on its own root, because
     * the screens share one document and only the root is ours.
     */
    var raw = function (key, tokens) { return homey.__(key, tokens || {}); };
    var found = function (value, key) { return typeof value === 'string' && value !== '' && value !== key; };
    var lang = raw('meta.language');
    // Deliberately no memo: the views share one document, and a cache on it
    // would outlive a language change. Two lookups per call are nothing.
    if (!/^[a-z]{2}$/.test(String(lang))) lang = 'en';
    var select = function (n, type) {
      try { return new Intl.PluralRules(lang, { type: type || 'cardinal' }).select(n); }
      catch (e) { return n === 1 ? 'one' : 'other'; }
    };
    var pick = function (key, form, tokens) {
      var chosen = raw(key + '.' + form, tokens);
      if (found(chosen, key + '.' + form)) return chosen;
      var other = raw(key + '.other', tokens);
      return found(other, key + '.other') ? other : null;
    };
    var t = function (key, tokens) {
      tokens = tokens || {};
      if (typeof tokens.count === 'number' && isFinite(tokens.count)) {
        var form = pick(key, select(tokens.count), tokens);
        if (form !== null) return form;
      }
      var plain = raw(key, tokens);
      return typeof plain === 'string' ? plain : key;
    };
    return {
      lang: lang,
      dir: raw('meta.direction') === 'rtl' ? 'rtl' : 'ltr',
      t: t,
      /** "1st", "1.", "1er" — the language's own ordinal, from `ordinal.*`. */
      ordinal: function (n) { return pick('ordinal', select(n, 'ordinal'), { n: n }) || String(n); },
      /**
       * "a, b, c" with the language's own comma — "،" in Arabic. A key, not
       * `Intl.ListFormat`, whose unit style drops the commas altogether in
       * Korean and Russian and adds an "and" in German.
       */
      list: function (items) { return items.join(raw('unit.listSeparator')); },
      /** A percentage: "40%", "40 %" — the space is the language's, not ours. */
      percent: function (n) { return t('unit.percent', { n: n }); },
      /** A date and time, in the app's language rather than the phone's. */
      dateTime: function (value, options) {
        var date = new Date(value);
        try { return date.toLocaleString(lang, options); } catch (e) { return date.toLocaleString(); }
      },
      time: function (value) {
        var date = new Date(value);
        try { return date.toLocaleTimeString(lang); } catch (e) { return date.toLocaleTimeString(); }
      }
    };
  }
