/**
 * 建元素的小工具（照 SMV 演示页的思路）。文字一律走 textContent，不拼 innerHTML——页面上有用户输入与外部源的字符串。
 */
export type Attrs = Record<string, string | number | boolean | null | undefined>
export type Child = Node | string | number | null | undefined | false

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, children: readonly Child[] = []): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue
    el.setAttribute(k, v === true ? '' : String(v))
  }
  append(el, children)
  return el
}

export function append(el: Element, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    el.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c)
  }
}

/** 按钮：带类型、文字与点击处理 */
export function button(label: string, onClick: () => void, attrs: Attrs = {}): HTMLButtonElement {
  const b = h('button', { type: 'button', ...attrs }, [label])
  b.addEventListener('click', onClick)
  return b
}

/** 带标签的表单行 */
export function field(label: string, control: HTMLElement, hint?: string | null, attrs: Attrs = {}): HTMLElement {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`
  control.id = id
  return h('div', { class: 'field', ...attrs }, [
    h('label', { for: id }, [label]),
    control,
    hint ? h('small', { class: 'hint' }, [hint]) : null,
  ])
}

export function select(options: ReadonlyArray<{ value: string; label: string }>, current: string, onChange: (v: string) => void, attrs: Attrs = {}): HTMLSelectElement {
  const s = h('select', attrs, options.map((o) => h('option', { value: o.value, selected: o.value === current }, [o.label])))
  s.addEventListener('change', () => onChange(s.value))
  return s
}

export function input(value: string, onInput: (v: string) => void, attrs: Attrs = {}): HTMLInputElement {
  const i = h('input', { type: 'text', ...attrs })
  i.value = value
  i.addEventListener('input', () => onInput(i.value))
  return i
}

export function textarea(value: string, onInput: (v: string) => void, attrs: Attrs = {}): HTMLTextAreaElement {
  const t = h('textarea', attrs)
  t.value = value
  t.addEventListener('input', () => onInput(t.value))
  return t
}

/** 单选组（不预选：`current` 为 null 时没有一项被选中） */
export function radios(name: string, options: ReadonlyArray<{ value: string; label: string; hint?: string | null }>, current: string | null, onChange: (v: string) => void): HTMLElement {
  return h('div', { class: 'radios', role: 'radiogroup' }, options.map((o) => {
    const r = h('input', { type: 'radio', name, value: o.value, id: `${name}-${o.value}` })
    r.checked = current === o.value
    r.addEventListener('change', () => { if (r.checked) onChange(o.value) })
    return h('label', { class: 'radio', for: `${name}-${o.value}` }, [r, h('span', { class: 'radio-label' }, [o.label]), o.hint ? h('small', {}, [o.hint]) : null])
  }))
}

export function clear(el: Element): void { el.replaceChildren() }

/** 换掉全部子节点（跳过 null / false） */
export function set(el: Element, children: readonly Child[]): void {
  el.replaceChildren()
  append(el, children)
}
