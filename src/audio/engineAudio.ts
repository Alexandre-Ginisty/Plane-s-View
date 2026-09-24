/**
 * The Web Audio graph that turns `engineModel` into a noise.
 *
 * ## Shape of the graph
 *
 *   noise ──► bandpass ──► rushGain ──┐
 *   noise ──► highpass ──► windGain ──┼──► tilt ──► master ──► destination
 *   osc x3 ──► toneGain ─────────────-┘
 *
 * Three oscillators rather than one: a blade-pass fundamental and two
 * harmonics at fixed ratios. A single sine is a test tone, and a sawtooth has
 * far too many harmonics to sound like anything mechanical. Three partials
 * with the right relative levels is the smallest thing that reads as an
 * engine.
 *
 * `tilt` is a lowpass standing in for distance and insulation: a flight deck
 * hears the same engine through a bulkhead, and a tower observer hears it
 * through two kilometres of air. Both are overwhelmingly a loss of high
 * frequencies, so one filter does both jobs honestly.
 *
 * ## Why every parameter moves with `setTargetAtTime`
 *
 * Because they are updated every frame from a Kalman-filtered track, and
 * assigning `.value` sixty times a second produces a click on every assignment
 * — the parameter jumps discontinuously and the discontinuity is audible as a
 * tick. `setTargetAtTime` schedules an exponential approach on the audio
 * thread instead, which is both smoother and cheaper.
 *
 * ## Autoplay
 *
 * Nothing here runs until the user asks for it. Browsers will not start an
 * AudioContext without a gesture, and unprompted engine noise from a browser
 * tab is a bad thing to do to somebody regardless of what the browser allows.
 */

import type { CameraMode } from '@/render/pov';
import type { AirframeShape } from '@/render/aircraft';
import type { FlightRegime } from '@/state/regime';
import {
  engineClassFor,
  fundamentalHz,
  mixFor,
  perspectiveGain,
  windLevel,
  type EngineClass,
} from './engineModel';

/** Seconds for a parameter to cover most of the distance to its new value. */
const GLIDE = 0.09;
/** Longer for the master, so enabling and disabling fade rather than snap. */
const FADE = 0.35;

/** Relative level of the second and third partials. */
const HARMONICS: readonly { ratio: number; level: number }[] = [
  { ratio: 1, level: 1 },
  { ratio: 2, level: 0.42 },
  { ratio: 3.02, level: 0.18 },
];

/** A few seconds of steady noise, looped. */
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  const seconds = 3;
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);

  // Pink-ish rather than white: white noise is a hiss, and every real airflow
  // and combustion noise has far more energy low down than high up. Voss-McCartney
  // in its cheap three-pole form, which is inaudibly different from the full one.
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099_046;
    b1 = 0.963 * b1 + white * 0.296_5;
    b2 = 0.57 * b2 + white * 1.052_6;
    data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.16;
  }
  return buffer;
}

export class EngineAudio {
  private ctx: AudioContext | null = null;

  private master: GainNode | null = null;
  private tilt: BiquadFilterNode | null = null;
  private rushGain: GainNode | null = null;
  private rushFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private toneGain: GainNode | null = null;
  private oscillators: { osc: OscillatorNode; gain: GainNode }[] = [];

  private enabled = false;
  private volume = 0.7;

  get running(): boolean {
    return this.enabled;
  }

