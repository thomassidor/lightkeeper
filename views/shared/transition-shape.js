function transitionShape(kind, t) {
    /**
     * How far a value has moved at fraction `t` of the way between two points.
     *
     * GENERATED. Spliced into every carrier by `npm run sync:views` from
     * views/shared/transition-shape.js. **Edit that file, not this one.**
     *
     * The same maths as `shape()` in lib/support/interpolate.ts, which a pair
     * view cannot import: Gradual is linear, Balanced and Quick are a logistic
     * normalised so that 0 → 0 and 1 → 1, with k = 6 and k = 16. Change one,
     * change both.
     */
    var x = Math.max(0, Math.min(1, t));
    if (kind === 'gradual') return x;
    var k = kind === 'quick' ? 16 : 6;
    var s = function (v) { return 1 / (1 + Math.exp(-k * (v - 0.5))); };
    return (s(x) - s(0)) / (s(1) - s(0));
  }
