export type SoundName = 'pop' | 'jump' | 'land' | 'pet' | 'grab';

const TONES: Record<SoundName, [number, number, number]> = {
  // start Hz, end Hz, seconds
  pop: [660, 880, 0.08], jump: [420, 840, 0.16], land: [220, 110, 0.12], pet: [880, 990, 0.1], grab: [520, 330, 0.12],
};

/** Tiny synthesized blips — no audio files to ship. Silent unless enabled in settings. */
export class SoundPlayer {
  enabled = false;
  private ctx: AudioContext | null = null;

  play(name: SoundName): void {
    if (!this.enabled) return;
    try {
      this.ctx ??= new AudioContext();
      const [from, to, len] = TONES[name];
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(from, t);
      osc.frequency.exponentialRampToValueAtTime(to, t + len);
      gain.gain.setValueAtTime(0.08, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + len);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + len);
    } catch { /* sound is never worth crashing for */ }
  }

  destroy(): void { void this.ctx?.close(); this.ctx = null; }
}
