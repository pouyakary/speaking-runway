const STAGES = {
  ready: { color: "#85898a" },
  speaking: { color: "#85898a" },
  landing: { color: "#a92429" },
  final: { color: "#cb622b" },
  urgent: { color: "#dc2028" },
  paused: { color: "#85898a" },
  complete: { color: "#dc2028" },
};

const DURATIONS = [10, 15, 20, 30, 60];
const DIAL_FADE_MS = 90;

const elements = {
  body: document.body,
  sector: document.querySelector("#timeSector"),
  tickMarks: document.querySelector("#tickMarks"),
  dialNumbers: document.querySelector("#dialNumbers"),
  dialButton: document.querySelector("#dialButton"),
  timeReadout: document.querySelector("#timeReadout"),
  durationButtons: [...document.querySelectorAll(".duration-button")],
  soundButton: document.querySelector("#soundButton"),
  soundLabel: document.querySelector("#soundButton span"),
  resetButton: document.querySelector("#resetButton"),
  music: document.querySelector("#runwayMusic"),
};

const savedDuration = Number(localStorage.getItem("runway-duration"));
let durationMinutes = DURATIONS.includes(savedDuration) ? savedDuration : 15;
let totalMs = durationMinutes * 60_000;
let remainingMs = totalMs;
let endTime = 0;
let state = "idle";
let currentStage = "ready";
let animationFrame = null;
let audioContext = null;
let wakeLock = null;
let holdTimer = null;
let suppressNextDialClick = false;
let dialInitialized = false;
let dialTransitionId = 0;
let soundEnabled = localStorage.getItem("runway-sound") !== "off";
const announcedStages = new Set();

