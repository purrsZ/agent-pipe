import { type CSSProperties, type ReactNode, useState } from 'react';

// 把原型的内联 CSS 字符串原样转成 React style 对象 —— 让我们逐字搬运原版样式，保证像素一致，
// 同时满足 React 对 style 必须是对象的要求。仅做 kebab→camelCase，不解释值。
export function css(s: string): CSSProperties {
  const out: Record<string, string> = {};
  for (const decl of s.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    if (!prop) continue;
    const val = decl.slice(i + 1).trim();
    const camel = prop.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    out[camel] = val;
  }
  return out as CSSProperties;
}

// 还原原型的 style-hover：鼠标悬停时把 hover 样式叠加到基础样式上。
export function Hover(props: {
  base: string;
  hover?: string;
  onClick?: () => void;
  title?: string;
  children?: ReactNode;
}): JSX.Element {
  const [on, setOn] = useState(false);
  const style = on && props.hover ? { ...css(props.base), ...css(props.hover) } : css(props.base);
  const { onClick } = props;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 交互卡片，已用 role=button + tabIndex + onKeyDown 满足无障碍
    <div
      style={style}
      title={props.title}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      onMouseEnter={() => setOn(true)}
      onMouseLeave={() => setOn(false)}
    >
      {props.children}
    </div>
  );
}

// <button> 版的 hover，用于「返回看板」「✓ 拍板通过」等真按钮。
export function HoverBtn(props: {
  base: string;
  hover?: string;
  onClick?: () => void;
  children?: ReactNode;
}): JSX.Element {
  const [on, setOn] = useState(false);
  const style = on && props.hover ? { ...css(props.base), ...css(props.hover) } : css(props.base);
  return (
    <button
      type="button"
      style={style}
      onClick={props.onClick}
      onMouseEnter={() => setOn(true)}
      onMouseLeave={() => setOn(false)}
    >
      {props.children}
    </button>
  );
}
