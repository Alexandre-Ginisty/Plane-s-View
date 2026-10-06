/**
 * Photos and clips of the 3D view.
 *
 * The HUD is DOM over the canvas, so neither a photo nor a clip contains it:
 * what is saved is the view itself, which is what anyone would want to keep.
 * A photo gets a discreet caption burnt into its corner instead — the flight,
 * and where it was taken from — so it still says what it is once it has been
 * forwarded three times.
 */

/** Longest clip, seconds. Long enough for a landing, short enough to send. */
const MAX_CLIP_SECONDS = 60;

/** The caption strip, drawn into the corner of a photo. */
export function captionPhoto(frame: HTMLCanvasElement, lines: readonly string[]): HTMLCanvasElement {
  const ctx = frame.getContext('2d');
  if (!ctx || lines.length === 0) return frame;

  const scale = Math.max(1, frame.height / 900);
  const size = Math.round(15 * scale);
  const pad = Math.round(14 * scale);
  const gap = Math.round(6 * scale);
  ctx.font = `600 ${size}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
  const height = lines.length * size + (lines.length - 1) * gap + pad * 2;
  const x = Math.round(20 * scale);
  const y = frame.height - height - Math.round(20 * scale);

  ctx.fillStyle = 'rgba(8, 12, 18, 0.55)';
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = '#ffb347';
  ctx.fillRect(x, y, Math.max(2, Math.round(2 * scale)), height);
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => {
    ctx.fillStyle = i === 0 ? '#f4f6f8' : 'rgba(244, 246, 248, 0.72)';
    ctx.fillText(line, x + pad, y + pad + i * (size + gap));
  });
  return frame;
}

export function toJpeg(frame: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => frame.toBlob(resolve, 'image/jpeg', 0.92));
}

/**
 * The first container this browser can record into. MP4 first: it plays
 * everywhere it is sent, where WebM still does not open on an iPhone.
 */
function recordingType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

export const canRecord = (): boolean =>
  recordingType() !== null && typeof HTMLCanvasElement.prototype.captureStream === 'function';

/** One clip being recorded from a canvas. */
export class ClipRecorder {
  private readonly recorder: MediaRecorder;
  private readonly chunks: Blob[] = [];
  private readonly done: Promise<Blob>;
  private readonly limit: ReturnType<typeof setTimeout>;
  readonly startedAt = performance.now();

  /** Throws when the browser cannot record; check `canRecord` first. */
  constructor(canvas: HTMLCanvasElement, onLimit: () => void) {
    const type = recordingType();
    if (!type) throw new Error('recording unsupported');
    const stream = canvas.captureStream(30);
    // Enough for a sharp 1080p view of moving terrain, small enough to send.
    this.recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.done = new Promise((resolve) => {
      this.recorder.onstop = () => {
        for (const track of stream.getTracks()) track.stop();
        resolve(new Blob(this.chunks, { type: type.split(';')[0] }));
      };
    });
    this.recorder.start(1000);
    this.limit = setTimeout(onLimit, MAX_CLIP_SECONDS * 1000);
  }

  get extension(): string {
    return this.recorder.mimeType.includes('mp4') ? 'mp4' : 'webm';
  }

  stop(): Promise<Blob> {
    clearTimeout(this.limit);
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    return this.done;
  }
}
