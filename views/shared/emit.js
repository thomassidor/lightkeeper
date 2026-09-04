function emit(event, data) {
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
