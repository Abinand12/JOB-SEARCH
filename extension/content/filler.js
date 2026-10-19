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

  // Lookups go through the element's own root so they also work inside shadow roots.
  const rootOf = (el) => el.getRootNode?.() ?? el.ownerDocument;
  const byId = (el, id) => (id ? rootOf(el).getElementById?.(id) ?? el.ownerDocument.getElementById(id) : null);

  function forLabel(el) {
    if (!el.id) return null;
    return rootOf(el).querySelector(`label[for="${CSS.escape(el.id)}"]`);
  }

  // LinkedIn's new Easy Apply wraps each choice in [role=radio]/[role=checkbox] with
  // an empty <label> and the option text in a <p>; state lives in aria-checked.
  const choiceWrapper = (input) => input.closest('[role="radio"], [role="checkbox"], [role="option"], [role="switch"]');
  const isChecked = (input) => {
    const wrap = choiceWrapper(input);
    if (wrap?.hasAttribute('aria-checked')) return wrap.getAttribute('aria-checked') === 'true';
    return input.checked;
  };

  function labelFor(el) {
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const t = ids
        .split(/\s+/)
        .map((id) => labelText(byId(el, id)))
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

  // Returns the question text, unstripped, so a trailing "*" can mark it required.
  function groupLabelRaw(inputs) {
    const first = inputs[0];
    const fieldset = first.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      const t = (legend ? JA.text(legend) : '') || fieldset.getAttribute('aria-label');
      if (t) return t;
    }
    const group = first.closest('[role="radiogroup"], [role="group"], fieldset');
    if (group) {
      const ids = group.getAttribute('aria-labelledby');
      const t = ids ? JA.text(byId(group, ids.split(/\s+/)[0])) : group.getAttribute('aria-label');
      if (t) return t;
      // New LinkedIn: the question is a <p> right before the group.
      const prev = group.previousElementSibling;
      if (prev && !prev.querySelector('input, select, textarea')) {
        const pt = JA.text(prev);
        if (pt) return pt;
      }
    }
    // ...or the aria-label every option wrapper carries.
    const wrapLabel = choiceWrapper(first)?.getAttribute('aria-label');
    if (wrapLabel && !inputs.some((i) => optionLabel(i) === wrapLabel.trim())) return wrapLabel;
    return groupLabelFallback(inputs);
  }

  function groupLabel(inputs) {
    return clean(groupLabelRaw(inputs));
  }

  function groupLabelFallback(inputs) {
    const first = inputs[0];
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
    if (t) return t;
    const wrap = choiceWrapper(input);
    if (wrap) {
      const wt = labelText(wrap);
      if (wt) return wt;
    }
    return input.value && input.value !== 'on' ? input.value : input.getAttribute('aria-label') || '';
  }

  const isRequired = (el, label) =>
    el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$|\(required\)/i.test(label);

  const PLACEHOLDER = /^(select|choose|please select|please choose|--|—|-)\b|^$/i;

  function choiceVisible(input) {
    return JA.visible(input) || JA.visible(forLabel(input)) || JA.visible(input.closest('label')) || JA.visible(choiceWrapper(input));
  }

  // Character limit shown as "0 of 20 characters" next to LinkedIn's new inputs.
  function helperMaxLength(el) {
    for (const id of (el.getAttribute('aria-describedby') ?? '').split(/\s+/)) {
      const m = JA.text(byId(el, id)).match(/of (\d+) characters/i);
      if (m) return Number(m[1]);
    }
    return null;
  }

  const RESUME_FILE = /\.(pdf|docx?|rtf|txt)\b/i;

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
          if (siblings.some(isChecked)) continue; // already answered
          const options = siblings.map(optionLabel);
          // LinkedIn's resume picker: keep the selected resume, or pick the most recent.
          if (el.type === 'radio' && options.length && options.every((o) => RESUME_FILE.test(o))) {
            clickChoice(siblings[0]);
            continue;
          }
          const raw = groupLabelRaw(siblings);
          const label = clean(raw);
          add(
            {
              label,
              type: el.type === 'radio' ? 'radio' : 'checkbox_group',
              options: options.slice(0, 300),
              required: siblings.some((s) => isRequired(s, raw)) || /\*\s*$/.test(raw),
            },
            { kind: el.type === 'radio' ? 'radio' : 'checkbox_group', els: siblings },
          );
        } else {
          if (isChecked(el)) continue;
          const label = labelFor(el) || labelText(choiceWrapper(el)) || clean(choiceWrapper(el)?.getAttribute('aria-label'));
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
      const maxLength = el.maxLength > 0 && el.maxLength < 100_000 ? el.maxLength : helperMaxLength(el);
      if (maxLength) field.max_length = maxLength;
      add(field, { kind: type === 'combobox' ? 'combobox' : 'text', el });
    }
    return { fields, handles };
  };

  function clickChoice(input) {
    const before = isChecked(input);
    const wrap = choiceWrapper(input);
    const label = forLabel(input);
    const target = wrap && JA.visible(wrap) ? wrap : label && JA.visible(label) && labelText(label) ? label : input;
    target.click();
    // React can swallow a click on the wrapper; fall back to the input itself.
    if (isChecked(input) === before && target !== input && input.isConnected) input.click();
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
        const scope = (listId && byId(el, listId)) || rootOf(el);
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
        if (isChecked(handle.el) !== Boolean(value)) clickChoice(handle.el);
        return true;
      case 'checkbox_group':
        for (const cb of handle.els) {
          const want = value.includes(optionLabel(cb));
          if (isChecked(cb) !== want) clickChoice(cb);
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
    [
      ...root.querySelectorAll(
        '[role="alert"], .artdeco-inline-feedback--error, .error, .field-error, .invalid-feedback, [class*="error-message" i], [id^="error-message-"], [data-testid="text-input-helper-text"] p:not([aria-live])',
      ),
    ]
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
