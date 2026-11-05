// Looped rain ambience. Web Audio rather than <audio loop>: an element
// leaves a gap at the wrap, a buffer source loops sample-accurately. The
// file already has its seam crossfaded (see README "Audio").
const FADE_IN = 1.5; // s
const FADE_OUT = 0.6;

export class RainSound {
  private readonly url: string;
  private bytes?: Promise<ArrayBuffer>;
  private ctx?: AudioContext;
  private buffer?: AudioBuffer;
  private gain?: GainNode;
  private source?: AudioBufferSourceNode;
  playing = false;

  constructor(url: string) {
    this.url = url;
  }

  // Download ahead of the first click so it starts at once
  prefetch() {
    this.bytes ??= fetch(this.url).then((r) => r.arrayBuffer());
  }

  async play() {
    this.playing = true;
    this.prefetch();
    // Created on the click so browsers allow it to start
    this.ctx ??= new AudioContext();
    await this.ctx.resume();
    this.buffer ??= await this.ctx.decodeAudioData((await this.bytes!).slice(0));
    if (!this.playing || this.source) return;

    const { ctx, buffer } = this;
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
    this.gain.gain.setValueAtTime(0, ctx.currentTime);
    this.gain.gain.linearRampToValueAtTime(1, ctx.currentTime + FADE_IN);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    // Skip encoder priming/padding silence at either end
    const [start, end] = audibleRange(buffer);
    source.loopStart = start;
    source.loopEnd = end;
    source.connect(this.gain);
    source.start(0, start);
    this.source = source;
  }

  stop() {
    this.playing = false;
    const { ctx, gain, source } = this;
    if (!ctx || !gain || !source) return;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + FADE_OUT);
    source.stop(ctx.currentTime + FADE_OUT);
    this.source = this.gain = undefined;
  }
}

function audibleRange(buffer: AudioBuffer): [number, number] {
  const data = buffer.getChannelData(0);
  const limit = Math.min(data.length >> 1, Math.round(buffer.sampleRate * 0.25));
  let a = 0, b = data.length - 1;
  while (a < limit && Math.abs(data[a]) < 1e-4) a++;
  while (data.length - 1 - b < limit && Math.abs(data[b]) < 1e-4) b--;
  return [a / buffer.sampleRate, (b + 1) / buffer.sampleRate];
}
