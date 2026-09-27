// AudioWorklet: mic -> 16 kHz mono PCM16 chunks (posted as ArrayBuffer).
class Pcm16 extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.ratio = sampleRate / 16000;
    this.chunk = Math.round(16000 * opts.processorOptions.chunkMs / 1000);
    this.buf = new Int16Array(this.chunk);
    this.n = 0;
    this.acc = 0; this.accN = 0; this.pos = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      // box-filter decimation to 16 kHz
      this.acc += ch[i]; this.accN++; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.accN));
        this.acc = 0; this.accN = 0;
        this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.chunk) {
          this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
          this.buf = new Int16Array(this.chunk);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm16', Pcm16);
