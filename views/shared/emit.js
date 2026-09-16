function emit(event, data) {
    /**
     * Homey.emit, as a promise that always settles.
     *
     * GENERATED. Spliced into every pair view by `npm run sync:views` from
     * views/shared/emit.js. **Edit that file, not this one.**
     *
     * Both call styles are handled because the pairing bridge has used a
     * callback and a promise at different times, and the 20 s timeout is what
     * keeps a dropped callback from leaving the screen spinning with no message
     * forever.
     *
     * Inside the function, like `stabiliseScrollbar()`'s, and that is not a
     * style choice: `spliceFunction` matches from the `function` keyword, so a
     * docblock above one is never replaced — it is prepended again on every
     * sync. Four stale copies of the week grid's reached the shipped archive
     * that way. It also means this explanation now appears in all 56 views
     * rather than in the two credential screens that happened to carry it.
     */
    return new Promise(function (resolve, reject) {
      var settled = false;
      var finish = function (err, result) {
        if (settled) return;
        settled = true;
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve(result);
      };
      var timer = setTimeout(function () { finish(new Error('Homey did not respond in time. Close this screen and try again. (' + event + ')')); }, 20000);
      var done = function (err, result) { clearTimeout(timer); finish(err, result); };
      try {
        var returned = Homey.emit(event, data, function (err, result) { done(err, result); });
        if (returned && typeof returned.then === 'function') {
          returned.then(function (r) { done(null, r); }, function (e) { done(e); });
        }
      } catch (err) { done(err); }
    });
  }
