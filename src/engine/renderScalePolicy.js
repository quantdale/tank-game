/**
 * Pure render-scale and adaptive performance budget policy shared across
 * the engine post stack, quality system, and Node self-tests.
 * Ratios are expressed relative to CSS pixels; the renderer ratio is the
 * native canvas density and the preset cap is the maximum 3D/post density.
 */

const DEFAULT_DYNAMIC_MIN = 0.75;

export const OVERLOAD_RELIEF_STAGES = Object.freeze([
  'fx',          // 1. Shed optional/secondary FX
  'vegetation',  // 2. Shed distant detail / vegetation
  'shadows',     // 3. Shed shadow complexity
  'post',        // 4. Shed post-processing quality (AO / bloom)
  'resolution',  // 5. Reduce internal render scale
  'tier',        // 6. Demote auto preset tier
]);

export const RECOVERY_STAGES = Object.freeze([
  'resolution',  // 1. Recover internal render scale first (structural clarity)
  'post',        // 2. Recover post-processing quality (restore AO / bloom)
  'shadows',     // 3. Recover shadow complexity
  'vegetation',  // 4. Recover distant detail / vegetation
  'fx',          // 5. Recover optional/secondary FX
]);

export function cappedPixelRatio(rendererPixelRatio, preset) {
  const rendererRatio = Math.max(0.01, Number(rendererPixelRatio) || 1);
  const presetCap = Math.max(0.01, Number(preset?.maxPixelRatio) || rendererRatio);
  return Math.min(rendererRatio, presetCap);
}

/** Initial dynamic scale. A preset may start below its ceiling and earn it. */
export function baseDynamicScale(rendererPixelRatio, preset) {
  const capped = cappedPixelRatio(rendererPixelRatio, preset);
  const requested = Number(preset?.adaptiveBasePixelRatio) || capped;
  const base = Math.min(capped, Math.max(0.01, requested));
  return base / capped;
}

/** Lowest legal dynamic scale for the active preset/device class. */
export function dynamicScaleFloor(rendererPixelRatio, preset) {
  const configured = Number.isFinite(preset?.dynMin)
    ? preset.dynMin : DEFAULT_DYNAMIC_MIN;
  // A native-density desktop canvas must not be blurred below 1 CSS pixel per
  // axis. Retina/mobile presets carry their own explicit floor.
  return Math.min(1, Math.max(
    rendererPixelRatio < 1.25 ? 1 : 0,
    configured,
  ));
}

export function internalPixelRatio(rendererPixelRatio, preset, dynamicScale) {
  return cappedPixelRatio(rendererPixelRatio, preset)
    * Math.min(1, Math.max(dynamicScaleFloor(rendererPixelRatio, preset), dynamicScale));
}

/**
 * Pure hierarchical overload relief decision.
 * Hierarchical order:
 *  1. Optional/secondary FX
 *  2. Distant detail / vegetation
 *  3. Shadow complexity
 *  4. Post-processing quality (AO / bloom)
 *  5. Internal render scale
 *  6. Tier demotion
 *
 * @param {object} trims - { fxTrim, vegetationTrim, shadowTrim, postTrim }
 * @param {object} maxTrims - { maxFxTrim, maxVegetationTrim, maxShadowTrim, maxPostTrim }
 * @param {number} dynamicScale
 * @param {number} floor
 * @returns {'fx'|'vegetation'|'shadows'|'post'|'resolution'|'tier'}
 */
export function hierarchicalReliefLever(trims = {}, maxTrims = {}, dynamicScale = 1.0, floor = 0.9) {
  const fxTrim = trims.fxTrim || 0;
  const maxFxTrim = maxTrims.maxFxTrim ?? 1;
  if (fxTrim < maxFxTrim) return 'fx';

  const vegetationTrim = trims.vegetationTrim || 0;
  const maxVegetationTrim = maxTrims.maxVegetationTrim ?? 1;
  if (vegetationTrim < maxVegetationTrim) return 'vegetation';

  const shadowTrim = trims.shadowTrim || 0;
  const maxShadowTrim = maxTrims.maxShadowTrim ?? 1;
  if (shadowTrim < maxShadowTrim) return 'shadows';

  const postTrim = trims.postTrim || 0;
  const maxPostTrim = maxTrims.maxPostTrim ?? 1;
  if (postTrim < maxPostTrim) return 'post';

  if (dynamicScale > floor + 1e-4) return 'resolution';
  return 'tier';
}

