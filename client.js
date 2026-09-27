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
        unknownTtl: '缓存时间 —', ttl: '预计剩余缓存时间', remaining: '缓存时间 ~',
        toggle: '保持缓存活跃', status: '上下文缓存', phase: '阶段',
        reason: '说明', lastHit: '上次命中的缓存令牌', lastHitAt: '上次缓存命中', lastWarm: '上次保温请求',
        observationOnly: '仅供观察', unknown: '有效期尚未确认',
        inactive: '未启用', active: '活跃', idle: '空闲', running: '运行中',
        nextRefresh: '下次保温评估', windowEnds: '保温窗口结束',
        unavailable: '状态不可用', loading: '加载中…',
        failed: '无法加载缓存状态', saveFailed: '无法保存设置',
        unsupported: '此模型线路尚不支持自动保温', expired: '已过期',
        minutes: '分钟', seconds: '秒', enabled: '已启用', disabled: '已停用',
        unverified: '尚未验证此线路的有界保温请求和实际缓存收益。',
        noStorage: '持久化设置不可用；已停止自动保温。', noConsent: '此会话尚未启用自动保温。',
        windowClosed: '已超出设定的活跃时间窗口。',
      } : {
        unknownTtl: 'Cache time —', ttl: 'Estimated cache time remaining', remaining: 'Cache time ~',
        toggle: 'Keep cache warm', status: 'Context cache', phase: 'Phase',
        reason: 'Note', lastHit: 'Last cached tokens', lastHitAt: 'Last cache hit', lastWarm: 'Last warm request',
        observationOnly: 'Observation only', unknown: 'No reliable TTL',
        inactive: 'Inactive', active: 'Active', idle: 'Idle', running: 'Running',
        nextRefresh: 'Next warming decision', windowEnds: 'Warming window ends',
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
        ? `${labels.remaining}${Math.ceil(remainingMs / 60000)}${locale.startsWith('zh') ? '分钟' : 'm'}`
        : labels.unknownTtl;

      const requestEnabled = async (nextEnabled) => {
        if (!sessionId || (nextEnabled && !supported) || saving) return;
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
      const zh = locale.startsWith('zh');
      const reasonTexts = zh ? {
        unsupported: '此线路暂无兼容的保温传输。', 'unknown-lifetime': '此模型未配置缓存有效期；仅供观察。',
        'policy-disabled': '此模型的缓存策略已禁止保温。', 'retention-disabled': '此线路已停用提示缓存保留。',
        'unknown-pricing': '模型价格未知，跳过自动保温。', 'no-cache-evidence': '等待实际请求报告缓存命中。',
        'no-context': '等待新的已完成请求，以获取当前上下文。', disabled: '此会话尚未启用自动保温。',
        'request-in-flight': '实际请求正在进行中；保温将等待请求完成。',
        'request-identity-unavailable': '无法解析当前 Harness 的请求标识；已停用自动保温。',
        'window-ended': '距上次实际请求的保温窗口已结束。', 'insufficient-savings': '预计收益低于 0.05 美元，跳过刷新。',
        'cache-elapsed': '预计缓存有效期已过；等待实际请求。', stopped: '因错误、未命中、取消或上下文变化而停止。',
        'no-storage': '持久化设置或费用记录不可用，已停止保温。',
      } : {};
      const routeReason = reasonTexts[status?.reasonCode] || reason || labels.unsupported;
      const reasonText = reasonTexts[status?.reasonCode] || reason;
      const elapsedText = zh ? '预计有效期已过（不代表缓存已删除）' : 'Estimated lifetime elapsed (not confirmed eviction)';
      const tooltipText = hasExpiry ? (remainingMs > 0 ? labels.ttl : elapsedText)
        : (zh ? '缓存有效期未知' : 'Cache lifetime unknown');
      const money = value => Number.isFinite(value) ? `${value < 0 ? '−' : ''}$${Math.abs(value).toFixed(3)}` : '—';
      const metric = (name, value) => h('div', { key: name, style: rowStyle },
        h('span', { style: mutedStyle }, name), h('span', { style: textStyle }, value));
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
        h(PillTooltip, {anchor:triggerRef, text:tooltipText, visible:hover && !open, id:tipId}),
        open && createPortal(h('div', { className: 'dsh-cache-warmer-panel', ref: panelRef, role: 'dialog', 'aria-label': labels.status, style: popoverStyle },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            marginBottom: 8, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' } },
            h('span', null, labels.status),
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 400 } },
              loading ? labels.loading : !supported ? labels.observationOnly : stateText || labels.unavailable)),
          h('div', { 'aria-hidden': true, style: { borderTop: '.5px solid var(--dsw-alias-border-l2)', marginBottom: 10 } }),
          h('div', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, hasExpiry ? (remainingMs > 0 ? `${labels.ttl}: ${Math.ceil(remainingMs / 60000)} ${labels.minutes}` : elapsedText) : labels.unknown),
          h('label', {
            style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, cursor: supported ? 'pointer' : 'not-allowed' },
          },
            h('input', {
              className: 'dsh-cache-warmer-check', type: 'checkbox', checked: enabled,
              disabled: (!supported && !enabled) || saving || !sessionId,
              onChange: (event) => requestEnabled(event.target.checked),
              style: { accentColor: 'var(--dsw-alias-brand-primary)' },
            }),
            h('span', { style: textStyle }, labels.toggle)),
          !supported && h('div', { style: { ...mutedStyle, paddingTop: 8, overflowWrap: 'anywhere' } },
            routeReason),
          supported && phase != null && h('div', { style: rowStyle },
            h('span', { style: mutedStyle }, labels.phase), h('span', { style: textStyle }, phaseLabel)),
          status?.ruleSource && h('div', { style: { ...mutedStyle, paddingTop: 8 } },
            status.ruleSource === 'custom' ? (zh ? '自定义有效期假设' : 'Custom lifetime assumption')
              : status.ruleSource === 'codex-default' ? (zh ? 'Codex 默认估计' : 'Codex estimated default')
              : (zh ? '有效期未知' : 'Lifetime unknown')),
          Number.isFinite(hitTokens) && h('div', { style: rowStyle },
            h('span', { style: mutedStyle }, labels.lastHit), h('span', { style: textStyle }, hitTokens.toLocaleString(locale))),
          timeLabel(labels.lastHitAt, status && status.lastCacheHitAt),
          timeLabel(labels.lastWarm, status && status.lastWarmAt),
          timeLabel(labels.nextRefresh, status && status.nextRefreshAt),
          timeLabel(labels.windowEnds, status && status.windowEndsAt),
          status?.decision && h(React.Fragment, null,
            metric(zh ? '预计刷新费用' : 'Estimated refresh cost', money(status.decision.refreshCostUsd)),
            metric(zh ? '预计净收益' : 'Expected net benefit', money(status.decision.expectedSavingsUsd)),
            metric(zh ? '继续对话概率' : 'Continuation probability', `${Math.round(status.decision.probability * 100)}%`)),
          status?.warmUsage && h(React.Fragment, null,
            metric(zh ? '保温请求次数' : 'Warm requests', String(status.warmUsage.attempts)),
            metric(zh ? '保温费用估计' : 'Warm usage estimate', `${money(status.warmUsage.usd)}${status.warmUsage.unpriced ? (zh ? ' · 部分' : ' · partial') : ''}`)),
          status?.decision?.subscription && h('div', { style: { ...mutedStyle, paddingTop: 8 } },
            zh ? '按 API 等价价格估计，并非订阅配额。保温会消耗用量；Codex 不保证输出令牌上限。'
              : 'API-equivalent estimate, not subscription allowance. Warming consumes usage; Codex has no guaranteed output cap.'),
          reason && supported && h('div', { style: { ...mutedStyle, paddingTop: 8, overflowWrap: 'anywhere' } },
            h('span', { style: textStyle }, `${labels.reason}: `), reasonText),
          errorText && h('div', {
            role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', paddingTop: 8 },
          }, errorText),
        ), document.body));
    }

    function SettingsPage({ ctx }) {
      const [values, setValues] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [settingsRequest, setSettingsRequest] = React.useState(0);
      const [catalog, setCatalog] = React.useState({ providers: [] });
      const [modelsLoading, setModelsLoading] = React.useState(true);
      const [modelsRequest, setModelsRequest] = React.useState(0);
      const [search, setSearch] = React.useState('');
      const [providerFilter, setProviderFilter] = React.useState('');
      const [limit, setLimit] = React.useState(25);
      const [locale, setLocale] = React.useState(() => getLocale(ctx));
      const zh = locale.toLowerCase().startsWith('zh');
      const helpId = React.useId();
      // Catalog metadata never enters the editable settings or a POST body.
      const editable = value => ({ autoWarmNewChats: value.autoWarmNewChats, activeMinutes: value.activeMinutes,
        idleMinutes: value.idleMinutes, useCodexDefaults: value.useCodexDefaults !== false,
        modelPolicies: (value.modelPolicies || []).map(row => ({ provider: row.provider, model: row.model,
          enabled: row.enabled, cacheMinutes: row.cacheMinutes })) });
      const t = zh ? {
        description: '保温通过小型后台请求尝试维持已有的提示词缓存。会产生 API 费用或消耗订阅用量；仅在预计节省的费用超过保温成本时发送。',
        defaultEnabled: '默认保持新对话的缓存活跃', active: '运行中保温窗口（分钟）', idle: '空闲时保温窗口（分钟）',
        defaultHelp: '为新建的普通对话自动开启“保持缓存活跃”。不会改变已有对话或子智能体对话；每个对话仍可单独关闭。模型的保温开关也必须开启。',
        activeHelp: '智能体运行时，允许保温至上次实际模型请求后的指定分钟数。设为 0 可停用运行中保温。',
        idleHelp: '智能体空闲时，允许保温至上次实际模型请求后的指定分钟数，并非从运行结束时重新计时。设为 0 可停用空闲保温。',
        windowHelp: '这是允许保温的时间范围，不是刷新间隔或缓存有效期。实际刷新时间由下方模型的有效期估计决定；保温请求不会延长窗口。',
        windowExample: '例如：空闲窗口为 30 分钟，上次实际请求在 14:00，则保温最迟于 14:30 停止；即使运行在 14:10 才结束，也不会延后。',
        loadError: '无法加载设置。', saveError: '保存失败；未保存的修改已保留。', save: '保存', saving: '保存中…', loading: '加载中…',
        models: '模型缓存策略', search: '搜索模型或提供商', provider: '提供商', all: '所有提供商', refresh: '刷新模型', retry: '重试', more: '加载更多',
        modelError: '无法发现此提供商的模型。已保留自定义规则。', timeout: '此提供商的模型发现超时。已保留自定义规则。',
        providerError: '无法发现提供商。已保留自定义规则，可重试。', empty: '没有匹配的模型。', unavailable: '目录中不可用',
        allow: '允许保温', lifetime: '预计缓存有效期（分钟）', unknown: '未知', custom: '自定义', estimated: 'Codex 默认估计',
        blank: '空白 — 不会自动保温', disabled: '已停用（保留有效期）', legacy: '旧设置停用了默认估计', reset: '恢复默认', remove: '移除规则',
        assumption: '已知的 Codex 默认估计会自动使用。有效期只是本地调度假设，不会设置提供商的 TTL。空白会阻止自动保温；开关可暂时停用并保留有效期。',
        discovery: '模型来自 Harness 配置的提供商。目录并不验证凭据或实际缓存 TTL；允许保温仍需兼容传输、缓存证据、对话开关和收益检查。',
        limit: '最多保存 100 条自定义规则；模型目录不受此限制。',
        invalid: '规则需使用精确的提供商/模型 ID，有效期为 1–10080 的整数分钟或空白；最多 100 条且不能重复。',
      } : {
        description: 'Warming sends small background requests to try to preserve an existing prompt cache. It consumes API or subscription usage, and runs only when the expected savings justify the cost.',
        defaultEnabled: 'Keep new chats warm by default', active: 'Warming window while running (minutes)', idle: 'Warming window while idle (minutes)',
        defaultHelp: 'Automatically turn on “Keep cache warm” for new regular chats. Existing chats and subagent chats are unchanged. You can turn it off in any chat; the model must also allow warming.',
        activeHelp: 'While the agent is running, allow warming for this many minutes after its last real model request. Set to 0 to disable warming during a run.',
        idleHelp: 'While the agent is idle, allow warming until this many minutes after its last real model request—not after the run ends. Set to 0 to disable idle warming.',
        windowHelp: 'These are time windows, not refresh intervals or cache lifetimes. Refresh timing comes from the model’s lifetime estimate below. Warm requests never extend either window.',
        windowExample: 'Example: with a 30-minute idle window and a last real request at 14:00, warming stops by 14:30—even if the run finishes at 14:10.',
        loadError: 'Could not load settings.', saveError: 'Save failed; unsaved changes are preserved.', save: 'Save', saving: 'Saving …', loading: 'Loading …',
        models: 'Model cache policies', search: 'Search models or providers', provider: 'Provider', all: 'All providers', refresh: 'Refresh models', retry: 'Retry', more: 'Load more',
        modelError: 'Model discovery failed for this provider. Overrides are preserved.', timeout: 'Model discovery timed out for this provider. Overrides are preserved.',
        providerError: 'Provider discovery failed. Overrides are preserved; retry to load models.', empty: 'No matching models.', unavailable: 'Unavailable in catalog',
        allow: 'Allow warming', lifetime: 'Estimated cache lifetime (minutes)', unknown: 'Unknown', custom: 'Custom', estimated: 'Codex estimated default',
        blank: 'Blank — no automatic warming', disabled: 'Disabled (lifetime retained)', legacy: 'Defaults disabled by legacy settings', reset: 'Reset to default', remove: 'Remove override',
        assumption: 'Known Codex estimates apply automatically. Lifetimes are local scheduling assumptions, not provider TTL settings. Blank blocks automatic warming; the toggle temporarily disables it while retaining the lifetime.',
        discovery: 'Models come from Harness configured providers. The catalog does not verify credentials or actual cache TTL. Allowing warming still requires a compatible transport, cache evidence, chat consent and the savings check.',
        limit: 'Save up to 100 overrides; the model catalog has no such limit.',
        invalid: 'Rules require exact provider/model IDs, integer minutes from 1–10080 or blank; maximum 100 overrides with no duplicates.',
      };
      const reasons = zh ? {
        'unsupported-model': '此模型无兼容传输', 'unsupported-protocol': '协议不受支持', 'unknown-pricing': '价格未知',
        'unsupported-route': '线路不受支持', 'unsupported-capability': '缺少所需能力', 'catalog-unavailable': '能力目录不可用',
        'retention-disabled': '缓存保留已停用', 'unsupported-provider': '提供商不受支持', 'route-unavailable': '线路不可用',
      } : {
        'unsupported-model': 'No compatible model transport', 'unsupported-protocol': 'Unsupported protocol', 'unknown-pricing': 'Pricing unknown',
        'unsupported-route': 'Unsupported route', 'unsupported-capability': 'Required capability unavailable', 'catalog-unavailable': 'Capability catalog unavailable',
        'retention-disabled': 'Cache retention disabled', 'unsupported-provider': 'Unsupported provider', 'route-unavailable': 'Route unavailable',
      };
      React.useEffect(() => {
        let active = true;
        const controller = new AbortController();
        setError('');
        fetch(`${route}?scope=settings`, { credentials: 'include', signal: controller.signal })
          .then(response => { if (!response.ok) throw new Error('settings'); return response.json(); })
          .then(value => { if (active) { const settings = editable(value); setValues(settings); setDraft(settings); } })
          .catch(() => { if (active) setError('load'); });
        return () => { active = false; controller.abort(); };
      }, [settingsRequest]);
      React.useEffect(() => {
        let active = true;
        const controller = new AbortController();
        setModelsLoading(true);
        fetch(`${route}?scope=models`, { credentials: 'include', signal: controller.signal })
          .then(response => { if (!response.ok) throw new Error('models'); return response.json(); })
          .then(value => {
            if (!value || !Array.isArray(value.providers)) throw new Error('models');
            if (active) setCatalog(value);
          })
          .catch(() => { if (active) setCatalog({ providers: [], error: 'provider-discovery-failed' }); })
          .finally(() => { if (active) setModelsLoading(false); });
        return () => { active = false; controller.abort(); };
      }, [modelsRequest]);
      React.useEffect(() => {
        const api = ctx.locale;
        if (!api || typeof api.subscribe !== 'function') return undefined;
        return api.subscribe(() => setLocale(getLocale(ctx)));
      }, []);
      const set = (name, value) => setDraft(previous => ({ ...previous, [name]: value }));
      const rows = draft?.modelPolicies || [];
      const pair = row => JSON.stringify([row.provider, row.model]);
      const overrides = new Map(rows.map(row => [pair(row), row]));
      const validMinutes = n => n === null || (Number.isInteger(n) && n >= 1 && n <= 10080);
      const validRows = rows.length <= 100 && overrides.size === rows.length && rows.every(row =>
        typeof row.provider === 'string' && row.provider.length <= 128 && /^[A-Za-z0-9_.-]+$/.test(row.provider)
        && typeof row.model === 'string' && row.model.length > 0 && row.model.length <= 256 && row.model === row.model.trim()
        && !/[*?\[\]{}]/.test(row.model) && typeof row.enabled === 'boolean' && validMinutes(row.cacheMinutes));
      const valid = draft && validRows && Number.isInteger(draft.activeMinutes) && draft.activeMinutes >= 0 && draft.activeMinutes <= 1440
        && Number.isInteger(draft.idleMinutes) && draft.idleMinutes >= 0 && draft.idleMinutes <= 1440;
      const save = async () => {
        if (!valid || busy) return;
        setBusy(true); setError('');
        try {
          const response = await fetch(route, { method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'settings', ...editable(draft) }) });
          if (!response.ok) throw new Error('save');
          const settings = editable(await response.json());
          setDraft(settings); setValues(settings);
        } catch { setError('save'); }
        finally { setBusy(false); }
      };
      // Merge saved/unsaved overrides into the display, never into the discovered catalog.
      const groups = new Map();
      const known = new Set();
      for (const provider of catalog.providers) {
        const group = { id: provider.id, name: provider.name || provider.id, error: provider.error, models: [] };
        groups.set(provider.id, group);
        for (const model of provider.models || []) {
          const row = { ...model, provider: provider.id, model: model.id, available: true };
          if (!known.has(pair(row))) { group.models.push(row); known.add(pair(row)); }
        }
      }
      for (const override of rows) {
        if (known.has(pair(override))) continue;
        if (!groups.has(override.provider)) groups.set(override.provider, { id: override.provider, name: override.provider, models: [] });
        groups.get(override.provider).models.push({ provider: override.provider, model: override.model, name: override.model,
          defaultCacheMinutes: null, transportSupported: false, available: false });
        known.add(pair(override));
      }
      const allGroups = [...groups.values()];
      const needle = search.trim().toLocaleLowerCase();
      let remaining = limit;
      const filtered = allGroups.filter(group => !providerFilter || group.id === providerFilter).map(group => {
        const matches = group.models.filter(model => `${group.id} ${group.name} ${model.model} ${model.name}`.toLocaleLowerCase().includes(needle));
        const visible = matches.slice(0, remaining);
        remaining -= visible.length;
        return { ...group, matches, visible };
      });
      const total = allGroups.reduce((n, group) => n + group.models.length, 0);
      const matched = filtered.reduce((n, group) => n + group.matches.length, 0);
      const displayed = Math.min(limit, matched);
      const effective = model => overrides.get(pair(model)) || {
        provider: model.provider, model: model.model,
        enabled: draft?.useCodexDefaults !== false && model.defaultCacheMinutes != null,
        cacheMinutes: draft?.useCodexDefaults !== false ? model.defaultCacheMinutes : null,
      };
      const updateModel = (model, patch) => {
        if (!draft || busy) return;
        const key = pair(model);
        setDraft(previous => {
          const old = previous.modelPolicies.find(row => pair(row) === key);
          if (!old && previous.modelPolicies.length >= 100) return previous;
          const next = { ...(old || effective(model)), ...patch };
          return { ...previous, modelPolicies: old ? previous.modelPolicies.map(row => pair(row) === key ? next : row) : [...previous.modelPolicies, next] };
        });
      };
      const removeModel = model => setDraft(previous => ({ ...previous, modelPolicies: previous.modelPolicies.filter(row => pair(row) !== pair(model)) }));
      const resetModel = model => {
        if (draft.useCodexDefaults === false && model.defaultCacheMinutes != null) updateModel(model, { enabled: true, cacheMinutes: model.defaultCacheMinutes });
        else removeModel(model);
      };
      const button = (label, onClick, disabled = false, ariaLabel = label) => h('button', {
        type: 'button', className: 'dsh-cache-policy-button', disabled, onClick, 'aria-label': ariaLabel,
      }, label);
      const settingText = (key, title, help) => h('span', { className: 'dsh-cache-settings-copy' },
        h('span', { className: 'dsh-cache-settings-label' }, title),
        h('span', { className: 'dsh-cache-settings-help', id: `${helpId}-${key}` }, help));
      const field = (key, title, help) => h('label', { className: 'dsh-cache-settings-row' },
        settingText(key, title, help), h('input', { type: 'number', min: 0, max: 1440, step: 1,
          className: 'dsh-cache-settings-input', disabled: busy, value: draft[key], 'aria-label': title,
          'aria-describedby': `${helpId}-${key}`,
          onChange: event => set(key, event.target.value === '' ? '' : Number(event.target.value)),
        }));
      const renderModel = model => {
        const row = effective(model);
        const custom = overrides.has(pair(model));
        const locked = busy || !draft || (!custom && rows.length >= 100);
        const identity = `${model.provider}/${model.model}`;
        const status = row.cacheMinutes == null ? t.blank : custom ? t.custom : t.estimated;
        return h('div', { className: 'dsh-cache-policy-card', key: pair(model), 'data-model': identity },
          h('strong', null, model.name || model.model),
          model.name !== model.model && h('div', { className: 'dsh-cache-policy-id' }, model.model),
          h('div', { className: 'dsh-cache-policy-status' }, `${status}${!row.enabled && row.cacheMinutes != null ? ` · ${t.disabled}` : ''}`),
          !custom && draft?.useCodexDefaults === false && model.defaultCacheMinutes != null && h('div', { className: 'dsh-cache-policy-status' }, t.legacy),
          !model.available ? h('div', { className: 'dsh-cache-policy-status' }, t.unavailable)
            : !model.transportSupported && h('div', { className: 'dsh-cache-policy-status' }, `${zh ? '仅供观察' : 'Observation only'} · ${reasons[model.reasonCode] || (zh ? '保温传输不受支持' : 'Warming transport unsupported')}`),
          h('label', { className: 'dsh-cache-policy-lifetime' }, h('span', null, t.lifetime),
            h('input', { className: 'dsh-cache-settings-input dsh-cache-policy-minutes', type: 'number', min: 1, max: 10080, step: 1,
              'aria-label': `${t.lifetime} ${identity}`, value: row.cacheMinutes ?? '', placeholder: t.unknown, disabled: locked,
              onChange: event => updateModel(model, { cacheMinutes: event.target.value === '' ? null : Number(event.target.value) }) })),
          h('div', { className: 'dsh-cache-policy-actions' },
            h('label', { className: 'dsh-cache-policy-toggle' }, h('span', null, t.allow),
              h('button', { type: 'button', role: 'switch', className: 'dsh-cache-settings-switch',
                'aria-checked': row.enabled, disabled: locked, 'aria-label': `${t.allow} ${identity}`,
                onClick: () => updateModel(model, { enabled: !row.enabled }) },
              h('span', { className: 'dsh-cache-settings-thumb', 'aria-hidden': true }))),
            model.available ? button(t.reset, () => resetModel(model), busy || !draft || (!custom && !(draft.useCodexDefaults === false && model.defaultCacheMinutes != null && rows.length < 100)), `${t.reset} ${identity}`)
              : button(t.remove, () => removeModel(model), busy || !draft, `${t.remove} ${identity}`)));
      };
      return h('section', { className: 'dsh-cache-settings' },
        h('p', { className: 'dsh-cache-settings-description' }, t.description),
        draft ? h(React.Fragment, null,
          h('label', { className: 'dsh-cache-settings-row' }, settingText('autoWarmNewChats', t.defaultEnabled, t.defaultHelp),
            h('button', { type: 'button', role: 'switch', className: 'dsh-cache-settings-switch',
              'aria-checked': draft.autoWarmNewChats, 'aria-label': t.defaultEnabled, disabled: busy,
              'aria-describedby': `${helpId}-autoWarmNewChats`,
              onClick: () => set('autoWarmNewChats', !draft.autoWarmNewChats) }, h('span', { className: 'dsh-cache-settings-thumb', 'aria-hidden': true }))),
          field('activeMinutes', t.active, t.activeHelp), field('idleMinutes', t.idle, t.idleHelp),
          h('div', { className: 'dsh-cache-settings-window-note' },
            h('p', null, t.windowHelp), h('p', null, t.windowExample)))
          : h('div', { className: 'dsh-cache-policy-note', role: error === 'load' ? 'alert' : 'status' }, error === 'load' ? t.loadError : t.loading,
            error === 'load' && button(t.retry, () => setSettingsRequest(n => n + 1))),
        h('section', { className: 'dsh-cache-policy-section', 'aria-label': t.models },
          h('div', { className: 'dsh-cache-policy-actions' }, h('h3', null, t.models),
            button(t.refresh, () => setModelsRequest(n => n + 1), modelsLoading)),
          h('p', { className: 'dsh-cache-policy-note' }, t.assumption),
          h('p', { className: 'dsh-cache-policy-note' }, t.discovery),
          h('div', { className: 'dsh-cache-policy-grid' },
            h('label', { className: 'dsh-cache-policy-field' }, h('span', null, t.search),
              h('input', { type: 'search', className: 'dsh-cache-policy-input', value: search, 'aria-label': t.search,
                onChange: event => { setSearch(event.target.value); setLimit(25); } })),
            h('label', { className: 'dsh-cache-policy-field' }, h('span', null, t.provider),
              h('select', { className: 'dsh-cache-policy-input', value: providerFilter, 'aria-label': t.provider,
                onChange: event => { setProviderFilter(event.target.value); setLimit(25); } },
              h('option', { value: '' }, t.all), allGroups.map(group => h('option', { key: group.id, value: group.id }, `${group.name} (${group.models.length})`))))),
          modelsLoading && h('p', { className: 'dsh-cache-policy-note', role: 'status' }, t.loading),
          catalog.error && h('p', { className: 'dsh-cache-settings-error', role: 'alert' }, t.providerError,
            button(t.retry, () => setModelsRequest(n => n + 1), modelsLoading)),
          h('p', { className: 'dsh-cache-policy-note', role: 'status' }, zh ? `显示 ${displayed} / ${matched} 个匹配模型，共 ${total} 个；自定义 ${rows.length} / 100`
            : `Showing ${displayed} of ${matched} matching models · ${total} total · ${rows.length}/100 overrides`),
          h('div', { className: 'dsh-cache-policy-list', tabIndex: 0, 'aria-label': t.models },
          filtered.map(group => (group.visible.length || group.error) && h('section', { key: group.id, className: 'dsh-cache-policy-group', 'aria-label': group.name },
            h('h4', null, `${group.name} (${group.matches.length}/${group.models.length})`),
            group.name !== group.id && h('div', { className: 'dsh-cache-policy-id' }, group.id),
            group.error && h('p', { className: 'dsh-cache-settings-error', role: 'alert' }, group.error === 'model-discovery-timeout' ? t.timeout : t.modelError,
              button(t.retry, () => setModelsRequest(n => n + 1), modelsLoading, `${t.retry} ${group.name}`)),
            group.visible.map(renderModel)))),
          !modelsLoading && !matched && h('p', { className: 'dsh-cache-policy-note' }, t.empty),
          displayed < matched && button(t.more, () => setLimit(n => n + 25)),
          rows.length >= 100 && h('p', { className: 'dsh-cache-policy-note' }, t.limit),
          !validRows && h('p', { role: 'alert', className: 'dsh-cache-settings-error' }, t.invalid)),
        draft && h('div', { className: 'dsh-cache-settings-footer' },
          h('button', { type: 'button', className: 'dsh-cache-settings-save',
            disabled: busy || !valid || JSON.stringify(values) === JSON.stringify(draft), onClick: save }, busy ? t.saving : t.save),
          error === 'save' && h('span', { role: 'alert', className: 'dsh-cache-settings-error' }, t.saveError)));
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
.dsh-cache-settings-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.dsh-cache-settings-label{min-width:0;font-size:13px;font-weight:500;line-height:20px}
.dsh-cache-settings-help{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);font-weight:400}
.dsh-cache-settings-window-note{margin:12px 0 16px;padding:12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsh-cache-settings-window-note p{margin:0}
.dsh-cache-settings-window-note p+p{margin-top:8px}
.dsh-cache-settings-input{box-sizing:border-box;width:88px;flex:none;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsh-cache-settings-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dsh-cache-policy-section{margin-top:12px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:16px}
.dsh-cache-policy-section summary{cursor:pointer;font-weight:500;line-height:24px}
.dsh-cache-policy-note{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:12px 0;overflow-wrap:anywhere}
.dsh-cache-policy-section h3,.dsh-cache-policy-group h4{margin:0;font:inherit;font-size:14px;line-height:22px;font-weight:500;overflow-wrap:anywhere}
.dsh-cache-policy-group{margin-top:20px;min-width:0}
.dsh-cache-policy-list{max-height:min(60vh,600px);overflow-y:auto;overscroll-behavior:contain;padding:2px;min-width:0}
.dsh-cache-policy-list:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsh-cache-policy-id,.dsh-cache-policy-status{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-cache-policy-card>strong{font-size:14px;line-height:22px;font-weight:500}
.dsh-cache-policy-status{margin:4px 0 8px}
.dsh-cache-policy-card{min-width:0;margin:12px 0;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow-wrap:anywhere}
.dsh-cache-policy-card .dsh-cache-policy-actions{margin-top:12px}
.dsh-cache-policy-lifetime{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0;margin-top:12px;font-size:13px;line-height:20px}
.dsh-cache-policy-lifetime>span{min-width:0}
.dsh-cache-policy-minutes{width:96px;max-width:100%;text-align:right}
.dsh-cache-policy-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin-bottom:12px}
.dsh-cache-policy-field{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:13px;line-height:20px}
.dsh-cache-policy-input{box-sizing:border-box;width:100%;min-width:0;height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary)}
.dsh-cache-policy-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsh-cache-policy-actions,.dsh-cache-policy-toggle{display:flex;align-items:center;gap:12px}
.dsh-cache-policy-actions{justify-content:space-between;flex-wrap:wrap}
.dsh-cache-policy-toggle{cursor:pointer}
.dsh-cache-policy-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsh-cache-policy-button{appearance:none;padding:5px 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;flex-shrink:0}
.dsh-cache-policy-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-cache-policy-button:disabled{opacity:.45;cursor:default}
@media(max-width:480px){.dsh-cache-policy-grid{grid-template-columns:minmax(0,1fr)}.dsh-cache-policy-input,.dsh-cache-settings-input{font-size:16px}}
.dsh-cache-settings-footer{display:flex;align-items:center;gap:8px;padding-top:16px}
.dsh-cache-settings-save{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsh-cache-settings-save:disabled{opacity:.4;cursor:default}
.dsh-cache-settings-save:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsh-cache-settings-error{font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}
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
        }, props => props.view === 'summary' ? null : h(SettingsPage, { ctx })));
      },
    };
  },
});
