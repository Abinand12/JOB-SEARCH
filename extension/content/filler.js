// Finds form fields, asks the server how to answer them, and fills them in.
(() => {
  const JA = globalThis.JA;
  if (JA.autofill) return;

  const RESUME_TOKEN = '__RESUME__';
  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'search', 'password']);
  let seq = 0;

  const clean = (t) =>
    String(t ?? '')
      .replace(/\s*\*\s*$/, '')
      .replace(/\s+(Required|Optional)$/i, '')
      .trim();

  const labelText = (el) => (el ? clean(JA.text(el)) : '');

  function forLabel(el) {
    if (!el.id) return null;
    return el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
  }

  function labelFor(el) {
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const t = ids
        .split(/\s+/)
        .map((id) => labelText(el.ownerDocument.getElementById(id)))
        .filter(Boolean)
        .join(' ');
      if (t) return t;
    }
    const explicit = labelText(forLabel(el));
    if (explicit) return explicit;
    const wrapping = el.closest('label');
    if (wrapping) {
      const t = labelText(wrapping);
      if (t) return t;
    }
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return clean(aria);
    return nearbyText(el) || el.getAttribute('placeholder') || humanize(el.getAttribute('name')) || '';
  }

  // Lever, Workable and many custom forms put the question in a sibling element.
  function nearbyText(el) {
    let node = el;
    for (let depth = 0; depth < 4; depth++) {
      node = node.parentElement;
      if (!node || node.tagName === 'FORM' || node === document.body) return '';
      const candidate = node.querySelector(
        ':scope > label, :scope > legend, :scope > [class*="label" i], :scope > [class*="question" i], :scope > [class*="title" i], :scope > h3, :scope > h4, :scope > h5, :scope > p',
      );
      if (candidate && !candidate.contains(el)) {
        const t = labelText(candidate);
        if (t) return t;
      }
    }
    return '';
  }

  const humanize = (name) => (name ? name.replace(/[_\-[\]]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim() : '');

  function groupLabel(inputs) {
    const first = inputs[0];
    const fieldset = first.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      const t = labelText(legend) || fieldset.getAttribute('aria-label');
      if (t) return clean(t);
    }
    const group = first.closest('[role="radiogroup"], [role="group"]');
    if (group) {
      const ids = group.getAttribute('aria-labelledby');
      const t = ids ? labelText(group.ownerDocument.getElementById(ids.split(/\s+/)[0])) : group.getAttribute('aria-label');
      if (t) return clean(t);
    }
    // Nearest ancestor containing every option, then the question text inside it.
    let node = first.parentElement;
    while (node && !inputs.every((i) => node.contains(i))) node = node.parentElement;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      const t = nearbyText(node.querySelector('input') ?? node);
      if (t && !inputs.some((i) => optionLabel(i) === t)) return t;
    }
    return humanize(first.name);
  }

  function optionLabel(input) {
    const t = labelText(forLabel(input)) || labelText(input.closest('label'));
    return t || input.value;
  }

  const isRequired = (el, label) =>
    el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$|\(required\)/i.test(label);

  const PLACEHOLDER = /^(select|choose|please select|please choose|--|—|-)\b|^$/i;

  function choiceVisible(input) {
    return JA.visible(input) || JA.visible(forLabel(input)) || JA.visible(input.closest('label'));
  }

  /** Collect unanswered fields under root. Returns API-ready fields + handles to fill them. */
  JA.collectFields = (root) => {
    const fields = [];
    const handles = new Map();
    const seenGroups = new Set();
    const add = (field, handle) => {
      const id = `f${++seq}`;
      fields.push({ id, ...field, label: (field.label || '').slice(0, 500) });
      handles.set(id, handle);
    };

    const elements = [...root.querySelectorAll('input, select, textarea')].filter(
      (el) => !el.disabled && !el.readOnly && !SKIP_TYPES.has(el.type) && !el.closest('#job-autopilot-panel'),
    );

    for (const el of elements) {
      if (el.type === 'radio' || el.type === 'checkbox') {
        if (!choiceVisible(el)) continue;
        const scope = el.closest('fieldset, [role="radiogroup"], [role="group"]') ?? root;
        const siblings = el.name
          ? [...scope.querySelectorAll(`input[type="${el.type}"][name="${CSS.escape(el.name)}"]`)]
          : [el];
        const key = `${el.type}:${el.name || seq}:${siblings.length}`;
        if (seenGroups.has(key) && el.name) continue;
        seenGroups.add(key);

        if (el.type === 'radio' || siblings.length > 1) {
          if (siblings.some((s) => s.checked)) continue; // already answered
          const label = groupLabel(siblings);
          add(
            {
              label,
              type: el.type === 'radio' ? 'radio' : 'checkbox_group',
              options: siblings.map(optionLabel).slice(0, 300),
              required: siblings.some((s) => isRequired(s, label)) || /\*/.test(label),
            },
            { kind: el.type === 'radio' ? 'radio' : 'checkbox_group', els: siblings },
          );
        } else {
          if (el.checked) continue;
          const label = labelFor(el);
          add({ label, type: 'checkbox', required: isRequired(el, label) }, { kind: 'checkbox', el });
        }
        continue;
      }

      if (el.type === 'file') {
        if (el.files?.length) continue;
        const label = labelFor(el) || nearbyText(el.parentElement ?? el);
        add({ label, type: 'file', required: isRequired(el, label) }, { kind: 'file', el });
        continue;
      }

      if (!JA.visible(el)) continue;
      const label = labelFor(el);

      if (el instanceof HTMLSelectElement) {
        const selected = el.options[el.selectedIndex];
        if (selected && !PLACEHOLDER.test(selected.text.trim()) && el.selectedIndex !== -1 && selected.value !== '') continue;
        add(
          {
            label,
            type: 'select',
            options: [...el.options].map((o) => o.text.trim()).slice(0, 300),
            required: isRequired(el, label),
          },
          { kind: 'select', el },
        );
        continue;
      }

      if ((el.value ?? '').trim()) continue; // prefilled by the site
      const role = el.getAttribute('role');
      const type =
        role === 'combobox' || el.getAttribute('aria-autocomplete') === 'list'
          ? 'combobox'
          : el instanceof HTMLTextAreaElement
            ? 'textarea'
            : ['email', 'tel', 'number', 'url', 'date'].includes(el.type)
              ? el.type
              : 'text';
      const field = { label, type, required: isRequired(el, label), name: el.name || undefined };
      if (el.placeholder) field.placeholder = el.placeholder.slice(0, 500);
      if (el.maxLength > 0 && el.maxLength < 100_000) field.max_length = el.maxLength;
      add(field, { kind: type === 'combobox' ? 'combobox' : 'text', el });
    }
    return { fields, handles };
  };

  function clickChoice(input) {
    const label = forLabel(input);
    (label && JA.visible(label) ? label : input).click();
  }

  JA.attachFile = (input, { base64, filename, mime }) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], filename, { type: mime }));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.files.length > 0;
  };

  JA.fillCombobox = async (el, value) => {
    JA.setValue(el, value);
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: value.slice(-1) }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: value.slice(-1) }));
    const listId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    const want = value.toLowerCase();
    const option = await JA.waitFor(
      () => {
        const scope = (listId && el.ownerDocument.getElementById(listId)) || el.ownerDocument;
        const options = [...scope.querySelectorAll('[role="option"]')].filter(JA.visible);
        return options.find((o) => JA.text(o).toLowerCase().startsWith(want)) ?? options[0];
      },
      { timeout: 4000 },
    );
    if (option) {
      option.click();
      await JA.sleep(300);
      return true;
    }
    return Boolean(el.value);
  };

  async function fillOne(handle, value, resume) {
    switch (handle.kind) {
      case 'text':
        JA.setValue(handle.el, String(value));
        return true;
      case 'select': {
        const options = [...handle.el.options];
        const opt = options.find((o) => o.text.trim() === value) ?? options.find((o) => o.value === value);
        if (!opt) return false;
        JA.setValue(handle.el, opt.value);
        return true;
      }
      case 'radio': {
        const input = handle.els.find((r) => optionLabel(r) === value);
        if (!input) return false;
        clickChoice(input);
        return true;
      }
      case 'checkbox':
        if (handle.el.checked !== Boolean(value)) clickChoice(handle.el);
        return true;
      case 'checkbox_group':
        for (const cb of handle.els) {
          const want = value.includes(optionLabel(cb));
          if (cb.checked !== want) clickChoice(cb);
        }
        return true;
      case 'combobox':
        return JA.fillCombobox(handle.el, String(value));
      case 'file':
        return value === RESUME_TOKEN && resume ? JA.attachFile(handle.el, resume) : false;
      default:
        return false;
    }
  }

  JA.getResume = async () => {
    const res = await JA.send({ type: 'resume' });
    if (!res?.ok) throw new Error(res?.error || 'Could not load your resume');
    return res.data;
  };

  /**
   * Fill every unanswered field under root.
   * @returns {{fields:number, filled:number, llm:number, missing:Array<{label:string}>, unfilled:string[]}}
   */
  JA.autofill = async (root, job = {}) => {
    const { fields, handles } = JA.collectFields(root);
    if (!fields.length) return { fields: 0, filled: 0, llm: 0, missing: [], unfilled: [] };

    const payloadJob = { ...job, description: job.description?.slice(0, 60_000) };
    const res = await JA.api('POST', '/answers', { fields: fields.slice(0, 150), job: payloadJob });
    const resume = res.answers.some((a) => a.value === RESUME_TOKEN) ? await JA.getResume() : null;

    let filled = 0;
    const unfilled = [];
    for (const answer of res.answers) {
      const handle = handles.get(answer.id);
      const field = fields.find((f) => f.id === answer.id);
      if (answer.value === null || answer.value === undefined) {
        if (field?.required) unfilled.push(field.label);
        continue;
      }
      try {
        if (await fillOne(handle, answer.value, resume)) filled += 1;
        else if (field?.required) unfilled.push(field.label);
      } catch (error) {
        console.warn('[Job Autopilot] could not fill', field?.label, error);
        if (field?.required) unfilled.push(field.label);
      }
      await JA.sleep(120 + Math.random() * 250);
    }
    return { fields: fields.length, filled, llm: res.llm_count ?? 0, missing: res.missing ?? [], unfilled };
  };

  JA.visibleErrors = (root = document) =>
    [...root.querySelectorAll('[role="alert"], .artdeco-inline-feedback--error, .error, .field-error, .invalid-feedback, [class*="error-message" i]')]
      .filter(JA.visible)
      .map(JA.text)
      .filter(Boolean)
      .slice(0, 5);

  JA.highlightUnfilled = (root = document) => {
    for (const el of root.querySelectorAll('input[required], select[required], textarea[required], [aria-required="true"]')) {
      if (JA.visible(el) && !el.value) el.style.outline = '2px solid #d03b3b';
    }
  };
})();