function polarPoint(cx, cy, radius, angleDegrees) {
  const radians = ((angleDegrees - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  };
}

function sectorPath(fractionRemaining) {
  if (fractionRemaining <= 0) return "";
  const radius = 247;
  const endAngle = Math.min(fractionRemaining, 0.99999) * 360;
  const start = polarPoint(300, 300, radius, 0);
  const end = polarPoint(300, 300, radius, endAngle);
  const largeArc = endAngle > 180 ? 1 : 0;
  return `M 300 300 L ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

function buildDial(minutes, animate = false) {
  const svgNS = "http://www.w3.org/2000/svg";
  const tickCount = minutes * 2;
  const labelStep = minutes === 10 ? 2 : minutes === 15 ? 3 : minutes <= 30 ? 5 : 10;
  const revealStepMs = Math.min(14, 600 / tickCount);
  elements.tickMarks.replaceChildren();
  elements.dialNumbers.replaceChildren();
  elements.tickMarks.classList.remove("dial-face-leaving");
  elements.dialNumbers.classList.remove("dial-face-leaving");

  for (let tick = 0; tick < tickCount; tick += 1) {
    const line = document.createElementNS(svgNS, "line");
    const major = tick % 2 === 0;
    const minute = tick / 2;
    const labelled = major && minute % labelStep === 0;
    const angle = (tick / tickCount) * 360;
    const outer = polarPoint(300, 300, 231, angle);
    const inner = polarPoint(300, 300, labelled ? 201 : major ? 208 : 217, angle);
    line.setAttribute("x1", outer.x);
    line.setAttribute("y1", outer.y);
    line.setAttribute("x2", inner.x);
    line.setAttribute("y2", inner.y);
    line.setAttribute("stroke-width", labelled ? "8" : major ? "5" : "3");
    line.setAttribute("opacity", major ? ".95" : ".8");
    if (animate) {
      line.classList.add("dial-mark-enter");
      line.style.setProperty("--mark-opacity", major ? ".95" : ".8");
      line.style.setProperty("--reveal-delay", `${tick * revealStepMs}ms`);
    }
    elements.tickMarks.append(line);
  }

  for (let minute = 0; minute < minutes; minute += labelStep) {
    const label = document.createElementNS(svgNS, "text");
    const point = polarPoint(300, 300, 175, (minute / minutes) * 360);
    label.setAttribute("x", point.x);
    label.setAttribute("y", point.y);
    label.textContent = minute;
    if (animate) {
      label.classList.add("dial-mark-enter");
      label.style.setProperty("--mark-opacity", "1");
      label.style.setProperty("--reveal-delay", `${minute * 2 * revealStepMs}ms`);
    }
    elements.dialNumbers.append(label);
  }
}

function transitionDial(minutes) {
  const transitionId = ++dialTransitionId;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (reduceMotion) {
    buildDial(minutes);
    return;
  }

  elements.tickMarks.classList.add("dial-face-leaving");
  elements.dialNumbers.classList.add("dial-face-leaving");

  window.setTimeout(() => {
    if (transitionId !== dialTransitionId) return;
    buildDial(minutes, true);
  }, DIAL_FADE_MS);
}

function formatTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function stageForProgress(progress) {
  if (state === "complete") return "complete";
  if (state === "paused") return "paused";
  if (state === "idle") return "ready";
  if (progress >= 0.95) return "urgent";
  if (progress >= 0.85) return "final";
  if (progress >= 0.65) return "landing";
  return "speaking";
}

function setStage(stage, announce = false) {
  currentStage = stage;
  const details = STAGES[stage];
  elements.body.dataset.stage = stage;
  elements.sector.style.fill = details.color;

  if (announce && !announcedStages.has(stage)) {
    announcedStages.add(stage);
    if (stage === "landing") playChime(440, 659, 0.16);
    if (stage === "final") playChime(523, 784, 0.2);
    if (stage === "urgent") startRunwayMusic();
  }
}

function render() {
  const progress = totalMs ? 1 - remainingMs / totalMs : 0;
  const fractionRemaining = totalMs ? remainingMs / totalMs : 0;
  elements.sector.setAttribute("d", sectorPath(fractionRemaining));
  elements.timeReadout.textContent = formatTime(remainingMs);
  elements.dialButton.setAttribute(
    "aria-label",
    `${state === "running" ? "Pause" : "Start"} timer, ${formatTime(remainingMs)} remaining`,
  );

  const nextStage = stageForProgress(progress);
  if (nextStage !== currentStage) setStage(nextStage, state === "running");

}

function tick(now = performance.now()) {
  if (state !== "running") return;
  remainingMs = Math.max(0, endTime - now);

  if (remainingMs <= 0) {
    completeTimer();
    return;
  }

  render();
  animationFrame = requestAnimationFrame(tick);
}

function prepareAudio() {
  if (!soundEnabled) return;
  audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
  audioContext.resume();

  elements.music.muted = true;
  const unlockAttempt = elements.music.play();
  unlockAttempt
    ?.then(() => {
      elements.music.pause();
      elements.music.currentTime = 0;
      elements.music.muted = false;
      if (state === "running" && currentStage === "urgent") startRunwayMusic();
    })
    .catch(() => {
      elements.music.muted = false;
    });

  if (!unlockAttempt) {
    elements.music.pause();
    elements.music.currentTime = 0;
    elements.music.muted = false;
  }
}

function playChime(startFrequency, endFrequency, volume = 0.18) {
  if (!soundEnabled || !audioContext) return;
  const now = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(startFrequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(endFrequency, now + 0.42);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(volume, now + 0.025);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.68);
}

async function startRunwayMusic() {
  if (!soundEnabled) return;
  elements.music.currentTime = 0;
  elements.music.volume = 0.12;
  try {
    await elements.music.play();
  } catch {
    return;
  }

  const fade = window.setInterval(() => {
    if (state !== "running" || currentStage !== "urgent" || elements.music.paused) {
      window.clearInterval(fade);
      return;
    }
    elements.music.volume = Math.min(0.78, elements.music.volume + 0.025);
  }, 1000);
}

function stopMusic() {
  elements.music.pause();
  elements.music.currentTime = 0;
  elements.music.volume = 0.12;
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    wakeLock = null;
  }
}

async function releaseWakeLock() {
  if (!wakeLock) return;
  await wakeLock.release().catch(() => {});
  wakeLock = null;
}

function startTimer() {
  if (state === "complete") resetTimer();
  prepareAudio();
  state = "running";
  endTime = performance.now() + remainingMs;
  requestWakeLock();
  tick();
}

function pauseTimer() {
  if (state !== "running") return;
  cancelAnimationFrame(animationFrame);
  remainingMs = Math.max(0, endTime - performance.now());
  state = "paused";
  stopMusic();
  releaseWakeLock();
  render();
}

function resetTimer() {
  cancelAnimationFrame(animationFrame);
  state = "idle";
  totalMs = durationMinutes * 60_000;
  remainingMs = totalMs;
  announcedStages.clear();
  stopMusic();
  releaseWakeLock();
  setStage("ready");
  render();
}

function completeTimer() {
  cancelAnimationFrame(animationFrame);
  remainingMs = 0;
  state = "complete";
  stopMusic();
  playChime(392, 784, 0.26);
  releaseWakeLock();
  render();
}

function toggleTimer() {
  if (state === "running") {
    pauseTimer();
  } else {
    startTimer();
  }
}

function selectDuration(minutes) {
  const changed = minutes !== durationMinutes;
  durationMinutes = minutes;
  localStorage.setItem("runway-duration", String(minutes));
  if (!dialInitialized) {
    buildDial(minutes);
    dialInitialized = true;
  } else if (changed) {
    transitionDial(minutes);
  }
  elements.durationButtons.forEach((button) => {
    const selected = Number(button.dataset.minutes) === minutes;
    const wasSelected = button.classList.contains("active");
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
    if (changed && selected !== wasSelected) {
      button.classList.remove("duration-button-press", "duration-button-release");
      void button.offsetWidth;
      button.classList.add(
        selected ? "duration-button-press" : "duration-button-release",
      );
    }
  });
  resetTimer();
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem("runway-sound", soundEnabled ? "on" : "off");
  elements.soundButton.setAttribute("aria-pressed", String(soundEnabled));
  elements.soundLabel.textContent = soundEnabled ? "SOUND ON" : "SOUND OFF";
  if (!soundEnabled) stopMusic();
  else prepareAudio();
}

elements.durationButtons.forEach((button) => {
  button.addEventListener("click", () => selectDuration(Number(button.dataset.minutes)));
});
elements.dialButton.addEventListener("click", () => {
  if (suppressNextDialClick) {
    suppressNextDialClick = false;
    return;
  }
  toggleTimer();
});
elements.resetButton.addEventListener("click", resetTimer);
elements.soundButton.addEventListener("click", toggleSound);

elements.dialButton.addEventListener("pointerdown", () => {
  holdTimer = window.setTimeout(() => {
    holdTimer = null;
    suppressNextDialClick = true;
    resetTimer();
    if (navigator.vibrate) navigator.vibrate(30);
  }, 750);
});
["pointerup", "pointercancel", "pointerleave"].forEach((eventName) => {
  elements.dialButton.addEventListener(eventName, () => {
    if (holdTimer) window.clearTimeout(holdTimer);
    holdTimer = null;
  });
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state === "running") {
    requestWakeLock();
    cancelAnimationFrame(animationFrame);
    tick();
  }
});

document.addEventListener(
  "touchmove",
  (event) => {
    event.preventDefault();
  },
  { passive: false },
);

window.addEventListener("load", () => {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./service-worker.js");
});

selectDuration(durationMinutes);
elements.soundButton.setAttribute("aria-pressed", String(soundEnabled));
elements.soundLabel.textContent = soundEnabled ? "SOUND ON" : "SOUND OFF";