  /**
   * Build the graph and start it.
   *
   * Must be called from a user gesture. Returns false if the browser refused,
   * which is not an error worth surfacing as one — the user clicked a speaker
   * icon and no sound came out, and a toast explaining audio policy helps
   * nobody.
   */
  async enable(): Promise<boolean> {
    if (this.enabled) return true;
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      if (!this.master) this.build(this.ctx);

      this.enabled = true;
      this.master?.gain.setTargetAtTime(this.volume, this.ctx.currentTime, FADE);
      return true;
    } catch {
      this.enabled = false;
      return false;
    }
  }

  /** Fade out and suspend. The graph is kept so re-enabling is instant. */
  disable(): void {
    if (!this.ctx || !this.master) {
      this.enabled = false;
      return;
    }
    this.enabled = false;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, FADE);
    // Suspended after the fade has actually finished, or the tail is cut off
    // and the fade becomes the click it was there to avoid.
    const ctx = this.ctx;
    window.setTimeout(() => {
      if (!this.enabled) void ctx.suspend().catch(() => undefined);
    }, FADE * 4000);
  }

  setVolume(value: number): void {
    this.volume = Math.min(1, Math.max(0, value));
    if (this.enabled && this.ctx && this.master) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, GLIDE);
    }
  }

  private build(ctx: AudioContext): void {
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    const tilt = ctx.createBiquadFilter();
    tilt.type = 'lowpass';
    tilt.frequency.value = 4_000;
    tilt.Q.value = 0.4;
    tilt.connect(master);

    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer(ctx);
    source.loop = true;

    // Engine rush: a wide band centred low, which is the jet roar.
    const rushFilter = ctx.createBiquadFilter();
    rushFilter.type = 'bandpass';
    rushFilter.frequency.value = 320;
    rushFilter.Q.value = 0.55;
    const rushGain = ctx.createGain();
    rushGain.gain.value = 0;
    source.connect(rushFilter).connect(rushGain).connect(tilt);

    // Airflow over the airframe: the same noise, but hissier and separate, so
    // it can keep going with the engines at idle.
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'highpass';
    windFilter.frequency.value = 500;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    source.connect(windFilter).connect(windGain).connect(tilt);

    const toneGain = ctx.createGain();
    toneGain.gain.value = 0;
    toneGain.connect(tilt);

    for (const harmonic of HARMONICS) {
      const osc = ctx.createOscillator();
      // Not a sine: a real blade-pass tone has a hard edge to it. Triangle has
      // the odd harmonics without a sawtooth's buzz.
      osc.type = harmonic.ratio === 1 ? 'triangle' : 'sine';
      osc.frequency.value = 120 * harmonic.ratio;
      const gain = ctx.createGain();
      gain.gain.value = harmonic.level;
      osc.connect(gain).connect(toneGain);
      osc.start();
      this.oscillators.push({ osc, gain });
    }

    source.start();

    this.master = master;
    this.tilt = tilt;
    this.rushGain = rushGain;
    this.rushFilter = rushFilter;
    this.windGain = windGain;
    this.toneGain = toneGain;
  }

  /**
   * Retune the graph to the aircraft and the moment.
   *
   * Called every frame. Everything it touches is an `AudioParam` glide, so a
   * dropped frame or a jittery regime estimate is smoothed on the audio thread
   * rather than heard.
   */
  update(shape: AirframeShape, regime: FlightRegime, mode: CameraMode): void {
    if (!this.enabled || !this.ctx || !this.toneGain) return;

    const now = this.ctx.currentTime;
    const klass: EngineClass = engineClassFor(shape);
    const view = perspectiveGain(mode);
    const mix = mixFor(klass, regime);
    const fundamental = fundamentalHz(klass, shape, regime);

    const set = (param: AudioParam, value: number): void => {
      param.setTargetAtTime(value, now, GLIDE);
    };

    if (fundamental > 0) {
      for (let i = 0; i < this.oscillators.length; i++) {
        const node = this.oscillators[i]!;
        const harmonic = HARMONICS[i]!;
        // Clamped below Nyquist: a turbofan's third partial is over 3 kHz and
        // an unclamped sweep past the sample rate folds back as a descending
        // whistle, which is the one artefact nobody can un-hear.
        set(node.osc.frequency, Math.min(fundamental * harmonic.ratio, 11_000));
      }
    }

    set(this.toneGain.gain, fundamental > 0 ? mix.tone * view.engine : 0);
    if (this.rushGain) set(this.rushGain.gain, mix.rush * view.engine);
    if (this.rushFilter) {
      // The rush climbs in pitch with power, which is most of what "spooling
      // up" sounds like.
      set(this.rushFilter.frequency, 220 + 420 * regime.power);
    }
    if (this.windGain) set(this.windGain.gain, windLevel(regime) * view.wind);
    if (this.tilt) set(this.tilt.frequency, view.cutoffHz);
  }

  dispose(): void {
    this.enabled = false;
    for (const { osc } of this.oscillators) {
      try {
        osc.stop();
      } catch {
        // Already stopped; nothing to do.
      }
    }
    this.oscillators = [];
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
  }
}
