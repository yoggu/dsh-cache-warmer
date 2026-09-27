window.__ModuleLoader__.load({
  id: 'dsh-cache-warmer',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;

    const route = '/api/dsh-cache-warmer';
    const readTime = (value) => {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value !== 'string' || !value.trim()) return NaN;
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : Date.parse(value);
    };
    const finiteNumber = (value) => {
      if (value === null || value === undefined || value === '') return NaN;
      const number = Number(value);
      return Number.isFinite(number) ? number : NaN;
    };


    // Match the host Tooltip surface without importing private UI components.
    function PillTooltip({ anchor, text, visible, id }) {
      const ref = React.useRef(null);
      const [pos, setPos] = React.useState(null);
      React.useEffect(() => {
        if (!visible) { setPos(null); return; }
        const timer = setTimeout(() => {
          const a = anchor.current?.getBoundingClientRect();
          const tip = ref.current;
          if (a && tip) setPos({ left: Math.max(8, Math.min(a.left + a.width / 2 - tip.offsetWidth / 2, innerWidth - tip.offsetWidth - 8)), top: Math.max(8, a.top - tip.offsetHeight - 6) });
        }, 350);
        const hide = () => setPos(null);
        window.addEventListener('scroll', hide, true);
        window.addEventListener('resize', hide);
        const key = e => { if (e.key === 'Escape') hide(); };
        document.addEventListener('keydown', key);
        return () => { clearTimeout(timer); window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); document.removeEventListener('keydown', key); };
      }, [visible, text]);
      return visible ? createPortal(React.createElement('span', {ref, id, role:'tooltip', style:{
        position:'fixed', zIndex:1100, width:'max-content', maxWidth:'50vw', boxSizing:'border-box',
        padding:'3px 7px', borderRadius:'var(--dsw-radius-sm)', background:'var(--dsw-alias-tooltip-bg)',
        color:'var(--dsw-static-neutral-bluish-00)', fontFamily:'inherit', fontSize:13, lineHeight:'20px',
        whiteSpace:'pre-line', overflowWrap:'break-word', pointerEvents:'none',
        visibility:pos ? 'visible' : 'hidden', left:pos?.left ?? 0, top:pos?.top ?? 0,
      }}, text), document.body) : null;
    }

    function createLabels(locale) {
      const zh = String(locale || 'en').toLowerCase().startsWith('zh');
      return zh ? {
        unknownTtl: '缓存 —', ttl: '缓存有效期', remaining: '缓存约 ',
        toggle: '保持缓存活跃', status: '上下文缓存', phase: '阶段',
        reason: '说明', lastHit: '上次命中的缓存令牌', lastHitAt: '上次缓存命中', lastWarm: '上次保温请求',
        observationOnly: '仅供观察', unknown: '有效期尚未确认',
        inactive: '未启用', active: '活跃', idle: '空闲', running: '运行中',
        nextRefresh: '下次刷新', windowEnds: '窗口结束',
        unavailable: '状态不可用', loading: '加载中…',
        failed: '无法加载缓存状态', saveFailed: '无法保存设置',
        unsupported: '此模型线路尚不支持自动保温', expired: '已过期',
        minutes: '分钟', seconds: '秒', enabled: '已启用', disabled: '已停用',
        unverified: '尚未验证此线路的有界保温请求和实际缓存收益。',
        noStorage: '持久化设置不可用；已停止自动保温。', noConsent: '此会话尚未启用自动保温。',
        windowClosed: '已超出设定的活跃时间窗口。',
      } : {
        unknownTtl: 'Cache —', ttl: 'Cache TTL', remaining: 'Cache ~',
        toggle: 'Keep cache warm', status: 'Context cache', phase: 'Phase',
        reason: 'Note', lastHit: 'Last cached tokens', lastHitAt: 'Last cache hit', lastWarm: 'Last warm request',
        observationOnly: 'Observation only', unknown: 'No reliable TTL',
        inactive: 'Inactive', active: 'Active', idle: 'Idle', running: 'Running',
        nextRefresh: 'Next refresh', windowEnds: 'Window ends',
        unavailable: 'Status unavailable', loading: 'Loading …',
        failed: 'Could not load cache status', saveFailed: 'Could not save the setting',
        unsupported: 'Not supported for this route', expired: 'Expired',
        minutes: 'min', seconds: 's', enabled: 'Enabled', disabled: 'Disabled',
        unverified: 'A bounded warm request and real cache benefit have not yet been verified for this route.',
        noStorage: 'Durable preferences are unavailable; warming is disabled.',
        noConsent: 'Warming is not enabled for this session.', windowClosed: 'The configured activity window has ended.',
      };
    }

    function formatDuration(ms, labels) {
      const seconds = Math.max(0, Math.floor(ms / 1000));
      const minutes = Math.floor(seconds / 60);
      const rest = seconds % 60;
      if (minutes) return `${minutes} ${labels.minutes}${rest ? ` ${rest} ${labels.seconds}` : ''}`;
      return `${seconds} ${labels.seconds}`;
    }

    function formatTimestamp(value, locale) {
      const time = readTime(value);
      if (!Number.isFinite(time)) return null;
      try {
        return new Intl.DateTimeFormat(locale || undefined, {
          hour: '2-digit', minute: '2-digit',
        }).format(new Date(time));
      } catch {
        return new Date(time).toLocaleTimeString();
      }
    }

    function getLocale(ctx) {
      try {
        const value = ctx.locale && typeof ctx.locale.getLocale === 'function'
          ? ctx.locale.getLocale()
          : null;
        if (typeof value === 'string') return value;
        return value && (value.active || value.locale || value.language) || 'en';
      } catch {
        return 'en';
      }
    }

    function CachePill({ sessionId, ctx }) {
      const [status, setStatus] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState('');
      const [open, setOpen] = React.useState(false);
      const [hover, setHover] = React.useState(false);
      const tipId = React.useId();
      const triggerRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const [panelPos, setPanelPos] = React.useState(null);
      const [now, setNow] = React.useState(Date.now());
      const [locale, setLocale] = React.useState(() => getLocale(ctx));
      const labels = createLabels(locale);

      React.useEffect(() => {
        const localeApi = ctx.locale;
        if (!localeApi || typeof localeApi.subscribe !== 'function') return undefined;
        const updateLocale = () => setLocale(getLocale(ctx));
        try {
          const unsubscribe = localeApi.subscribe(updateLocale);
          return typeof unsubscribe === 'function' ? unsubscribe : undefined;
        } catch {
          return undefined;
        }
      }, []);

      React.useEffect(() => {
        if (!sessionId) {
          setStatus(null);
          setLoading(false);
          return undefined;
        }
        let alive = true;
        let inFlight = false;
        let controller;
        const refresh = async () => {
          if (inFlight) return;
          inFlight = true;
          controller = new AbortController();
          try {
            const response = await fetch(`${route}?sessionId=${encodeURIComponent(sessionId)}`, {
              method: 'GET',
              credentials: 'include',
              headers: { Accept: 'application/json' },
              signal: controller.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            if (alive) {
              setStatus(payload && typeof payload === 'object' ? payload : null);
              setError('');
            }
          } catch (cause) {
            if (alive && cause.name !== 'AbortError') setError('load');
          } finally {
            inFlight = false;
            if (alive) setLoading(false);
          }
        };
        setLoading(true);
        refresh();
        const poll = setInterval(refresh, 15000);
        return () => {
          alive = false;
          clearInterval(poll);
          if (controller) controller.abort();
        };
      }, [sessionId]);

      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, []);
      React.useEffect(() => {
        if (!open) { setPanelPos(null); return undefined; }
        const place = () => {
          const trigger = triggerRef.current;
          const panel = panelRef.current;
          if (!trigger || !panel) return;
          const anchor = trigger.getBoundingClientRect();
          const width = panel.offsetWidth;
          const height = panel.offsetHeight;
          const margin = 12;
          const left = Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin));
          const above = anchor.top - height - 8;
          const top = above >= margin ? above : Math.min(window.innerHeight - height - margin, anchor.bottom + 8);
          setPanelPos({ left, top: Math.max(margin, top) });
        };
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopImmediatePropagation();
          setOpen(false);
          triggerRef.current?.querySelector('button')?.focus();
        };
        const onPointerDown = (event) => {
          if (!triggerRef.current?.contains(event.target) && !panelRef.current?.contains(event.target)) setOpen(false);
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        const observer = new ResizeObserver(place);
        observer.observe(panelRef.current);
        observer.observe(triggerRef.current);
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('pointerdown', onPointerDown);
        return () => {
          window.removeEventListener('resize', place);
          window.removeEventListener('scroll', place, true);
          observer.disconnect();
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('pointerdown', onPointerDown);
        };
      }, [open]);

      const enabled = Boolean(status && status.enabled);
      const supported = Boolean(status && status.supported);
      const ttlMs = finiteNumber(status && status.cacheTtlMs);
      const expiresAt = readTime(status && status.cacheExpiresAt);
      const hasTtl = Number.isFinite(ttlMs) && ttlMs > 0;
      const hasExpiry = hasTtl && Number.isFinite(expiresAt);
      const remainingMs = hasExpiry ? Math.max(0, expiresAt - now) : NaN;
      const ringRatio = hasExpiry ? Math.max(0, Math.min(1, remainingMs / ttlMs)) : 0;
      const pillText = hasExpiry
        ? `${labels.remaining}${formatDuration(remainingMs, labels)}`
        : labels.unknownTtl;

      const requestEnabled = async (nextEnabled) => {
        if (!sessionId || !supported || saving) return;
        setSaving(true);
        setError('');
        try {
          const response = await fetch(route, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ sessionId, enabled: nextEnabled }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json().catch(() => null);
          if (payload && typeof payload === 'object') setStatus(payload);
          else setStatus((previous) => ({ ...(previous || {}), enabled: nextEnabled }));
        } catch {
          setError('save');
        } finally {
          setSaving(false);
        }
      };

      const textStyle = { color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums' };
      const mutedStyle = { color: 'var(--dsw-alias-label-tertiary)' };
      const pillStyle = {
        boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', gap: 6,
        maxWidth: '100%', padding: '1px var(--dsh-cache-pill-inline, 8px)', border: 0, borderRadius: 999,
        background: 'transparent', color: 'var(--dsw-alias-label-tertiary)',
        fontFamily: 'inherit', fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
        fontVariantNumeric: 'tabular-nums', lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
        cursor: 'pointer', whiteSpace: 'nowrap',
      };
      const popoverStyle = {
        position: 'fixed', zIndex: 1100, left: panelPos?.left ?? 0, top: panelPos?.top ?? 0,
        visibility: panelPos ? 'visible' : 'hidden',
        width: 'min(320px, calc(100vw - 24px))', maxHeight: 'calc(100vh - 24px)',
        overflowY: 'auto', boxSizing: 'border-box', padding: 16,
        border: 0, borderRadius: 'var(--dsw-radius-lg, 12px)',
        background: 'var(--dsw-specific-menu)',
        backdropFilter: 'var(--dsw-menu-backdrop-filter)',
        '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
        boxShadow: 'var(--dsw-elevation-prominent)',
        color: 'var(--dsw-alias-label-secondary)', cursor: 'default',
        fontFamily: 'inherit', fontSize: 12, lineHeight: '18px',
      };
      const rowStyle = {
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        gap: 16, paddingTop: 6,
      };
      const timeLabel = (name, value) => {
        const formatted = formatTimestamp(value, locale);
        return formatted ? h('div', { key: name, style: rowStyle },
          h('span', { style: mutedStyle }, name), h('span', { style: textStyle }, formatted)) : null;
      };
      const phase = status && status.phase;
      const stateLabel = status && status.status;
      const phaseLabel = labels[phase] || phase;
      const stateText = labels[stateLabel] || stateLabel;
      const hitTokens = finiteNumber(status && status.lastCacheHitTokens);
      const reason = status && typeof status.reason === 'string' ? status.reason : '';
      const routeReason = status?.reasonCode === 'codex-unbounded'
        ? (locale.startsWith('zh') ? 'Codex 传输无法限制输出，自动保温不可用。提供商不报告缓存到期时间。' : 'Codex does not enforce an output limit, so automatic warming is unavailable. The provider does not report cache expiry.')
        : labels.unverified;
      const reasonText = !supported ? routeReason
        : reason.includes('Durable preferences') ? labels.noStorage
        : reason.includes('not enabled') ? labels.noConsent
        : reason.includes('window has ended') ? labels.windowClosed : reason;
      const errorText = error === 'save' ? labels.saveFailed : error === 'load' ? labels.failed : '';
      const showRing = hasExpiry;

      return h('span', {
        ref: triggerRef, className: 'dsh-cache-warmer-anchor',
        style: { position: 'relative', display: 'inline-flex', minWidth: 0, verticalAlign: 'middle' },
      },
        h('button', {
          type: 'button', style: { ...pillStyle,
            ...(open || hover ? {
              background: 'var(--dsw-alias-interactive-bg-hover)',
              color: 'var(--dsw-alias-label-tertiary)',
            } : {}),
          },
          onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false),
          onFocus: () => setHover(true), onBlur: () => setHover(false),
          'aria-describedby': hover && !open ? tipId : undefined,
          onClick: () => setOpen((value) => !value),
          'aria-expanded': open, 'aria-haspopup': 'dialog',
          'aria-label': pillText,
        },
          showRing ? h('svg', {
            width: 15, height: 15, viewBox: '0 0 20 20', 'aria-hidden': true,
            style: { flex: '0 0 auto', display: 'block' },
          },
            h('circle', {
              cx: 10, cy: 10, r: 8, fill: 'none', stroke: 'var(--dsw-alias-label-tertiary)',
              strokeOpacity: 0.35, strokeWidth: 2,
            }),
            h('circle', {
              cx: 10, cy: 10, r: 8, fill: 'none', stroke: 'var(--dsw-alias-label-tertiary)',
              strokeWidth: 2, strokeLinecap: 'round', strokeDasharray: 50.27,
              strokeDashoffset: 50.27 * (1 - ringRatio), transform: 'rotate(-90 10 10)',
            })) : h('svg', { width: 14, height: 14, viewBox: '0 0 20 20', 'aria-hidden': true,
            style: { display: 'block', flex: '0 0 auto' } },
            h('circle', { cx: 10, cy: 10, r: 8, fill: 'none', stroke: 'currentColor',
              strokeOpacity: 0.65, strokeWidth: 2 })), 
          h('span', { className: 'dsh-cache-warmer-label', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, pillText)),
        h(PillTooltip, {anchor:triggerRef, text:hasExpiry ? pillText : (locale.startsWith('zh') ? '缓存有效期未知' : 'Cache lifetime unknown'), visible:hover && !open, id:tipId}),
        open && createPortal(h('div', { className: 'dsh-cache-warmer-panel', ref: panelRef, role: 'dialog', 'aria-label': labels.status, style: popoverStyle },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            marginBottom: 8, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' } },
            h('span', null, labels.status),
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 400 } },
              loading ? labels.loading : !supported ? labels.observationOnly : stateText || labels.unavailable)),
          h('div', { 'aria-hidden': true, style: { borderTop: '.5px solid var(--dsw-alias-border-l2)', marginBottom: 10 } }),
          h('div', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, hasExpiry ? `${labels.ttl}: ${formatDuration(remainingMs, labels)}` : labels.unknown),
          h('label', {
            style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, cursor: supported ? 'pointer' : 'not-allowed' },
          },
            h('input', {
              className: 'dsh-cache-warmer-check', type: 'checkbox', checked: enabled,
              disabled: !supported || saving || !sessionId,
              onChange: (event) => requestEnabled(event.target.checked),
              style: { accentColor: 'var(--dsw-alias-brand-primary)' },
            }),
            h('span', { style: textStyle }, labels.toggle)),
          !supported && h('div', { style: { ...mutedStyle, paddingTop: 8, overflowWrap: 'anywhere' } },
            routeReason),
          supported && phase != null && h('div', { style: rowStyle },
            h('span', { style: mutedStyle }, labels.phase), h('span', { style: textStyle }, phaseLabel)),
          Number.isFinite(hitTokens) && h('div', { style: rowStyle },
            h('span', { style: mutedStyle }, labels.lastHit), h('span', { style: textStyle }, hitTokens.toLocaleString(locale))),
          timeLabel(labels.lastHitAt, status && status.lastCacheHitAt),
          timeLabel(labels.lastWarm, status && status.lastWarmAt),
          timeLabel(labels.nextRefresh, status && status.nextRefreshAt),
          timeLabel(labels.windowEnds, status && status.windowEndsAt),
          reason && supported && h('div', { style: { ...mutedStyle, paddingTop: 8, overflowWrap: 'anywhere' } },
            h('span', { style: textStyle }, `${labels.reason}: `), reasonText),
          errorText && h('div', {
            role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', paddingTop: 8 },
          }, errorText),
        ), document.body));
    }

    function SettingsPage({ ctx, embedded = false }) {
      const [values, setValues] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [locale, setLocale] = React.useState(() => getLocale(ctx));
      const zh = locale.toLowerCase().startsWith('zh');
      const settingsText = zh ? {
        title: '上下文缓存', description: 'OpenRouter 保温需主动启用并会产生费用；每个请求前缀最多刷新三次。发生错误、缓存未命中或上下文超出预算时停止。预算按未缓存输入保守预留，不是账单保证。刷新间隔不是缓存有效期。Codex 传输不支持输出上限，因此不可自动保温。阶段设为 0 可停用。',
        defaultEnabled: '默认保持新对话的缓存活跃', active: '运行期间（分钟）', idle: '运行结束后（分钟）', refresh: '刷新间隔（分钟）', budget: '每个请求前缀的保温预算（美元）',
        loadError: '无法加载设置。', saveError: '保存失败。', save: '保存', saving: '保存中…', loading: '加载中…',
      } : {
        title: 'Context cache', description: 'Opt-in, billable OpenRouter warming: at most three bounded refreshes per request prefix. Stops on errors, cache misses or oversized context. The budget reserves uncached input conservatively, not an invoice guarantee. Refresh interval is not cache TTL. Codex warming is unavailable because its transport does not enforce an output limit. Set a phase to 0 to disable it.',
        defaultEnabled: 'Keep new chats warm by default', active: 'During an active run (minutes)', idle: 'After a run ends (minutes)', refresh: 'Refresh interval (minutes)', budget: 'Warming budget per request prefix (USD)',
        loadError: 'Could not load settings.', saveError: 'Save failed.', save: 'Save', saving: 'Saving …', loading: 'Loading …',
      };
      React.useEffect(() => {
        let active = true;
        fetch(`${route}?scope=settings`, { credentials: 'include' })
          .then(response => { if (!response.ok) throw new Error('settings'); return response.json(); })
          .then(value => { if (active) { setValues(value); setDraft(value); } })
          .catch(() => { if (active) setError('load'); });
        return () => { active = false; };
      }, []);
      React.useEffect(() => {
        const api = ctx.locale;
        if (!api || typeof api.subscribe !== 'function') return undefined;
        return api.subscribe(() => setLocale(getLocale(ctx)));
      }, []);
      const set = (name, value) => setDraft(previous => ({ ...previous, [name]: value }));
      const save = async () => {
        if (!draft || busy) return;
        setBusy(true); setError('');
        try {
          const response = await fetch(route, { method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'settings', ...draft }) });
          if (!response.ok) throw new Error('save');
          const result = await response.json();
          setDraft(result); setValues(result);
        } catch { setError('save'); }
        finally { setBusy(false); }
      };
      const field = (key, title, min = 0, max = 1440, step = 1) => h('label', { className: 'dsh-cache-settings-row' },
        h('span', { className: 'dsh-cache-settings-label' }, title), h('input', { type: 'number', min, max, step,
          className: 'dsh-cache-settings-input', disabled: busy,
          value: draft[key], onChange: event => set(key, event.target.value === '' ? '' : Number(event.target.value)),
        }));
      const valid = draft && Number.isInteger(draft.activeMinutes) && draft.activeMinutes >= 0 && draft.activeMinutes <= 1440
        && Number.isInteger(draft.idleMinutes) && draft.idleMinutes >= 0 && draft.idleMinutes <= 1440
        && Number.isInteger(draft.refreshMinutes) && draft.refreshMinutes >= 1 && draft.refreshMinutes <= 60
        && typeof draft.maxBudgetUsd === 'number' && draft.maxBudgetUsd >= .05 && draft.maxBudgetUsd <= 10;
      return h('section', { className: 'dsh-cache-settings', style: { padding: embedded ? '0' : '20px 24px' } },
        !embedded && h('h2', null, settingsText.title),
        h('p', { className: 'dsh-cache-settings-description' }, settingsText.description),
        draft ? h(React.Fragment, null,
          h('label', { className: 'dsh-cache-settings-row' },
            h('span', { className: 'dsh-cache-settings-label' }, settingsText.defaultEnabled),
            h('button', { type: 'button', role: 'switch', className: 'dsh-cache-settings-switch',
              'aria-checked': draft.autoWarmNewChats, 'aria-label': settingsText.defaultEnabled, disabled: busy,
              onClick: () => set('autoWarmNewChats', !draft.autoWarmNewChats) },
              h('span', { className: 'dsh-cache-settings-thumb', 'aria-hidden': true }))),
          field('activeMinutes', settingsText.active),
          field('idleMinutes', settingsText.idle),
          field('refreshMinutes', settingsText.refresh, 1, 60),
          field('maxBudgetUsd', settingsText.budget, .05, 10, .05),
          h('div', { className: 'dsh-cache-settings-footer' },
            h('button', { type: 'button', className: 'dsh-cache-settings-save',
              disabled: busy || !valid || JSON.stringify(values) === JSON.stringify(draft), onClick: save },
              busy ? settingsText.saving : settingsText.save),
            error && h('span', { role: 'alert', className: 'dsh-cache-settings-error' }, settingsText.saveError)))
          : h('p', { className: 'dsh-cache-settings-description' }, error ? settingsText.loadError : settingsText.loading));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        function BoundCachePill(props) {
          return h(CachePill, { ...props, ctx, key: props.sessionId });
        }
        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = 'dsh-cache-warmer-ui';
          style.textContent = `
.dsh-cache-settings{box-sizing:border-box;width:100%;max-width:640px;font-family:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsh-cache-settings h2{margin:0 0 8px;font:inherit;font-size:20px;line-height:28px;font-weight:500}
.dsh-cache-settings-description{margin:0 0 12px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}
.dsh-cache-settings-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;min-width:0}
.dsh-cache-settings-row+.dsh-cache-settings-row{border-top:.5px solid var(--dsw-alias-border-l2)}
.dsh-cache-settings-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5}
.dsh-cache-settings-input{box-sizing:border-box;width:88px;flex:none;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsh-cache-settings-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dsh-cache-settings-footer{display:flex;align-items:center;gap:8px;padding-top:16px}
.dsh-cache-settings-save{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsh-cache-settings-save:disabled{opacity:.4;cursor:default}
.dsh-cache-settings-save:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsh-cache-settings-error{font-size:12px;color:var(--dsw-alias-state-error-primary)}
.dsh-cache-settings-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer}
.dsh-cache-settings-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.dsh-cache-settings-switch:disabled{cursor:default;opacity:.5}
.dsh-cache-settings-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-cache-settings-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}
.dsh-cache-settings-switch[aria-checked=true] .dsh-cache-settings-thumb{transform:translateX(16px)}
@media(prefers-reduced-motion:reduce){.dsh-cache-settings-thumb{transition:none}}

.dsh-cache-warmer-check{appearance:none;box-sizing:border-box;display:inline-grid;place-content:center;width:14px;height:14px;flex:none;margin:0;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:transparent;color:var(--dsw-alias-bg-base);cursor:inherit}
.dsh-cache-warmer-check:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dsh-cache-warmer-check:checked::after{content:'';width:6px;height:3px;border-left:2px solid currentColor;border-bottom:2px solid currentColor;transform:translateY(-1px) rotate(-45deg)}
.dsh-cache-warmer-check:disabled{background:var(--dsw-alias-interactive-bg-hover);opacity:.5}
.dsh-cache-warmer-check:focus-visible,.dsh-cache-warmer-anchor button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
@media (max-width:720px){.dsh-cache-warmer-anchor{--dsh-cache-pill-inline:4px}}
`;
          document.head.appendChild(style);
          return () => style.remove();
        });
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'cache-warmer', order: 5,
        }, BoundCachePill));
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: 'dsh-cache-warmer',
        }, props => props.view === 'summary' ? null : h(SettingsPage, { ctx, embedded: true })));
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'context-cache', order: 18,
          label: () => getLocale(ctx).toLowerCase().startsWith('zh') ? '上下文缓存' : 'Context cache',
        }, () => h(SettingsPage, { ctx })));
      },
    };
  },
});
