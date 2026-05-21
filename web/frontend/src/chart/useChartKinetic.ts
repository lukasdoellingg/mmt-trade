/**
 * Kinetic / inertia scrolling for the chart pan gesture.
 *
 * Self-contained: takes a velocity-source closure (provides current pan
 * position in bar units) and an "apply pan" callback, returns control
 * primitives. No Vue reactivity — runs from the RAF loop.
 *
 * Tuned to mmt.gg's panning feel: exponential damping with a tight cap on
 * peak speed so flick-scrolls don't fly off the chart's right edge.
 */

const MIN_SPEED = 0.2;
const MAX_SPEED = 7;
const DAMPING = 0.997;
const MIN_MOVE_PX = 15;
const EPSILON = 1;
const MAX_DELAY_MS = 50;

interface VelocitySample {
  pos: number;
  time: number;
}
interface AnimationState {
  startOffset: number;
  startTime: number;
  speed: number;
  duration: number;
}

export interface KineticControl {
  /** Push a fresh (pos, time) sample. Call this from the pan-move handler. */
  addSample(pos: number, time: number): void;
  /** Reset velocity history (call on pointer-down). */
  resetSamples(): void;
  /** Start the inertia animation if there is enough velocity. */
  start(currentOffset: number, barSpacing: number, now: number): void;
  /** Advance the inertia state by one RAF tick.
   *  Returns true while the animation is still running. */
  tick(now: number, applyOffset: (offset: number) => void): boolean;
  /** Cancel any running animation. */
  stop(): void;
  /** Whether an animation is currently in flight. */
  isActive(): boolean;
}

export function createKineticControl(): KineticControl {
  let samples: VelocitySample[] = [];
  let animation: AnimationState | null = null;

  function addSample(pos: number, time: number, barSpacing = 1): void {
    if (samples.length > 0) {
      const last = samples[samples.length - 1];
      if (last.time === time) {
        last.pos = pos;
        return;
      }
      if (Math.abs(last.pos - pos) < MIN_MOVE_PX / barSpacing) return;
    }
    samples.push({ pos, time });
    if (samples.length > 4) samples.shift();
  }

  function resetSamples(): void {
    samples = [];
  }

  function start(currentOffset: number, barSpacing: number, now: number): void {
    animation = null;
    if (samples.length < 2) return;
    const last = samples[samples.length - 1];
    if (now - last.time > MAX_DELAY_MS) return;

    let totalDist = 0;
    const speeds: number[] = [];
    const dists: number[] = [];
    for (let i = samples.length - 1; i > 0; i--) {
      const dt = samples[i].time - samples[i - 1].time;
      if (dt === 0) continue;
      let spd = (samples[i].pos - samples[i - 1].pos) / dt;
      spd = Math.sign(spd) * Math.min(Math.abs(spd), MAX_SPEED / barSpacing);
      if (speeds.length > 0 && Math.sign(spd) !== Math.sign(speeds[0])) break;
      const d = Math.abs(samples[i].pos - samples[i - 1].pos);
      speeds.push(spd);
      dists.push(d);
      totalDist += d;
    }
    if (totalDist === 0) return;

    let resultSpeed = 0;
    for (let i = 0; i < speeds.length; i++) resultSpeed += (dists[i] / totalDist) * speeds[i];
    if (Math.abs(resultSpeed) < MIN_SPEED / barSpacing) return;

    const lnD = Math.log(DAMPING);
    const dur = Math.log((EPSILON * lnD) / -Math.abs(resultSpeed)) / lnD;
    if (dur <= 0) return;
    animation = { startOffset: currentOffset, startTime: now, speed: resultSpeed, duration: dur };
  }

  function tick(now: number, applyOffset: (offset: number) => void): boolean {
    if (!animation) return false;
    const elapsed = now - animation.startTime;
    if (elapsed >= animation.duration) {
      animation = null;
      return false;
    }
    const lnD = Math.log(DAMPING);
    const offset = animation.startOffset + (animation.speed * (Math.pow(DAMPING, elapsed) - 1)) / lnD;
    applyOffset(offset);
    return true;
  }

  function stop(): void {
    animation = null;
  }

  function isActive(): boolean {
    return animation !== null;
  }

  return {
    addSample: (pos, time) => addSample(pos, time, 1),
    resetSamples,
    start,
    tick,
    stop,
    isActive,
  };
}
