import { describe, expect, it } from 'vitest';
import { parseAiReply, stripPartialTag } from '../shared/aiProtocol';

describe('AI reply protocol', () => {
  it('reads a valid tag and removes it from the text', () => {
    expect(parseAiReply('今天也要加油呀！[[emotion:happy|action:wave]]'))
      .toEqual({ reply: '今天也要加油呀！', emotion: 'happy', action: 'wave' });
  });

  it('falls back to safe defaults for values that are not on the allow-list', () => {
    const r = parseAiReply('好的 [[emotion:furious|action:deleteFiles]]');
    expect(r).toEqual({ reply: '好的', emotion: 'neutral', action: 'none' });
  });

  it('treats a reply without a tag as plain text', () => {
    expect(parseAiReply('你好')).toEqual({ reply: '你好', emotion: 'neutral', action: 'none' });
  });

  it('never turns script-looking text into anything but text', () => {
    const r = parseAiReply('<script>alert(1)</script> rm -rf / [[emotion:shy]]');
    expect(r.emotion).toBe('shy');
    expect(r.action).toBe('none');
    expect(r.reply).toBe('<script>alert(1)</script> rm -rf /');
  });

  it('hides a tag that is still streaming in', () => {
    expect(stripPartialTag('嗯嗯 [[emo')).toBe('嗯嗯 ');
    expect(stripPartialTag('嗯嗯 [')).toBe('嗯嗯 ');
    expect(stripPartialTag('嗯嗯 [[emotion:happy|action:jump]]')).toBe('嗯嗯 ');
  });
});
