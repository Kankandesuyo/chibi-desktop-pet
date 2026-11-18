import { useEffect, useRef, useState, type PointerEvent } from 'react';
import './WelcomeAvatar.css';

import type { CharacterId } from '../../shared/characters';
import orangeIdle from '../../assets/characters/idle.png';
import orangeBlink from '../../assets/characters/blink.png';
import orangeWink from '../../assets/characters/wink.png';
import orangeSmile from '../../assets/characters/closed-smile.png';
import whaleIdle from '../../assets/characters/deepseek/idle.png';
import whaleBlink from '../../assets/characters/deepseek/blink.png';
import whaleShy from '../../assets/characters/deepseek/shy.png';
import whaleSmile from '../../assets/characters/deepseek/closed-smile.png';

const portraits = {
  orange: { idle: orangeIdle, blink: orangeBlink, playful: orangeWink, smile: orangeSmile },
  deepseek: { idle: whaleIdle, blink: whaleBlink, playful: whaleShy, smile: whaleSmile },
};
type Expression = keyof typeof portraits.orange;

interface Props {
  character: CharacterId;
  avatar: string;
  name: string;
  t: (text: string) => string;
}

export function WelcomeAvatar({ avatar, name, t, character }: Props) {
  const frames = character === 'orange' || character === 'deepseek' ? portraits[character] : undefined;
  const [expression, setExpression] = useState<Expression>('idle');
  const [blink, setBlink] = useState(false);
  const nextTap = useRef<Expression>('playful');
  useEffect(() => {
    if (!frames) return;
    for (const src of Object.values(frames)) new Image().src = src;
    let clock: number;
    function schedule() {
      clock = window.setTimeout(() => {
        setBlink(true);
        clock = window.setTimeout(() => { setBlink(false); schedule(); }, 145);
      }, 2900 + Math.random() * 2100);
    }
    schedule();
    return () => window.clearTimeout(clock);
  }, [frames]);
  const pose = expression === 'idle' && blink ? 'blink' : expression;
  const [reply, setReply] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const pressedAt = useRef(0);
  const previous = useRef(-1);
  const face = useRef<HTMLSpanElement>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function follow(event: PointerEvent<HTMLButtonElement>) {
    const button = event.currentTarget;
    const box = button.getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, 2 * (event.clientX - box.left) / box.width - 1));
    const y = Math.max(-1, Math.min(1, 2 * (event.clientY - box.top) / box.height - 1));
    button.style.setProperty('--pet-x', (x * 3.5) + 'px');
    button.style.setProperty('--pet-y', (y * 2.5) + 'px');
    button.style.setProperty('--pet-tilt', (x * 7) + 'deg');
  }

  function rest(event: PointerEvent<HTMLButtonElement>) {
    for (const property of ['--pet-x', '--pet-y', '--pet-tilt']) event.currentTarget.style.removeProperty(property);
    if (pressedAt.current) setExpression('idle');
    pressedAt.current = 0;
  }

  function respond() {
    const held = pressedAt.current ? performance.now() - pressedAt.current : 0;
    pressedAt.current = 0;
    const replies = [t('嘿嘿嘿…'), t('再摸摸～'), t('好舒服～')];
    const index = held > 350 ? 2 : (previous.current + 1 + Math.floor(Math.random() * 2)) % replies.length;
    previous.current = index;
    const reaction = held > 350 ? 'smile' : nextTap.current;
    setExpression(reaction);
    nextTap.current = reaction === 'smile' ? 'playful' : 'smile';
    setReply(replies[index]);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { setReply(''); setExpression('idle'); }, 1900);
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && face.current) {
      face.current.getAnimations().forEach(animation => animation.cancel());
      face.current.animate([
        { transform: 'translateY(2px) scale(1.045,.95)' },
        { transform: 'translateY(-2px) scale(.99,1.02)', offset: .52 },
        { transform: 'none' },
      ], { duration: held > 350 ? 540 : 360, easing: 'cubic-bezier(.2,.65,.3,1)' });
    }
  }

  const label = t('摸摸{name}').replace('{name}', name);
  return (
    <div className="welcome-pet">
      <span role="status" className="welcome-pet-reply" data-visible={!!reply}>{reply}</span>
      <button type="button" aria-label={label} title={label} onPointerEnter={follow} onPointerMove={follow}
        onPointerDown={() => { window.clearTimeout(timer.current); setReply(''); pressedAt.current = performance.now(); setExpression('smile'); }} onPointerLeave={rest} onPointerCancel={rest} onClick={respond}>
        <span className="welcome-pet-lean"><span ref={face} className="welcome-pet-face">
          {frames ? <span className="welcome-pet-portrait"><img data-expression={pose} src={frames[pose]} alt="" draggable={false} /></span> : avatar ? <img src={avatar} alt="" draggable={false} /> : name.slice(0, 1)}
        </span></span>
      </button>
    </div>
  );
}
