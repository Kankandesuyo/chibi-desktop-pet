import { Container, Graphics, Text } from 'pixi.js';

export type EffectKind = 'heart' | 'star' | 'sweat' | 'zzz' | 'anger' | 'question' | 'exclaim' | 'note';

interface Particle { node: Container; age: number; life: number; vx: number; vy: number; spin: number; grow: number }

const MAX_PARTICLES = 24;

function heart(): Graphics {
  return new Graphics()
    .moveTo(0, 6).bezierCurveTo(-13, -4, -6, -13, 0, -6).bezierCurveTo(6, -13, 13, -4, 0, 6)
    .fill(0xff8fa3).stroke({ width: 1.4, color: 0xd94863 });
}
function star(): Graphics {
  const g = new Graphics();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 9 : 3.8;
    const x = Math.sin((i * Math.PI) / 5) * r, y = -Math.cos((i * Math.PI) / 5) * r;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  return g.closePath().fill(0xffd54a).stroke({ width: 1.2, color: 0xc98a1c });
}
function sweat(): Graphics {
  return new Graphics().moveTo(0, -8).bezierCurveTo(7, 2, 5, 8, 0, 8).bezierCurveTo(-5, 8, -7, 2, 0, -8)
    .fill(0xaee0ff).stroke({ width: 1.2, color: 0x4c9fd6 });
}
function anger(): Graphics {
  const g = new Graphics();
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    g.moveTo(sx * 3, sy * 9).quadraticCurveTo(sx * 3, sy * 3, sx * 9, sy * 3);
  }
  return g.stroke({ width: 3, color: 0xe5484d, cap: 'round' });
}
function glyph(text: string, color: number, size: number): Text {
  const t = new Text({ text, style: { fontFamily: 'Segoe UI, Microsoft YaHei UI, sans-serif', fontSize: size, fontWeight: '900', fill: color, stroke: { color: 0xffffff, width: 3 } } });
  t.anchor.set(0.5);
  return t;
}

/** Small floating marks (hearts, Zzz, sweat…). Pooled and capped so a long session cannot leak nodes. */
export class EffectLayer {
  readonly container = new Container();
  private particles: Particle[] = [];

  get active(): boolean { return this.particles.length > 0; }

  spawn(kind: EffectKind, x: number, y: number, scale = 1): void {
    if (this.particles.length >= MAX_PARTICLES) this.remove(0);
    let node: Container;
    let vy = -34, vx = (Math.random() - 0.5) * 22, life = 1.3, spin = 0, grow = 0;
    switch (kind) {
      case 'heart': node = heart(); break;
      case 'star': node = star(); spin = 4; vy = -50; vx = (Math.random() - 0.5) * 90; life = 0.9; break;
      case 'sweat': node = sweat(); vy = 30; vx = (Math.random() - 0.5) * 60; life = 0.7; break;
      case 'anger': node = anger(); vy = 0; vx = 0; life = 1.4; grow = 0.25; break;
      case 'zzz': node = glyph('Z', 0x6a8fd8, 18); vy = -22; vx = 10; life = 2; grow = 0.5; break;
      case 'question': node = glyph('?', 0xf07a2a, 26); vy = -12; vx = 0; life = 1.2; break;
      case 'exclaim': node = glyph('!', 0xe5484d, 28); vy = -12; vx = 0; life = 0.9; break;
      case 'note': node = glyph('♪', 0xf07a2a, 22); break;
    }
    node.position.set(x, y);
    node.scale.set(scale);
    this.container.addChild(node);
    this.particles.push({ node, age: 0, life, vx: vx * scale, vy: vy * scale, spin, grow });
  }

  private remove(index: number): void {
    const [p] = this.particles.splice(index, 1);
    if (p) { this.container.removeChild(p.node); p.node.destroy(); }
  }

  update(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i] as Particle;
      p.age += dt;
      if (p.age >= p.life) { this.remove(i); continue; }
      p.node.x += p.vx * dt;
      p.node.y += p.vy * dt;
      p.node.rotation += p.spin * dt;
      if (p.grow) p.node.scale.set(p.node.scale.x * (1 + p.grow * dt));
      const left = 1 - p.age / p.life;
      p.node.alpha = Math.min(1, left * 2.2);
    }
  }

  clear(): void { while (this.particles.length) this.remove(0); }
  destroy(): void { this.clear(); this.container.destroy({ children: true }); }
}