/**
 * Pure hierarchical recovery decision (reverse order of visual impact).
 * Order: resolution -> post -> shadows -> vegetation -> fx.
 *
 * @param {object} trims - { fxTrim, vegetationTrim, shadowTrim, postTrim }
 * @param {number} dynamicScale
 * @returns {'resolution'|'post'|'shadows'|'vegetation'|'fx'|'nominal'}
 */
export function hierarchicalRecoveryLever(trims = {}, dynamicScale = 1.0) {
  if (dynamicScale < 1.0 - 1e-4) return 'resolution';
  if ((trims.postTrim || 0) > 0) return 'post';
  if ((trims.shadowTrim || 0) > 0) return 'shadows';
  if ((trims.vegetationTrim || 0) > 0) return 'vegetation';
  if ((trims.fxTrim || 0) > 0) return 'fx';
  return 'nominal';
}

/**
 * Backward-compatible overload relief lever query.
 * Accepts either traditional (performanceTrim, maxTrim, dynamicScale, floor)
 * or rich hierarchical parameters.
 */
export function overloadReliefLever(performanceTrim, maxTrim, dynamicScale, floor) {
  if (typeof performanceTrim === 'object' && performanceTrim !== null) {
    const trims = performanceTrim;
    const limits = typeof maxTrim === 'object' && maxTrim !== null ? maxTrim : {};
    return hierarchicalReliefLever(trims, limits, dynamicScale, floor);
  }
  if (performanceTrim < maxTrim) return 'trim';
  if (dynamicScale > floor) return 'resolution';
  return 'tier';
}

/**
 * Fresh GTAO taps per frame. Presets below full-res AO run temporally
 * accumulated half-resolution AO (post.js AO_TAA), so eight fresh taps
 * converge to the same grounding the 16-tap inspection profile gives
 * full-res Ultra; aoScale >= 0.99 keeps all sixteen.
 * @param {number} aoScale @returns {number}
 */
export function aoSampleCount(aoScale) {
  return Number(aoScale) >= 0.99 ? 16 : 8;
}

/** RCAS recovery grows with enlargement, capped before halos become dominant. */
export function reconstructionSharpness(inputToOutputScale) {
  const scale = Math.min(1, Math.max(0, Number(inputToOutputScale) || 0));
  return Math.min(0.4, Math.max(0.12, 0.12 + (1 - scale) * 0.64));
}

// --- Effective Lever Resolvers -----------------------------------------------

/** Resolve effective grass range bands based on active vegetation trim. */
export function resolveEffectiveGrassBands(preset, vegetationTrim = 0) {
  const baseMid = preset?.grassMidFadeEnd ?? 180;
  const baseTaper = preset?.grassTaperEnd ?? 155;
  if (!(vegetationTrim > 0)) return { grassMidFadeEnd: baseMid, grassTaperEnd: baseTaper };
  const trimmedMid = Math.max(90, Math.round(baseMid * 0.75));
  const trimmedTaper = Math.max(75, Math.round(baseTaper * 0.75));
  return { grassMidFadeEnd: trimmedMid, grassTaperEnd: trimmedTaper };
}

/** Resolve effective shadow caster and cascade budgets based on active shadow trim. */
export function resolveEffectiveShadowLevers(preset, shadowTrim = 0) {
  const baseMinTexels = preset?.shadowCasterMinTexels ?? 0.75;
  const baseFarBudget = preset?.shadowFarInstanceBudget ?? 4096;
  if (!(shadowTrim > 0)) {
    return { shadowCasterMinTexels: baseMinTexels, shadowFarInstanceBudget: baseFarBudget };
  }
  const trimmedMinTexels = Number((baseMinTexels * 1.5).toFixed(3));
  const trimmedFarBudget = Math.max(512, Math.floor(baseFarBudget * 0.65));
  return { shadowCasterMinTexels: trimmedMinTexels, shadowFarInstanceBudget: trimmedFarBudget };
}

/** Resolve effective terrain streaming budget based on active vegetation trim. */
export function resolveEffectiveTerrainStreamBudget(preset, vegetationTrim = 0) {
  const base = preset?.terrainStreamBudgetMs ?? 1.25;
  if (!(vegetationTrim > 0)) return base;
  return Math.max(0.5, Number((base * 0.6).toFixed(2)));
}

