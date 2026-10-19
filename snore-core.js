'use strict';

/* Спільна логіка детекції хропіння: її використовують і нічна сесія в index.html, і tools/replay.mjs,
   тому правила підтвердження, утримання сигналу й тригери перевіряються на тому самому коді */
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VioCore = api;
})(typeof self !== 'undefined' ? self : globalThis, () => {
  // Кільцевий буфер для YAMNet: знижує частоту дискретизації до AI_SAMPLE_RATE усередненням і віддає останнє вікно
  function createAiBuffer(C, inputRate) {
    const data = new Float32Array(C.AI_WINDOW_SAMPLES);
    const ratio = inputRate / C.AI_SAMPLE_RATE;
    let writeIndex = 0;
    let filled = 0;
    let accumulator = 0;
    let accumulated = 0;
    let position = 0;

    function push(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        accumulator += chunk[i];
        accumulated += 1;
        position += 1;
        if (position < ratio) continue;
        data[writeIndex] = accumulator / accumulated;
        writeIndex = (writeIndex + 1) % data.length;
        filled = Math.min(filled + 1, data.length);
        accumulator = 0;
        accumulated = 0;
        position -= ratio;
      }
    }

    function isFull() {
      return filled >= data.length;
    }

    function latestWindow() {
      const window = new Float32Array(data.length);
      window.set(data.subarray(writeIndex), 0);
      window.set(data.subarray(0, writeIndex), data.length - writeIndex);
      return window;
    }

    return { push, isFull, latestWindow };
  }

  // Початковий стан нейромережі в сесії
  function createAiState() {
    return {
      isReady: false, isBusy: false, isSnore: false, snoreReason: '', snoreHits: [], lastWeakAt: 0, fastHits: 0,
      isAwake: false, belowSince: null, updatedAt: 0, forcedUntil: 0
    };
  }

  // Гістерезис нейромережі: прокидання при env > AI_WAKE_RMS, засинання після AI_SLEEP_DELAY_MS безперервно нижче AI_SLEEP_RMS
  function updateAiWakefulness(ai, env, C, now) {
    if (env > C.AI_WAKE_RMS) {
      ai.isAwake = true;
      ai.belowSince = null;
      return;
    }
    if (env >= C.AI_SLEEP_RMS) {
      ai.belowSince = null;
      return;
    }
    if (ai.belowSince === null) ai.belowSince = now;
    if (ai.isAwake && now - ai.belowSince > C.AI_SLEEP_DELAY_MS) ai.isAwake = false;
  }

  function formatHit(hit, classLabel) {
    const classes = hit.top.map((item) => `${classLabel(item.index)} ${item.score.toFixed(2)}`).join(', ');
    return `${new Date(hit.wall).toLocaleTimeString('uk-UA')} Snoring ${hit.snoring.toFixed(2)} [${classes}]`;
  }

  function describeConfirmation(hits, C, threshold, classLabel) {
    return `підтвердження скором (поріг ${threshold.toFixed(2)}, ${hits.length} с за ${C.AI_CONFIRM_WINDOW_MS / 1000} с): ${hits.map((hit) => formatHit(hit, classLabel)).join(' і ')}`;
  }

  // Нейромережа спить, але сигнал ще може триматися: він гасне лише після AI_HOLD_QUIET_MS без секунди зі Snoring понад AI_HOLD_SCORE
  function idleScore(ai, C, now) {
    ai.updatedAt = now;
    ai.isSnore = ai.isSnore && now - ai.lastWeakAt < C.AI_HOLD_QUIET_MS;
    ai.snoreHits = [];
    ai.fastHits = 0;
  }

  // Одна класифікація (раз на секунду): оновлює підтвердження за скором, швидкий тригер і утримання сигналу.
  // input: { now, wall, snoring, rms, top, threshold, classLabel }; повертає { isFastConfirmed, fastReason }
  function registerScore(ai, C, input) {
    const { now, wall, snoring, rms, top, threshold, classLabel } = input;
    const isFastHit = snoring > C.AI_FAST_SCORE && rms > C.AI_FAST_RMS;
    ai.fastHits = isFastHit ? ai.fastHits + 1 : 0;
    const isFastConfirmed = ai.fastHits >= C.AI_FAST_HITS;
    ai.updatedAt = now;
    const isAboveThreshold = snoring > threshold;
    if (snoring > C.AI_HOLD_SCORE) ai.lastWeakAt = now;
    const freshHits = ai.snoreHits.filter((hit) => now - hit.at < C.AI_CONFIRM_WINDOW_MS);
    ai.snoreHits = isAboveThreshold ? [...freshHits, { at: now, wall, snoring, top }] : freshHits;
    const isScoreConfirmed = isAboveThreshold && ai.snoreHits.length >= C.AI_CONFIRM_HITS;
    const fastReason = `швидкий тригер: Snoring ${snoring.toFixed(2)} і RMS ${rms.toFixed(3)}, ${ai.fastHits} класифікації поспіль`;
    const isHeld = ai.isSnore && now - ai.lastWeakAt < C.AI_HOLD_QUIET_MS;
    ai.isSnore = isScoreConfirmed || isFastConfirmed || isHeld;
    if (isScoreConfirmed) {
      ai.snoreReason = describeConfirmation(ai.snoreHits.slice(-C.AI_CONFIRM_HITS), C, threshold, classLabel);
      ai.snoreHits = [];
    } else if (isFastConfirmed) {
      ai.snoreReason = fastReason;
    }
    return { isFastConfirmed, fastReason };
  }

  function canStartEpisode(st, now) {
    return !st.episode && now >= st.lockoutUntil;
  }

  // Тригер: клас Snoring (свіжий вердикт ШІ) АБО гучність понад LOUD_RMS довше LOUD_HOLD_MS.
  // Повертає причину, якщо треба стартувати епізод (Рефлекс 1), інакше null
  function evaluateTriggers(st, C, now, rms) {
    const ai = st.ai;
    const isSnoreHit = ai.isReady && now - ai.updatedAt < C.AI_STALE_MS && ai.isSnore;
    if (rms > C.LOUD_RMS) {
      if (st.loudSince === null) st.loudSince = now;
    } else {
      st.loudSince = null;
    }
    const isLoudHit = st.loudSince !== null && now - st.loudSince >= C.LOUD_HOLD_MS;
    const isForced = now < ai.forcedUntil;
    st.isActive = isSnoreHit || isLoudHit || isForced;
    if (!st.isActive || !canStartEpisode(st, now)) return null;
    if (isSnoreHit) return ai.snoreReason;
    if (isLoudHit) return `гучний звук: RMS ${rms.toFixed(3)} понад ${C.LOUD_RMS} довше ${C.LOUD_HOLD_MS / 1000} с`;
    return 'інженерний тест';
  }

  return { createAiBuffer, createAiState, updateAiWakefulness, idleScore, registerScore, canStartEpisode, evaluateTriggers };
});
