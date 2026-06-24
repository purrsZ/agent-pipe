import { describe, expect, it } from 'vitest';
import { extractPostText } from '../../src/feishu/event-router.js';

// 富文本（post）正文拍平为纯文本：真机暴露的坑——群里粘带格式/文档链接的收料消息是 post 类型，
// 入站只认 text/file/image 会被丢弃。extractPostText 是 post 分支的纯核心（沙箱可测）。

describe('extractPostText', () => {
  it('拍平段落与文字，链接(a)取「文字（URL）」，@/图片忽略', () => {
    const content = {
      title: '立项材料',
      content: [
        [{ tag: 'text', text: '仓库：/abs/a /abs/b' }],
        [
          { tag: 'text', text: 'PRD：' },
          { tag: 'a', text: '设计稿', href: 'https://x/y' },
        ],
        [
          { tag: 'at', user_id: 'ou_1' },
          { tag: 'text', text: ' 验收：能导出' },
          { tag: 'img', image_key: 'img_1' },
        ],
      ],
    };
    const out = extractPostText(content);
    expect(out).toContain('立项材料');
    expect(out).toContain('仓库：/abs/a /abs/b');
    expect(out).toContain('PRD：设计稿（https://x/y）');
    expect(out).toContain('验收：能导出');
    expect(out).not.toContain('img_1'); // 图片忽略
  });

  it('链接只有 href 没有文字时退化为 URL', () => {
    const out = extractPostText({ content: [[{ tag: 'a', href: 'https://only/href' }]] });
    expect(out).toBe('https://only/href');
  });

  it('兼容语言键包裹 {zh_cn:{...}}', () => {
    const out = extractPostText({
      zh_cn: { title: 'T', content: [[{ tag: 'text', text: '正文' }]] },
    });
    expect(out).toContain('T');
    expect(out).toContain('正文');
  });

  it('坏结构 / 空内容 → 空串，永不抛', () => {
    expect(extractPostText(null)).toBe('');
    expect(extractPostText(undefined)).toBe('');
    expect(extractPostText({})).toBe('');
    expect(extractPostText({ content: 'garbage' })).toBe('');
    expect(extractPostText({ content: [['bad-string', { tag: 'img' }]] })).toBe('');
  });
});