/** Resolve effective AO scale based on post trim. */
export function resolveEffectiveAoScale(preset, postTrim = 0) {
  const base = preset?.aoScale ?? 0;
  if (postTrim > 0) return 0;
  return base;
}

/** Resolve effective bloom scale based on post trim. */
export function resolveEffectiveBloomScale(preset, postTrim = 0) {
  const base = preset?.bloomScale ?? 0.5;
  if (postTrim > 0) return Number((base * 0.7).toFixed(2));
  return base;
}

/** Resolve effective combat-FX budget based on active FX trim. */
export function resolveEffectiveFxBudget(fxTrim = 0) {
  if (fxTrim > 0) {
    return {
      admittedFraction: 0.6,
      columnPuffsMax: 2,
      dustAdmitted: false,
      heavyCredits: 1,
    };
  }
  return {
    admittedFraction: 1.0,
    columnPuffsMax: 4,
    dustAdmitted: true,
    heavyCredits: 2,
  };
}

// -----------------------------------------------------------------------------
// UNIFIED ADAPTIVE BUDGET COORDINATOR
// -----------------------------------------------------------------------------

export class AdaptiveBudgetCoordinator {
  constructor(options = {}) {
    this.targetMs = options.targetMs ?? 8.5; // 120 fps target
    this.budgetMaxMs = options.budgetMaxMs ?? 34.0; // clamp ceiling
    this.intervalS = options.intervalS ?? 1.5; // evaluation window (seconds)
    this.warmupS = options.warmupS ?? 3.0; // boot warmup
    this.downLevel = options.downLevel ?? 1.08;
    this.upLevel = options.upLevel ?? 1.06;
    this.missAt = options.missAt ?? 1.12;
    this.downMissMin = options.downMissMin ?? 0.15;
    this.upMissMax = options.upMissMax ?? 0.04;
    this.minWindowFrames = options.minWindowFrames ?? 30;
    this.flapWindowS = options.flapWindowS ?? 8.0;
    this.backoffMaxS = options.backoffMaxS ?? 30.0;
    this.backoffResetS = options.backoffResetS ?? 60.0;
    this.trimStrikesMax = options.trimStrikesMax ?? 2;
    this.tierStrikesMax = options.tierStrikesMax ?? 4;
    this.fpsDeclineK = options.fpsDeclineK ?? 0.80;
    this.fpsBaselineMin = options.fpsBaselineMin ?? 24;
    this.fpsSmoothCeiling = options.fpsSmoothCeiling ?? 118;
    this.resolutionStep = options.resolutionStep ?? 0.09;
    this.cleanLookbackFrames = options.cleanLookbackFrames ?? 120;

    this.onTierDemoteCallback = options.onTierDemote || null;

    this._listeners = new Set();
    this.reset();
  }

  reset(preset = null, rendererPixelRatio = 1.0) {
    this.clock = 0;
    this.lastDecision = 0;
    this.lastUpAt = -Infinity;
    this.lastDownAt = -Infinity;
    this.lastStepTime = 0;

    this.frameEma = 0;
    this.cadenceRing = new Float32Array(180);
    this.cadenceRingScratch = new Float32Array(180);
    this.ringN = 0;
    this.ringI = 0;

    this.winFrames = 0;
    this.winMisses = 0;

    this.budgetMs = this.targetMs;
    this.bestCadenceMs = this.budgetMaxMs;
    this.fpsBaseline = 0;
    this.windowFps = 0;

    this.upBackoffS = this.intervalS;
    this.trimStrikes = 0;
    this.tierStrikes = 0;

    this.fxTrim = 0;
    this.vegetationTrim = 0;
    this.shadowTrim = 0;
    this.postTrim = 0;

    this.dynamicScale = preset ? baseDynamicScale(rendererPixelRatio, preset) : 1.0;
    this.pin = null;
    this.suspended = false;

    this._notify();
  }

  setSuspended(suspended) {
    this.suspended = Boolean(suspended);
    if (this.suspended) {
      this.winFrames = 0;
      this.winMisses = 0;
    }
  }

  pinDynamicScale(val, preset, rendererPixelRatio) {
    if (val == null) {
      this.pin = null;
    } else {
      const floor = preset ? dynamicScaleFloor(rendererPixelRatio, preset) : 0.6;
      this.pin = Math.min(1.0, Math.max(floor, Number(val)));
      this.dynamicScale = this.pin;
      this._notify();
    }
  }

  forceTrim(stage, val) {
    const v = Math.max(0, Math.round(Number(val) || 0));
    if (stage === 'fx') this.fxTrim = v;
    else if (stage === 'vegetation') this.vegetationTrim = v;
    else if (stage === 'shadows') this.shadowTrim = v;
    else if (stage === 'post') this.postTrim = v;
    this._notify();
  }

  onTierDemote(fn) {
    this.onTierDemoteCallback = fn;
  }

  addListener(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify() {
    for (const fn of this._listeners) {
      try { fn(this); } catch (_) { /* ignore subscriber error */ }
    }
  }

  /**
   * Record one rendered frame delta time.
   * @param {number} dt frame delta in seconds
   * @param {boolean} [isHidden] document is backgrounded/hidden
   * @param {object} [preset] active quality preset
   * @param {number} [rendererPixelRatio] native device pixel ratio
   * @returns {boolean} true if a budget adjustment was applied
   */
  recordFrame(dt, isHidden = false, preset = null, rendererPixelRatio = 1.0) {
    if (this.suspended) return false;
    if (!(dt > 0) || dt > 0.25) return false; // ignore hitches and tab-switches
    if (isHidden) return false;

    this.clock += dt;
    if (this.clock < this.warmupS) return false; // warmup turbulence

    const ms = dt * 1000;
    this.frameEma = this.frameEma === 0 ? ms : this.frameEma + (ms - this.frameEma) * 0.06;

    this.cadenceRing[this.ringI] = ms;
    this.ringI = (this.ringI + 1) % this.cadenceRing.length;
    if (this.ringN < this.cadenceRing.length) this.ringN++;

    this.winFrames++;
    if (ms > this.budgetMs * this.missAt) this.winMisses++;

    if (this.pin !== null) return false;

    if (this.clock - this.lastDecision < this.intervalS) return false;
    if (this.winFrames < this.minWindowFrames) return false;

    return this.evaluate(preset, rendererPixelRatio);
  }

  /**
   * Evaluate the completed window and apply hierarchical relief or recovery.
   * @param {object} [preset]
   * @param {number} [rendererPixelRatio]
   * @returns {boolean} true if state changed
   */
  evaluate(preset = null, rendererPixelRatio = 1.0) {
    // Cadence estimation (p10 of recent frame deltas)
    this.cadenceRingScratch.set(this.cadenceRing.subarray(0, this.ringN));
    const sorted = this.cadenceRingScratch.subarray(0, this.ringN).sort();
    const p10 = sorted[Math.floor(this.ringN * 0.10)] || this.budgetMaxMs;
    this.bestCadenceMs = Math.min(this.bestCadenceMs, p10);
    this.budgetMs = Math.min(this.budgetMaxMs, Math.max(this.targetMs, this.bestCadenceMs));

    const missRatio = this.winMisses / Math.max(1, this.winFrames);
    this.windowFps = this.winFrames / Math.max(0.001, this.clock - this.lastDecision);

    // Recovery eligibility reads recent frame history (the cadence ring that
    // also sets budgetMs) rather than the hard decision window. A window that
    // straddles a relief step always inherits the previous regime's misses —
    // the final overloaded tail lands in the next window and would
    // systematically delay each recovery by a full interval. Scoring only the
    // most recent `cleanLookbackFrames` samples rotates stale pre-step frames
    // out quickly while still demanding a genuinely clean stretch (the same
    // 4% bar) before quality is restored.
    const lookback = Math.min(this.ringN, this.cleanLookbackFrames);
    let recentMisses = 0;
    for (let k = 0; k < lookback; k++) {
      const idx = (this.ringI - 1 - k + this.cadenceRing.length * 2) % this.cadenceRing.length;
      if (this.cadenceRing[idx] > this.budgetMs * this.missAt) recentMisses++;
    }
    const recentMissRatio = recentMisses / Math.max(1, lookback);

    this.winFrames = 0;
    this.winMisses = 0;
    this.lastDecision = this.clock;

    // Anti-flap forgiveness after a quiet minute
    if (this.upBackoffS > this.intervalS && this.clock - this.lastDownAt > this.backoffResetS) {
      this.upBackoffS = this.intervalS;
    }

    const overBudget = this.frameEma > this.budgetMs * this.downLevel && missRatio > this.downMissMin;
    const fpsDeclined = this.fpsBaseline >= this.fpsBaselineMin
      && this.windowFps < this.fpsBaseline * this.fpsDeclineK
      && this.windowFps < this.fpsSmoothCeiling;
    const overloaded = overBudget || fpsDeclined;

    if (!overloaded) {
      this.fpsBaseline = this.fpsBaseline === 0 ? this.windowFps
        : this.fpsBaseline + (this.windowFps - this.fpsBaseline) * (this.windowFps > this.fpsBaseline ? 0.3 : 0.05);
    } else if (fpsDeclined) {
      this.fpsBaseline += (this.windowFps - this.fpsBaseline) * 0.15;
    }

    const clean = this.frameEma < this.budgetMs * this.upLevel && recentMissRatio < this.upMissMax;

    if (overloaded) {
      return this._applyOverloadStep(preset, rendererPixelRatio);
    } else if (clean) {
      return this._applyRecoveryStep(preset, rendererPixelRatio);
    }

    return false;
  }

  _applyOverloadStep(preset, rendererPixelRatio) {
    const dynFloor = dynamicScaleFloor(rendererPixelRatio, preset);
    const maxTrims = {
      maxFxTrim: 1,
      maxVegetationTrim: 1,
      maxShadowTrim: 1,
      maxPostTrim: (preset?.aoScale ?? 0) > 0 ? 1 : 0,
    };
    const trims = {
      fxTrim: this.fxTrim,
      vegetationTrim: this.vegetationTrim,
      shadowTrim: this.shadowTrim,
      postTrim: this.postTrim,
    };

    const action = hierarchicalReliefLever(trims, maxTrims, this.dynamicScale, dynFloor);

    if (action === 'tier') {
      if (this.clock > 8) {
        this.tierStrikes++;
        if (this.tierStrikes >= this.tierStrikesMax) {
          this.tierStrikes = 0;
          if (this.onTierDemoteCallback) {
            const demoted = this.onTierDemoteCallback();
            if (demoted) {
              this.reset(preset, rendererPixelRatio);
              return true;
            }
          }
        }
      }
      return false;
    }

    this.tierStrikes = 0;

    if (action === 'resolution') {
      this.dynamicScale = Math.max(dynFloor, this.dynamicScale - this.resolutionStep);
      if (this.clock - this.lastUpAt < this.flapWindowS) {
        this.upBackoffS = Math.min(this.upBackoffS * 2, this.backoffMaxS);
      }
      this.lastDownAt = this.clock;
      this.lastStepTime = this.clock;
      this.frameEma = this.budgetMs;
      this._notify();
      return true;
    }

    // Coarse trim stage ('fx', 'vegetation', 'shadows', 'post')
    this.trimStrikes++;
    if (this.trimStrikes >= this.trimStrikesMax) {
      this.trimStrikes = 0;
      if (action === 'fx') this.fxTrim = 1;
      else if (action === 'vegetation') this.vegetationTrim = 1;
      else if (action === 'shadows') this.shadowTrim = 1;
      else if (action === 'post') this.postTrim = 1;

      if (this.clock - this.lastUpAt < this.flapWindowS * 2) {
        this.upBackoffS = Math.min(this.upBackoffS * 2, this.backoffMaxS);
      }
      this.lastDownAt = this.clock;
      this.lastStepTime = this.clock;
      this.frameEma = this.budgetMs;
      this._notify();
      return true;
    }

    return false;
  }

  _applyRecoveryStep(preset, rendererPixelRatio) {
    this.trimStrikes = 0;
    this.tierStrikes = 0;

    // Ensure recovery cooldown has elapsed
    if (this.clock - this.lastStepTime < this.upBackoffS) return false;
    if (this.clock - this.lastDownAt < this.upBackoffS) return false;

    const trims = {
      fxTrim: this.fxTrim,
      vegetationTrim: this.vegetationTrim,
      shadowTrim: this.shadowTrim,
      postTrim: this.postTrim,
    };

    const action = hierarchicalRecoveryLever(trims, this.dynamicScale);

    if (action === 'resolution') {
      this.dynamicScale = Math.min(1.0, this.dynamicScale + this.resolutionStep);
      this.lastUpAt = this.clock;
      this.lastStepTime = this.clock;
      this.frameEma = this.budgetMs;
      this._notify();
      return true;
    }

    if (action === 'post') {
      this.postTrim = 0;
      this.lastUpAt = this.clock;
      this.lastStepTime = this.clock;
      this._notify();
      return true;
    }

    if (action === 'shadows') {
      this.shadowTrim = 0;
      this.lastUpAt = this.clock;
      this.lastStepTime = this.clock;
      this._notify();
      return true;
    }

    if (action === 'vegetation') {
      this.vegetationTrim = 0;
      this.lastUpAt = this.clock;
      this.lastStepTime = this.clock;
      this._notify();
      return true;
    }

    if (action === 'fx') {
      this.fxTrim = 0;
      this.lastUpAt = this.clock;
      this.lastStepTime = this.clock;
      this._notify();
      return true;
    }

    return false;
  }

  /**
   * Computed effective parameters across all graphics systems.
   */
  getEffectiveLevers(preset, rendererPixelRatio = 1.0) {
    const grass = resolveEffectiveGrassBands(preset, this.vegetationTrim);
    const shadows = resolveEffectiveShadowLevers(preset, this.shadowTrim);
    const terrainStreamBudgetMs = resolveEffectiveTerrainStreamBudget(preset, this.vegetationTrim);
    const aoScale = resolveEffectiveAoScale(preset, this.postTrim);
    const bloomScale = resolveEffectiveBloomScale(preset, this.postTrim);
    const fx = resolveEffectiveFxBudget(this.fxTrim);
    const renderScale = internalPixelRatio(rendererPixelRatio, preset, this.dynamicScale);
    const floor = dynamicScaleFloor(rendererPixelRatio, preset);
    const maxTrims = {
      maxFxTrim: 1,
      maxVegetationTrim: 1,
      maxShadowTrim: 1,
      maxPostTrim: (preset?.aoScale ?? 0) > 0 ? 1 : 0,
    };
    const trims = {
      fxTrim: this.fxTrim,
      vegetationTrim: this.vegetationTrim,
      shadowTrim: this.shadowTrim,
      postTrim: this.postTrim,
    };

    const reliefStage = hierarchicalReliefLever(trims, maxTrims, this.dynamicScale, floor);

    return {
      fxTrim: this.fxTrim,
      vegetationTrim: this.vegetationTrim,
      shadowTrim: this.shadowTrim,
      postTrim: this.postTrim,
      dynamicScale: this.dynamicScale,
      internalPixelRatio: renderScale,
      renderScale,
      grassMidFadeEnd: grass.grassMidFadeEnd,
      grassTaperEnd: grass.grassTaperEnd,
      terrainStreamBudgetMs,
      shadowCasterMinTexels: shadows.shadowCasterMinTexels,
      shadowFarInstanceBudget: shadows.shadowFarInstanceBudget,
      aoEnabled: aoScale > 0 && this.postTrim === 0,
      aoScale,
      bloomScale,
      fxAdmittedFraction: fx.admittedFraction,
      fxColumnPuffsMax: fx.columnPuffsMax,
      fxDustAdmitted: fx.dustAdmitted,
      reliefStage,
    };
  }

  getTelemetry(preset, rendererPixelRatio = 1.0) {
    const levers = this.getEffectiveLevers(preset, rendererPixelRatio);
    return {
      frameEmaMs: Number(this.frameEma.toFixed(2)),
      fps: Number(this.windowFps.toFixed(1)),
      fpsBaseline: Number(this.fpsBaseline.toFixed(1)),
      budgetMs: Number(this.budgetMs.toFixed(2)),
      dynamicScale: Number(this.dynamicScale.toFixed(3)),
      renderScale: Number(levers.renderScale.toFixed(3)),
      fxTrim: this.fxTrim,
      vegetationTrim: this.vegetationTrim,
      shadowTrim: this.shadowTrim,
      postTrim: this.postTrim,
      reliefStage: levers.reliefStage,
      trimStrikes: this.trimStrikes,
      tierStrikes: this.tierStrikes,
      upBackoffS: Number(this.upBackoffS.toFixed(1)),
      suspended: this.suspended,
    };
  }
}

export function createAdaptiveBudgetCoordinator(options = {}) {
  return new AdaptiveBudgetCoordinator(options);
}

